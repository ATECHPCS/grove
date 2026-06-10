//! Launching a plugin's node processes (MCP server, backend) under the **Node
//! Permission Model** (`node --permission`).
//!
//! Grove requires node >= 24 — where the model is stable — for any plugin that
//! ships a node process. Older node is refused (the process is not launched) so
//! a declared permission is never silently left unenforced.
//!
//! Permission → flag mapping (everything is enforced by node itself, below the
//! plugin's JS, so it can't be monkey-patched away):
//!   - `storage:read`  → `--allow-fs-read`  of the plugin's data dir (all scopes)
//!   - `storage:write` → `--allow-fs-write` of the plugin's data dir
//!   - `project:read`  → `--allow-fs-read`  of the current task worktree
//!   - `project:write` → `--allow-fs-write` of the current task worktree
//!   - `exec` → `--allow-child-process` (all-or-nothing; the spawned child is
//!     itself unsandboxed → effectively full trust)
//!
//! Network is intentionally absent: Node's model has no `--allow-net`, so a
//! `network` permission could not be enforced and Grove does not pretend it can.

use std::collections::HashSet;
use std::path::Path;

/// Minimum Node major version with a stable Permission Model.
pub const MIN_NODE_MAJOR: u32 = 24;

/// True if a command's basename is the node runtime (`node` / `node.exe`).
pub fn is_node_command(command: &str) -> bool {
    Path::new(command)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("node"))
        .unwrap_or(false)
}

/// Detect the major version of a node command (on PATH or absolute). Returns
/// None if node isn't found or `--version` can't be parsed.
pub fn node_major_version(command: &str) -> Option<u32> {
    let out = std::process::Command::new(command)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // e.g. "v24.1.0" → 24
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// Whether this node command satisfies Grove's minimum for running plugin
/// processes under enforced permissions.
pub fn node_supports_permissions(command: &str) -> bool {
    node_major_version(command).is_some_and(|v| v >= MIN_NODE_MAJOR)
}

/// Grant a directory path for an fs flag: both the dir entry itself and its
/// contents (node's trailing-`*` is a recursive prefix match).
fn grant(kind: &str, dir: &str, out: &mut Vec<String>) {
    out.push(format!("--allow-fs-{}={}", kind, dir));
    out.push(format!(
        "--allow-fs-{}={}{}*",
        kind,
        dir,
        std::path::MAIN_SEPARATOR
    ));
}

/// Build the `--permission …` flags for a node process, granting fs/exec scopes
/// exactly matching the plugin's declared permissions.
///
/// - `install_dir` is always granted read (node must load the plugin's own
///   code / node_modules to start).
/// - `storage_root` is the plugin's whole data dir (covers global/project/task
///   scopes) — granted per `storage:read` / `storage:write`.
/// - `project_dir` is the current task worktree (None for app-scoped backends)
///   — granted per `project:read` / `project:write`.
pub fn node_permission_flags(
    perms: &HashSet<String>,
    install_dir: &str,
    storage_root: &str,
    project_dir: Option<&str>,
) -> Vec<String> {
    let mut flags = vec!["--permission".to_string()];
    // Node must read its own code; worker threads inherit the same perms.
    grant("read", install_dir, &mut flags);
    flags.push("--allow-worker".to_string());
    if perms.contains("storage:read") {
        grant("read", storage_root, &mut flags);
    }
    if perms.contains("storage:write") {
        grant("write", storage_root, &mut flags);
    }
    if let Some(proj) = project_dir {
        if perms.contains("project:read") {
            grant("read", proj, &mut flags);
        }
        if perms.contains("project:write") {
            grant("write", proj, &mut flags);
        }
    }
    if perms.contains("exec") {
        flags.push("--allow-child-process".to_string());
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn node_command_detection() {
        assert!(is_node_command("node"));
        assert!(is_node_command("/usr/local/bin/node"));
        assert!(is_node_command("node.exe"));
        assert!(!is_node_command("python"));
        assert!(!is_node_command("/opt/deno"));
    }

    #[test]
    fn flags_always_include_permission_and_own_code() {
        let f = node_permission_flags(&perms(&[]), "/plug", "/data", None);
        assert_eq!(f[0], "--permission");
        assert!(f.iter().any(|x| x.contains("--allow-fs-read=/plug")));
        assert!(f.iter().any(|x| x == "--allow-worker"));
        // No storage/project/exec grants when nothing is declared.
        assert!(!f.iter().any(|x| x.contains("/data")));
        assert!(!f.iter().any(|x| x == "--allow-child-process"));
    }

    #[test]
    fn flags_map_each_permission() {
        let f = node_permission_flags(
            &perms(&["storage:read", "storage:write", "project:read", "exec"]),
            "/plug",
            "/data",
            Some("/work"),
        );
        assert!(f.iter().any(|x| x.contains("--allow-fs-read=/data")));
        assert!(f.iter().any(|x| x.contains("--allow-fs-write=/data")));
        assert!(f.iter().any(|x| x.contains("--allow-fs-read=/work")));
        assert!(!f.iter().any(|x| x.contains("--allow-fs-write=/work")));
        assert!(f.iter().any(|x| x == "--allow-child-process"));
    }
}
