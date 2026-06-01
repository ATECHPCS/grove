//! Groove dashboard snapshot — a privacy-safe overview of projects, agents,
//! token usage, and recent activity, served (5s-cached) at GET /api/v1/dashboard
//! and rendered by the standalone status board. Built from local SQLite + the
//! live ACP session registry; never includes paths, branches, or prompts.

use chrono::Utc;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::path::Path;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use crate::error::Result;

/// Snapshot cache lifetime. Short so the office reacts to real work within a
/// poll or two; the underlying query is cheap (one aggregate + a project walk).
const CACHE_TTL: Duration = Duration::from_secs(1);

/// An agent counts as "Active" if it wrote a token-usage row within this many
/// seconds. Wide enough to bridge gaps between turns (so a working agent doesn't
/// flicker), tight enough that it settles to Idle shortly after work stops.
const ACTIVE_WINDOW_SECS: i64 = 60;

static SNAPSHOT_CACHE: Lazy<SnapshotCache> = Lazy::new(|| SnapshotCache::new(CACHE_TTL));

#[derive(Debug, Clone, Serialize)]
pub struct GrooveDashboardSnapshot {
    pub generated_at: i64,
    pub totals: GrooveDashboardTotals,
    pub projects: Vec<GrooveDashboardProject>,
    pub activity: Vec<GrooveDashboardActivity>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrooveDashboardTotals {
    pub total_projects: usize,
    pub active_sessions: usize,
    pub total_sessions: usize,
    pub tokens_total: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrooveDashboardProject {
    pub id: String,
    pub name: String,
    pub project_type: String,
    pub status: ProjectDisplayStatus,
    pub tokens_total: u64,
    pub agents: Vec<GrooveDashboardAgent>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectDisplayStatus {
    Active,
    Idle,
    Empty,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrooveDashboardAgent {
    pub id: String,
    pub agent: String,
    pub label: String,
    pub state: AgentDisplayState,
    pub session_uptime_secs: i64,
    pub tokens_total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentDisplayState {
    Active,
    Idle,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrooveDashboardActivity {
    pub id: String,
    pub project_id: String,
    pub agent: String,
    pub label: String,
    pub occurred_at: i64,
    pub ambient: bool,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    inserted_at: Instant,
    snapshot: GrooveDashboardSnapshot,
}

#[derive(Debug)]
pub struct SnapshotCache {
    ttl: Duration,
    entry: RwLock<Option<CacheEntry>>,
}

impl SnapshotCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entry: RwLock::new(None),
        }
    }

    pub fn get_or_refresh<F>(&self, refresh: F) -> Result<GrooveDashboardSnapshot>
    where
        F: FnOnce() -> Result<GrooveDashboardSnapshot>,
    {
        if let Ok(guard) = self.entry.read() {
            if let Some(entry) = guard.as_ref() {
                if entry.inserted_at.elapsed() < self.ttl {
                    return Ok(entry.snapshot.clone());
                }
            }
        }

        let snapshot = refresh()?;
        if let Ok(mut guard) = self.entry.write() {
            *guard = Some(CacheEntry {
                inserted_at: Instant::now(),
                snapshot: snapshot.clone(),
            });
        }
        Ok(snapshot)
    }
}

pub fn load_snapshot_cached() -> Result<GrooveDashboardSnapshot> {
    SNAPSHOT_CACHE.get_or_refresh(load_snapshot_uncached)
}

pub fn friendly_project_name(name: &str, path: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    Path::new(path)
        .file_name()
        .and_then(|part| part.to_str())
        .filter(|part| !part.trim().is_empty())
        .map(|part| part.to_string())
        .unwrap_or_else(|| "Untitled Project".to_string())
}

fn now_ts() -> i64 {
    Utc::now().timestamp()
}

/// Display name for an agent id ("claude" -> "Claude").
fn agent_label(agent: &str) -> String {
    match agent {
        "claude" => "Claude".to_string(),
        "codex" => "Codex".to_string(),
        "gemini" => "Gemini".to_string(),
        "copilot" => "Copilot".to_string(),
        "qwen" => "Qwen".to_string(),
        "kimi" => "Kimi".to_string(),
        "opencode" => "OpenCode".to_string(),
        "cursor" => "Cursor".to_string(),
        "junie" => "Junie".to_string(),
        "trae" => "Trae".to_string(),
        other => {
            let mut c = other.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => "Agent".to_string(),
            }
        }
    }
}

/// Compact token count for activity labels (1234 -> "1.2k").
fn fmt_count(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

#[derive(Default, Clone)]
struct TokenAgg {
    total: u64,
    input: u64,
    output: u64,
    last_ts: i64,
}

/// Gather a fresh snapshot from local SQLite + the live ACP session registry.
/// Privacy-safe by construction: only friendly project names, agent ids,
/// session titles, token counts, and timestamps — never paths/branches/prompts.
pub fn load_snapshot_uncached() -> Result<GrooveDashboardSnapshot> {
    use crate::storage::{tasks, workspace};
    use std::collections::HashMap;

    let now = now_ts();

    // One pass over the token-usage table → per-chat aggregates. Cheap, and
    // avoids a per-session query. The connection guard is dropped before we
    // call into storage helpers that take their own guard (the DB is a single
    // global mutex — nesting guards would deadlock).
    let tok: HashMap<String, TokenAgg> = {
        let conn = crate::storage::database::connection();
        query_token_aggs(&conn)
    };

    // Walk projects → tasks → sessions, joining the token map in memory.
    let mut projects = Vec::new();
    for project in workspace::load_projects().unwrap_or_default() {
        let project_id = workspace::project_hash(&project.path);
        let mut agents = Vec::new();
        let mut project_tokens = 0u64;

        for task in tasks::load_tasks(&project_id).unwrap_or_default() {
            for chat in tasks::load_chat_sessions(&project_id, &task.id).unwrap_or_default() {
                let agg = tok.get(&chat.id).cloned().unwrap_or_default();
                project_tokens += agg.total;

                // Liveness reading. Two independent signals, so the board reflects
                // *real* work regardless of which process is driving the agent:
                //   1. ACP `is_busy` — accurate, but only for sessions THIS web
                //      server spawned (the in-memory registry).
                //   2. Token recency — any agent that wrote a token-usage row in
                //      the last ACTIVE_WINDOW_SECS is actively burning tokens,
                //      no matter where it was launched (TUI, GUI, another host).
                // The window bridges the gaps between per-turn token writes so a
                // working agent stays "Active" smoothly instead of flickering.
                let session_key = format!("{}:{}:{}", project_id, task.id, chat.id);
                let recently_active = agg.last_ts > 0 && (now - agg.last_ts) <= ACTIVE_WINDOW_SECS;
                let acp = crate::acp::get_session_handle(&session_key);
                let acp_busy = acp
                    .as_ref()
                    .map(|h| h.is_busy.load(std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(false);
                let state = if acp_busy || recently_active {
                    AgentDisplayState::Active
                } else if acp.is_some() || agg.last_ts > 0 {
                    // Connected (just not busy) or has token history but quiet →
                    // present-and-seated, not a ghost.
                    AgentDisplayState::Idle
                } else {
                    // No live handle and never any token activity.
                    AgentDisplayState::Unknown
                };

                agents.push(GrooveDashboardAgent {
                    id: chat.id.clone(),
                    agent: chat.agent.clone(),
                    // Non-sensitive role label, NOT the chat title — titles are
                    // user/agent text (filenames, customer names, prompt gist)
                    // and this snapshot is built for a shared/public board.
                    label: chat
                        .duty
                        .clone()
                        .filter(|d| !d.trim().is_empty())
                        .unwrap_or_else(|| "session".to_string()),
                    state,
                    session_uptime_secs: (now - chat.created_at.timestamp()).max(0),
                    tokens_total: agg.total,
                    last_activity_at: (agg.last_ts > 0).then_some(agg.last_ts),
                });
            }
        }

        let status = if agents.is_empty() {
            ProjectDisplayStatus::Empty
        } else if agents.iter().any(|a| a.state == AgentDisplayState::Active) {
            ProjectDisplayStatus::Active
        } else {
            ProjectDisplayStatus::Idle
        };

        projects.push(GrooveDashboardProject {
            id: project_id,
            name: friendly_project_name(&project.name, &project.path),
            project_type: project.project_type.as_str().to_string(),
            status,
            tokens_total: project_tokens,
            agents,
        });
    }

    // Active projects first, then by token spend descending.
    projects.sort_by(|a, b| {
        let rank = |s: &ProjectDisplayStatus| match s {
            ProjectDisplayStatus::Active => 0,
            ProjectDisplayStatus::Idle => 1,
            ProjectDisplayStatus::Empty => 2,
        };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then(b.tokens_total.cmp(&a.tokens_total))
    });

    let total_projects = projects.len();
    let total_sessions: usize = projects.iter().map(|p| p.agents.len()).sum();
    let active_sessions: usize = projects
        .iter()
        .flat_map(|p| &p.agents)
        .filter(|a| a.state == AgentDisplayState::Active)
        .count();
    let tokens_total: u64 = tok.values().map(|t| t.total).sum();
    let tokens_in: u64 = tok.values().map(|t| t.input).sum();
    let tokens_out: u64 = tok.values().map(|t| t.output).sum();

    // Recent activity from the most recent token-usage rows (cheap, friendly).
    let activity = {
        let conn = crate::storage::database::connection();
        query_recent_activity(&conn)
    };

    Ok(GrooveDashboardSnapshot {
        generated_at: now,
        totals: GrooveDashboardTotals {
            total_projects,
            active_sessions,
            total_sessions,
            tokens_total,
            tokens_in,
            tokens_out,
        },
        projects,
        activity,
    })
}

/// Per-chat token aggregates in one query. Takes `&Connection` so the prepared
/// statement's borrow stays contained (avoids guard/Statement drop-order pain).
fn query_token_aggs(conn: &rusqlite::Connection) -> std::collections::HashMap<String, TokenAgg> {
    let mut map = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT chat_id, \
            COALESCE(SUM(total_tokens), 0), \
            COALESCE(SUM(input_tokens), 0), \
            COALESCE(SUM(output_tokens), 0), \
            COALESCE(MAX(end_ts), 0) \
         FROM chat_token_usage GROUP BY chat_id",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?.max(0) as u64,
                r.get::<_, i64>(2)?.max(0) as u64,
                r.get::<_, i64>(3)?.max(0) as u64,
                r.get::<_, i64>(4)?,
            ))
        }) {
            for (chat_id, total, input, output, last_ts) in rows.flatten() {
                map.insert(
                    chat_id,
                    TokenAgg {
                        total,
                        input,
                        output,
                        last_ts,
                    },
                );
            }
        }
    }
    map
}

/// Most recent token-usage rows → a friendly activity feed.
fn query_recent_activity(conn: &rusqlite::Connection) -> Vec<GrooveDashboardActivity> {
    let mut activity = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT project_key, agent, total_tokens, end_ts \
         FROM chat_token_usage ORDER BY end_ts DESC LIMIT 25",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        }) {
            for (i, (project_key, agent, tokens, end_ts)) in rows.flatten().enumerate() {
                activity.push(GrooveDashboardActivity {
                    id: format!("act-{end_ts}-{i}"),
                    project_id: project_key,
                    label: format!("{} used {} tokens", agent_label(&agent), fmt_count(tokens)),
                    agent,
                    occurred_at: end_ts,
                    ambient: false,
                });
            }
        }
    }
    activity
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn friendly_name_never_returns_a_path() {
        assert_eq!(friendly_project_name("Demo", "/secret/work/demo"), "Demo");
        assert_eq!(
            friendly_project_name("", "/secret/work/grove-fork"),
            "grove-fork"
        );
        assert_eq!(
            friendly_project_name("   ", "/secret/work/grove-fork"),
            "grove-fork"
        );
        assert_eq!(friendly_project_name("", ""), "Untitled Project");
    }

    #[test]
    fn snapshot_json_does_not_contain_sensitive_fields() {
        let snapshot = sample_snapshot();
        let json = serde_json::to_string(&snapshot).unwrap();

        assert!(json.contains("Friendly Project"));
        assert!(!json.contains("/secret"));
        assert!(!json.contains("worktree_path"));
        assert!(!json.contains("path"));
        assert!(!json.contains("branch"));
        assert!(!json.contains("prompt"));
        assert!(!json.contains("terminal"));
    }

    #[test]
    fn cache_reuses_snapshot_inside_ttl() {
        let cache = SnapshotCache::new(Duration::from_secs(5));
        let calls = AtomicUsize::new(0);

        let first = cache
            .get_or_refresh(|| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(sample_snapshot_with_generated_at(100))
            })
            .unwrap();
        let second = cache
            .get_or_refresh(|| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(sample_snapshot_with_generated_at(200))
            })
            .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.generated_at, 100);
        assert_eq!(second.generated_at, 100);
    }

    fn sample_snapshot() -> GrooveDashboardSnapshot {
        sample_snapshot_with_generated_at(123)
    }

    fn sample_snapshot_with_generated_at(generated_at: i64) -> GrooveDashboardSnapshot {
        GrooveDashboardSnapshot {
            generated_at,
            totals: GrooveDashboardTotals {
                total_projects: 1,
                active_sessions: 1,
                total_sessions: 1,
                tokens_total: 42,
                tokens_in: 20,
                tokens_out: 22,
            },
            projects: vec![GrooveDashboardProject {
                id: "project-1".to_string(),
                name: "Friendly Project".to_string(),
                project_type: "repo".to_string(),
                status: ProjectDisplayStatus::Active,
                tokens_total: 42,
                agents: vec![GrooveDashboardAgent {
                    id: "chat-1".to_string(),
                    agent: "codex".to_string(),
                    label: "Codex".to_string(),
                    state: AgentDisplayState::Active,
                    session_uptime_secs: 60,
                    tokens_total: 42,
                    last_activity_at: Some(120),
                }],
            }],
            activity: vec![GrooveDashboardActivity {
                id: "activity-1".to_string(),
                project_id: "project-1".to_string(),
                agent: "codex".to_string(),
                label: "Codex used 42 tokens".to_string(),
                occurred_at: 120,
                ambient: false,
            }],
        }
    }
}
