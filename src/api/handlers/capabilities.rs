//! Capabilities API (F3) — advertises Grove's agent types and liveness so the
//! nanobot `file_bug` classifier can route dispatches on real availability
//! instead of hardcoded rules.
//!
//! A failed/timed-out call to this endpoint is nanobot's signal that Grove is
//! down: it then skips the dispatch (falls back / defers) rather than firing a
//! blind dispatch that would fail.
//!
//! Ported from the `feat/board-nanobot` branch (0.12.2) onto the 0.12.8 prod
//! line: per-project `skills`/`routing_rules` came from `storage::project_settings`,
//! which the 0.12.8 storage refactor removed, so those fields are dropped. The
//! preflight only requires `healthy`; `agent_types` is advisory and `projects`
//! is already served by the dedicated `/api/v1/projects` route (nanobot fetches
//! it there), so it is intentionally left empty here.

use axum::Json;
use serde::Serialize;

use crate::storage::{custom_agent, installed_agents};

#[derive(Debug, Serialize)]
pub struct ProjectCapability {
    /// Stable project hash (same id used by every other project route).
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct CapabilitiesResponse {
    /// Agent type ids the board can launch: installed ACP agents + custom
    /// personas (the same sources the Board settings `<select>` offers).
    pub agent_types: Vec<String>,
    /// Always empty on the 0.12.8 line — see module docs. Kept for response
    /// shape stability; consumers list projects via `/api/v1/projects`.
    pub projects: Vec<ProjectCapability>,
    /// Trivially true when the endpoint answers — the value is that a
    /// failed/timed-out call tells nanobot Grove is unreachable.
    pub healthy: bool,
    pub version: String,
}

/// GET /api/v1/capabilities
pub async fn get_capabilities() -> Json<CapabilitiesResponse> {
    // Agent types: installed ACP agents first, then custom personas. Both are
    // valid `agent` values on a dispatch request. De-duplicated, order-stable.
    let mut agent_types: Vec<String> = Vec::new();
    if let Ok(installed) = installed_agents::list() {
        for a in installed {
            if !a.hidden && !agent_types.contains(&a.id) {
                agent_types.push(a.id);
            }
        }
    }
    if let Ok(personas) = custom_agent::list() {
        for p in personas {
            if !agent_types.contains(&p.id) {
                agent_types.push(p.id);
            }
        }
    }

    Json(CapabilitiesResponse {
        agent_types,
        projects: Vec::new(),
        healthy: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::database::test_lock as FILE_LOCK_FN;

    struct HomeGuard {
        prev: String,
        temp: std::path::PathBuf,
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            std::env::set_var("HOME", &self.prev);
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }
    fn sandbox_home() -> HomeGuard {
        let prev = std::env::var("HOME").unwrap_or_default();
        let temp = std::env::temp_dir().join(format!(
            "grove-capabilities-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp).unwrap();
        std::env::set_var("HOME", &temp);
        HomeGuard { prev, temp }
    }

    #[tokio::test]
    async fn capabilities_reports_healthy_and_version() {
        let _lock = FILE_LOCK_FN().lock().await;
        let _home = sandbox_home();
        let resp = get_capabilities().await.0;
        assert!(resp.healthy);
        assert_eq!(resp.version, env!("CARGO_PKG_VERSION"));
        // Empty sandbox: no registered projects, but the shape is well-formed.
        assert!(resp.projects.is_empty());
    }
}
