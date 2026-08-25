//! Per-project task defaults: the agent, opening-prompt preamble, task rules,
//! and (nanobot-consumed) routing rules applied when a task is dispatched or
//! started. All fields are optional; an absent row (or empty field) means "no
//! override" — dispatch/start fall back to the global default agent and the
//! hardcoded opening-prompt framing.

use crate::error::Result;
use crate::storage::database::connection;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectSettings {
    /// Default agent id (an installed ACP agent) or Graph persona id, used when
    /// a dispatch/start request doesn't name one. Empty = fall back to the
    /// global default (`config.acp.agent_command`, then `claude-acp`).
    #[serde(default)]
    pub default_agent: String,
    /// Prepended ahead of every dispatched task's opening prompt (kept in front
    /// of the hardcoded "investigate + commit" closing, which always remains).
    #[serde(default)]
    pub prompt_preamble: String,
    /// Injected as a "## Rules" block the agent must follow.
    #[serde(default)]
    pub task_rules: String,
    /// Free-form routing rules read by the nanobot file_bug classifier. Grove
    /// stores and serves them; it does not interpret them itself.
    #[serde(default)]
    pub routing_rules: String,
    /// Default worktree target branch when a dispatch/start request omits one.
    /// Empty = the project's current branch (the existing behavior).
    #[serde(default)]
    pub default_target_branch: String,
}

/// Load settings for a project (keyed by its stable hash). Returns all-empty
/// defaults when no row exists.
pub fn get(project: &str) -> Result<ProjectSettings> {
    let conn = connection();
    let row = conn
        .query_row(
            "SELECT default_agent, prompt_preamble, task_rules, routing_rules, default_target_branch
             FROM project_settings WHERE project = ?1",
            params![project],
            |r| {
                Ok(ProjectSettings {
                    default_agent: r.get(0)?,
                    prompt_preamble: r.get(1)?,
                    task_rules: r.get(2)?,
                    routing_rules: r.get(3)?,
                    default_target_branch: r.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or_default())
}

/// Upsert settings for a project.
pub fn upsert(project: &str, s: &ProjectSettings) -> Result<()> {
    let conn = connection();
    conn.execute(
        "INSERT INTO project_settings
            (project, default_agent, prompt_preamble, task_rules, routing_rules, default_target_branch, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project) DO UPDATE SET
            default_agent         = excluded.default_agent,
            prompt_preamble       = excluded.prompt_preamble,
            task_rules            = excluded.task_rules,
            routing_rules         = excluded.routing_rules,
            default_target_branch = excluded.default_target_branch,
            updated_at            = excluded.updated_at",
        params![
            project,
            s.default_agent,
            s.prompt_preamble,
            s.task_rules,
            s.routing_rules,
            s.default_target_branch,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}
