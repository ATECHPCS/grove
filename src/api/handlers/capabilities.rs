//! Capabilities API (F3) — advertises Grove's agent types, per-project skills
//! and routing rules, and liveness so the nanobot `file_bug` classifier can
//! route dispatches on real availability instead of hardcoded rules.
//!
//! A failed/timed-out call to this endpoint is nanobot's signal that Grove is
//! down: it then skips the dispatch (falls back / defers) rather than firing a
//! blind `POST /tasks/dispatch` that would fail.

use axum::Json;
use serde::Serialize;

use crate::storage::{custom_agent, installed_agents, project_settings, skills, workspace};

#[derive(Debug, Serialize)]
pub struct ProjectCapability {
    /// Stable project hash (same id used by every other project route).
    pub id: String,
    pub name: String,
    /// Skill names installed for this project (project-scope installs).
    pub skills: Vec<String>,
    /// Free-form routing hints the classifier interprets; Grove only stores them.
    pub routing_rules: String,
}

#[derive(Debug, Serialize)]
pub struct CapabilitiesResponse {
    /// Agent type ids the board can launch: installed ACP agents + custom
    /// personas (the same sources the Board settings `<select>` offers).
    pub agent_types: Vec<String>,
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

    // Per-project skills + routing rules, keyed by the same project hash the
    // dispatch route expects. Installed-skills manifest is loaded once and
    // matched to each project by absolute path.
    let installed_skills = skills::load_installed();
    let projects = workspace::load_active_projects()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let id = workspace::project_hash(&p.path);
            let routing_rules = project_settings::get(&id)
                .map(|s| s.routing_rules)
                .unwrap_or_default();
            let mut skill_names: Vec<String> = installed_skills
                .installed
                .iter()
                .filter(|s| {
                    s.project_installs
                        .iter()
                        .any(|pi| pi.project_path == p.path)
                })
                .map(|s| s.skill_name.clone())
                .collect();
            skill_names.sort();
            skill_names.dedup();
            ProjectCapability {
                id,
                name: p.name,
                skills: skill_names,
                routing_rules,
            }
        })
        .collect();

    Json(CapabilitiesResponse {
        agent_types,
        projects,
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
