use chrono::Utc;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::path::Path;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use crate::error::Result;

const CACHE_TTL: Duration = Duration::from_secs(5);

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

pub fn load_snapshot_uncached() -> Result<GrooveDashboardSnapshot> {
    Ok(GrooveDashboardSnapshot {
        generated_at: now_ts(),
        totals: GrooveDashboardTotals {
            total_projects: 0,
            active_sessions: 0,
            total_sessions: 0,
            tokens_total: 0,
            tokens_in: 0,
            tokens_out: 0,
        },
        projects: Vec::new(),
        activity: Vec::new(),
    })
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
