//! Shared utilities for API handlers.

use axum::http::StatusCode;

use crate::model;
use crate::storage::workspace;

use super::projects::TaskResponse;

/// Convert [`model::WorktreeStatus`] to the string the frontend expects.
pub(crate) fn status_to_string(status: &model::WorktreeStatus) -> &'static str {
    match status {
        model::WorktreeStatus::Live => "live",
        model::WorktreeStatus::Idle => "idle",
        model::WorktreeStatus::Merged => "merged",
        model::WorktreeStatus::Conflict => "conflict",
        model::WorktreeStatus::Broken => "broken",
        model::WorktreeStatus::Error => "broken",
        model::WorktreeStatus::Archived => "archived",
    }
}

/// Convert [`model::Worktree`] to [`TaskResponse`].
pub(crate) fn worktree_to_response(wt: &model::Worktree) -> TaskResponse {
    TaskResponse {
        id: wt.id.clone(),
        name: wt.task_name.clone(),
        branch: wt.branch.clone(),
        target: wt.target.clone(),
        status: status_to_string(&wt.status).to_string(),
        additions: 0,
        deletions: 0,
        files_changed: 0,
        initial_commit: None,
        commits: Vec::new(),
        created_at: wt.created_at.to_rfc3339(),
        updated_at: wt.updated_at.to_rfc3339(),
        path: wt.path.clone(),
        multiplexer: wt.multiplexer.clone(),
        created_by: wt.created_by.clone(),
        is_local: wt.is_local,
        board_column: wt.board_column.clone(),
        board_order: wt.board_order,
        origin_key: wt.origin_key.clone(),
        origin_ref: wt.origin_ref.clone(),
    }
}

/// Find project by ID (hash) and return (project, project_key).
pub(crate) fn find_project_by_id(
    id: &str,
) -> Result<(workspace::RegisteredProject, String), StatusCode> {
    let project = workspace::load_project_by_hash(id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_key = workspace::project_hash(&project.path);
    Ok((project, project_key))
}
