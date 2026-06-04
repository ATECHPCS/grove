//! `contributes.backend` — a plugin's private node backend process that its
//! panel talks to over Grove-mediated JSON-RPC (newline-delimited, over stdio).
//! Independent of `contributes.mcp` (which serves the AI agent): a plugin may
//! ship either, both, or neither.
//!
//! Two-hop transport:
//! ```text
//!   panel iframe ─postMessage→ Grove web host ─HTTP→ this manager ─stdio→ node
//! ```
//! `grove.backend.invoke(method, params)` in the panel becomes a
//! `{ id, method, params }` line on the process's stdin; the matching
//! `{ id, result | error }` line on stdout resolves the call.
//!
//! One process per **(plugin, scope key)**: a task panel keys on its task id
//! (the process is launched with that task's project fs access); a sidebar
//! panel keys on `"global"` (no project access). Processes are spawned lazily
//! on first invoke, reused, and reaped on idle or plugin uninstall.
//!
//! The node process runs under the same Node Permission Model as the MCP
//! server (see [`super::runtime`]) — fs/exec grants match the manifest, and
//! node < 24 is refused.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::error::{GroveError, Result};

/// Per-request timeout for a backend invoke.
const INVOKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Reap a backend process after this long with no invoke.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

static BACKENDS: Lazy<RwLock<HashMap<String, Arc<Backend>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Lazily-started idle reaper (forced on first invoke; runs in the tokio rt).
static REAPER: Lazy<()> = Lazy::new(|| {
    tokio::spawn(reaper_loop());
});

struct Backend {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>,
    next_id: AtomicU64,
    last_used: Mutex<Instant>,
}

fn key(plugin_id: &str, scope_key: &str) -> String {
    format!("{}::{}", plugin_id, scope_key)
}

/// Invoke `method` on a plugin's backend, spawning the process if needed.
/// `task` is `Some((project_id, task_id))` for a task panel (the process gets
/// that task's project fs access); `None` for an app-scoped sidebar panel.
pub async fn invoke(
    plugin_id: &str,
    task: Option<(&str, &str)>,
    method: &str,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    // Default 30s; a caller can raise it for a slow op, clamped to [1s, 10min].
    let invoke_timeout = timeout_ms
        .map(|m| Duration::from_millis(m.clamp(1_000, 600_000)))
        .unwrap_or(INVOKE_TIMEOUT);
    Lazy::force(&REAPER);
    let scope_key = task
        .map(|(_, t)| t.to_string())
        .unwrap_or_else(|| "global".to_string());
    let backend = get_or_spawn(plugin_id, task, &scope_key).await?;

    let id = backend.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    backend.pending.lock().await.insert(id, tx);

    let line = json!({ "id": id, "method": method, "params": params }).to_string() + "\n";
    {
        let mut stdin = backend.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| GroveError::session(format!("backend stdin write failed: {}", e)))?;
        stdin.flush().await.ok();
    }
    *backend.last_used.lock().await = Instant::now();

    match tokio::time::timeout(invoke_timeout, rx).await {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(msg))) => Err(GroveError::session(format!("backend error: {}", msg))),
        Ok(Err(_)) => Err(GroveError::session(
            "backend process closed before replying".to_string(),
        )),
        Err(_) => {
            backend.pending.lock().await.remove(&id);
            Err(GroveError::session("backend invoke timed out".to_string()))
        }
    }
}

/// Kill every backend process for a plugin (called on uninstall).
pub async fn shutdown_plugin(plugin_id: &str) {
    let prefix = format!("{}::", plugin_id);
    let mut map = BACKENDS.write().await;
    let keys: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for k in keys {
        if let Some(b) = map.remove(&k) {
            let _ = b.child.lock().await.start_kill();
        }
    }
}

async fn get_or_spawn(
    plugin_id: &str,
    task: Option<(&str, &str)>,
    scope_key: &str,
) -> Result<Arc<Backend>> {
    let k = key(plugin_id, scope_key);
    if let Some(b) = BACKENDS.read().await.get(&k).cloned() {
        return Ok(b);
    }
    let mut map = BACKENDS.write().await;
    if let Some(b) = map.get(&k).cloned() {
        return Ok(b); // lost the race; reuse the winner
    }
    let backend = spawn(plugin_id, task, scope_key).await?;
    map.insert(k, backend.clone());
    Ok(backend)
}

/// Resolved details of the task a backend is scoped to.
struct TaskInfo {
    worktree: String,
    name: String,
    branch: String,
    target: String,
    project_name: String,
    project_path: String,
}

fn resolve_task(project_id: &str, task_id: &str) -> Option<TaskInfo> {
    let projects = crate::storage::workspace::load_projects().ok()?;
    let p = projects
        .iter()
        .find(|p| crate::storage::workspace::project_hash(&p.path) == project_id)?;
    let task = crate::storage::tasks::get_task(project_id, task_id).ok()??;
    Some(TaskInfo {
        worktree: task.worktree_path,
        name: task.name,
        branch: task.branch,
        target: task.target,
        project_name: p.name.clone(),
        project_path: p.path.clone(),
    })
}

async fn spawn(
    plugin_id: &str,
    task: Option<(&str, &str)>,
    scope_key: &str,
) -> Result<Arc<Backend>> {
    let plugin = crate::storage::plugins::get(plugin_id)?
        .ok_or_else(|| GroveError::not_found(format!("plugin not found: {}", plugin_id)))?;

    let manifest_path = std::path::Path::new(&plugin.local_path).join("plugin.json");
    let manifest: Value = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| GroveError::not_found("plugin manifest unreadable".to_string()))?;
    let decl = manifest
        .get("contributes")
        .and_then(|c| c.get("backend"))
        .ok_or_else(|| GroveError::not_found("plugin declares no contributes.backend".to_string()))?;

    // Resolve command/args files relative to the plugin folder (like the MCP path).
    let plugin_dir = std::path::Path::new(&plugin.local_path);
    let resolve = |s: &str| -> String {
        let candidate = plugin_dir.join(s);
        if candidate.is_file() {
            candidate.display().to_string()
        } else {
            s.to_string()
        }
    };
    let command = match decl.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => resolve(c),
        _ => return Err(GroveError::not_found("contributes.backend has no command".to_string())),
    };
    let user_args: Vec<String> = decl
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(resolve).collect())
        .unwrap_or_default();
    let perms: std::collections::HashSet<String> = manifest
        .get("permissions")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let task_info = match task {
        Some((pid, tid)) => resolve_task(pid, tid),
        None => None,
    };
    let project_dir = task_info.as_ref().map(|t| t.worktree.clone());

    let storage_root = crate::storage::plugin_data::data_dir(plugin_id);
    let _ = std::fs::create_dir_all(&storage_root);

    // Node Permission Model gating + flags (same policy as the MCP server).
    let mut args: Vec<String> = Vec::new();
    if super::runtime::is_node_command(&command) {
        if !super::runtime::node_supports_permissions(&command) {
            return Err(GroveError::config(format!(
                "plugin '{}' backend needs node >= {} (check `node --version`)",
                plugin.name,
                super::runtime::MIN_NODE_MAJOR
            )));
        }
        args = super::runtime::node_permission_flags(
            &perms,
            &plugin.local_path,
            &storage_root.display().to_string(),
            project_dir.as_deref(),
        );
    }
    args.extend(user_args);

    let context = build_context(&plugin, task, task_info.as_ref(), &storage_root);

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
        .env("GROVE_CONTEXT", context.to_string())
        // The backend reaches Grove over its own stdout (we own this pipe), so
        // grove.events.emit writes a notification line rather than calling HTTP.
        .env("GROVE_EVENTS_TRANSPORT", "stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Manifest-declared extra env.
    if let Some(env) = decl.get("env").and_then(|v| v.as_object()) {
        for (k, v) in env {
            if let Some(s) = v.as_str() {
                cmd.env(k, s);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| GroveError::session(format!("failed to spawn plugin backend: {}", e)))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| GroveError::session("backend stdin unavailable".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GroveError::session("backend stdout unavailable".to_string()))?;
    let stderr = child.stderr.take();

    let backend = Arc::new(Backend {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        last_used: Mutex::new(Instant::now()),
    });

    tokio::spawn(reader_loop(
        stdout,
        Arc::downgrade(&backend),
        plugin_id.to_string(),
        scope_key.to_string(),
    ));
    if let Some(err) = stderr {
        tokio::spawn(drain_stderr(err, plugin.name.clone()));
    }
    Ok(backend)
}

/// The `GROVE_CONTEXT` blob handed to the backend — the same shape the MCP
/// server gets, so `getGroveContext()` works identically on both.
fn build_context(
    plugin: &crate::storage::plugins::Plugin,
    task: Option<(&str, &str)>,
    info: Option<&TaskInfo>,
    storage_root: &std::path::Path,
) -> Value {
    use crate::storage::plugin_data::{scope_dir, Scope};
    let dir_str = |s: Scope| scope_dir(&plugin.id, &s).ok().map(|p| p.display().to_string());
    let project_id = task.map(|(p, _)| p.to_string());
    let task_id = task.map(|(_, t)| t.to_string());
    let project_type = info.map(|i| {
        if i.worktree.contains("studios") {
            "studio"
        } else {
            "repo"
        }
    });
    json!({
        "projectId": project_id,
        "projectName": info.map(|i| i.project_name.clone()),
        "projectPath": info.map(|i| i.project_path.clone()),
        "projectType": project_type,
        "projectDir": info.map(|i| i.worktree.clone()),
        "taskId": task_id,
        "taskName": info.map(|i| i.name.clone()),
        "branch": info.map(|i| i.branch.clone()),
        "target": info.map(|i| i.target.clone()),
        "pluginDir": plugin.local_path,
        "dataDir": storage_root.display().to_string(),
        "storage": {
            "global": dir_str(Scope::Global),
            "project": project_id.clone().and_then(|p| dir_str(Scope::Project(p))),
            "task": project_id
                .clone()
                .zip(task_id.clone())
                .and_then(|(p, t)| dir_str(Scope::Task(p, t))),
        },
    })
}

/// Read JSON-RPC response lines off stdout and resolve pending invokes. On EOF
/// (process exit/crash) the backend is removed from the registry and all
/// pending calls fail, so the next invoke respawns a fresh process.
async fn reader_loop(stdout: ChildStdout, weak: Weak<Backend>, plugin_id: String, task_id: String) {
    let map_key = key(&plugin_id, &task_id);
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // ignore non-JSON chatter
        };
        // Event push (grove.events.emit on the backend) — fan out to the panel.
        if v.get("type").and_then(|t| t.as_str()) == Some("grove:event") {
            if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                crate::plugins::events::publish(
                    &plugin_id,
                    &task_id,
                    &json!({ "name": name, "data": data }),
                );
            }
            continue;
        }
        let Some(backend) = weak.upgrade() else {
            break;
        };
        if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
            if let Some(tx) = backend.pending.lock().await.remove(&id) {
                let payload = if let Some(err) = v.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("backend error")
                        .to_string();
                    Err(msg)
                } else {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(payload);
            }
        }
        // Notifications (no id) are reserved for a future push channel.
    }
    if let Some(backend) = weak.upgrade() {
        let mut pending = backend.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("backend process exited".to_string()));
        }
    }
    BACKENDS.write().await.remove(&map_key);
}

/// Forward a backend's stderr to Grove's stderr, prefixed with the plugin name.
async fn drain_stderr(stderr: ChildStderr, plugin_name: String) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[plugin:{}] {}", plugin_name, line);
    }
}

async fn reaper_loop() {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let now = Instant::now();
        let mut stale: Vec<String> = Vec::new();
        {
            let map = BACKENDS.read().await;
            for (k, b) in map.iter() {
                if now.duration_since(*b.last_used.lock().await) > IDLE_TIMEOUT {
                    stale.push(k.clone());
                }
            }
        }
        if !stale.is_empty() {
            let mut map = BACKENDS.write().await;
            for k in stale {
                if let Some(b) = map.remove(&k) {
                    // Re-check under the write lock: a backend invoked between the
                    // read and write phases must not be killed mid-RPC (TOCTOU).
                    if now.duration_since(*b.last_used.lock().await) <= IDLE_TIMEOUT {
                        map.insert(k, b);
                        continue;
                    }
                    let _ = b.child.lock().await.start_kill();
                }
            }
        }
    }
}
