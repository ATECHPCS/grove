//! Task CRUD handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};

use std::fs;

use crate::api::error::ApiError;
use crate::git;
use crate::hooks;
use crate::model::loader;
use crate::session::{self, SessionType};
use crate::storage::{self, notes, tasks, workspace};

use super::super::common;
use super::super::projects::{storage_task_to_response, TaskResponse};
use super::types::*;

/// Get git user.name for a task's worktree (used for display purposes in frontend).
pub(crate) fn get_git_user_name(project_key: &str, task_id: &str) -> Option<String> {
    tasks::get_task(project_key, task_id)
        .ok()
        .flatten()
        .and_then(|task| git::git_user_name(&task.worktree_path))
}

/// GET /api/v1/projects/{id}/tasks
pub async fn list_tasks(
    Path(id): Path<String>,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<TaskListResponse>, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;
    let filter = query.filter.as_deref().unwrap_or("active");

    if project.project_type == workspace::ProjectType::Studio {
        let filter_owned = filter.to_string();
        let pk = project_key.clone();
        let mut tasks: Vec<TaskResponse> = tokio::task::spawn_blocking(move || {
            let stored = if filter_owned == "archived" {
                tasks::load_archived_tasks(&pk).unwrap_or_default()
            } else {
                tasks::load_tasks(&pk).unwrap_or_default()
            };
            stored.iter().map(storage_task_to_response).collect()
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        return Ok(Json(TaskListResponse { tasks }));
    }

    let project_path = project.path.clone();
    let filter_owned = filter.to_string();
    let mut tasks: Vec<TaskResponse> = tokio::task::spawn_blocking(move || {
        if filter_owned == "archived" {
            let archived = loader::load_archived_worktrees(&project_path);
            archived.iter().map(common::worktree_to_response).collect()
        } else {
            let active = loader::load_worktrees(&project_path);
            active.iter().map(common::worktree_to_response).collect()
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(Json(TaskListResponse { tasks }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}
pub async fn get_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;

    if project.project_type == workspace::ProjectType::Studio {
        let pk = project_key.clone();
        let tid = task_id.clone();
        let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
            tasks::get_task(&pk, &tid)
                .ok()
                .flatten()
                .or_else(|| tasks::get_archived_task(&pk, &tid).ok().flatten())
                .map(|task| storage_task_to_response(&task))
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return result.map(Json).ok_or(StatusCode::NOT_FOUND);
    }

    let project_path = project.path.clone();
    let tid = task_id.clone();
    let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
        if tid == crate::storage::tasks::LOCAL_TASK_ID {
            return loader::load_local_task(&project_path)
                .map(|wt| common::worktree_to_response(&wt));
        }
        let active = loader::load_worktrees(&project_path);
        if let Some(wt) = active.iter().find(|wt| wt.id == tid) {
            return Some(common::worktree_to_response(wt));
        }
        let archived = loader::load_archived_worktrees(&project_path);
        archived
            .iter()
            .find(|wt| wt.id == tid)
            .map(common::worktree_to_response)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    result.map(Json).ok_or(StatusCode::NOT_FOUND)
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/activate
///
/// Marks a task workspace as actively viewed. Triggered by the frontend
/// when the user enters the task page so the file watcher attaches
/// lazily. Idempotent.
///
/// Studio projects are skipped — their tasks live under
/// `~/.grove/studios/...` and aren't part of the symbol-indexing scope.
/// Coding projects index every active task, **including** the
/// LOCAL_TASK_ID pseudo-task whose worktree is the project root.
pub async fn activate_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;

    if project.project_type == workspace::ProjectType::Studio {
        return Ok(StatusCode::NO_CONTENT);
    }

    let project_path = project.path.clone();
    let tid = task_id.clone();

    let worktree_path: Option<String> = tokio::task::spawn_blocking(move || {
        if tid == crate::storage::tasks::LOCAL_TASK_ID {
            // Local task: worktree IS the project root.
            loader::load_local_task(&project_path).map(|wt| wt.path.clone())
        } else {
            // Worktree-backed task; archived tasks have no on-disk worktree
            // and are filtered by load_worktrees.
            loader::load_worktrees(&project_path)
                .iter()
                .find(|wt| wt.id == tid)
                .map(|wt| wt.path.clone())
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(path) = worktree_path else {
        return Ok(StatusCode::NO_CONTENT);
    };
    if !std::path::Path::new(&path).exists() {
        return Ok(StatusCode::NO_CONTENT);
    }

    crate::api::state::ensure_task_active(&project_key, &task_id, &path);
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/tasks
pub async fn create_task(
    Path(id): Path<String>,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ApiError>)> {
    let (project, project_key) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let full_config = storage::config::load_config();
    let is_studio = project.project_type == workspace::ProjectType::Studio;

    let result = if is_studio {
        crate::operations::tasks::create_studio_task(
            &project.path,
            &project_key,
            req.name.clone(),
            &full_config.default_session_type(),
            "user",
        )
    } else {
        let target = req.target.unwrap_or_else(|| {
            git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string())
        });
        let autolink_patterns = &full_config.auto_link.patterns;

        crate::operations::tasks::create_task(
            &project.path,
            &project_key,
            req.name.clone(),
            target,
            &full_config.default_session_type(),
            autolink_patterns,
            "user",
        )
    }
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("already exists") {
            (StatusCode::CONFLICT, Json(ApiError { error: msg }))
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: msg }),
            )
        }
    })?;

    if let Some(ref notes_content) = req.notes {
        if !notes_content.is_empty() {
            let _ = notes::save_notes(&project_key, &result.task.id, notes_content);
        }
    }

    let _ = crate::storage::taskgroups::ensure_system_groups();
    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    Ok(Json(TaskResponse {
        id: result.task.id.clone(),
        name: result.task.name.clone(),
        branch: result.task.branch.clone(),
        target: result.task.target.clone(),
        status: "idle".to_string(),
        additions: 0,
        deletions: 0,
        files_changed: 0,
        initial_commit: None,
        commits: Vec::new(),
        created_at: result.task.created_at.to_rfc3339(),
        updated_at: result.task.updated_at.to_rfc3339(),
        path: result.worktree_path.clone(),
        multiplexer: result.task.multiplexer.clone(),
        created_by: result.task.created_by.clone(),
        is_local: false,
        board_column: result.task.board_column.clone(),
        board_order: result.task.board_order,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/archive
pub async fn archive_task(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ArchiveConfirmResponse>)> {
    let (project, project_key) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ArchiveConfirmResponse::error(
                "PROJECT_NOT_FOUND",
                "Project not found",
                task_id.clone(),
            )),
        )
    })?;

    let force = query.force.unwrap_or(false);

    if project.project_type == workspace::ProjectType::Studio {
        let task = tasks::get_task(&project_key, &task_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_LOAD_FAILED",
                        "Failed to load task",
                        task_id.clone(),
                    )),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                )
            })?;

        if !force {
            let input_dir = std::path::Path::new(&task.worktree_path).join("input");
            let output_dir = std::path::Path::new(&task.worktree_path).join("output");
            let scripts_dir = std::path::Path::new(&task.worktree_path).join("scripts");
            let has_files = [input_dir, output_dir, scripts_dir].iter().any(|dir| {
                fs::read_dir(dir)
                    .map(|mut it| it.next().is_some())
                    .unwrap_or(false)
            });

            if has_files {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ArchiveConfirmResponse::confirm_required(
                        task.name,
                        String::new(),
                        String::new(),
                        true,
                        true,
                        false,
                        false,
                    )),
                ));
            }
        }

        let archived = tasks::archive_task(&project_key, &task_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ArchiveConfirmResponse::error(
                        "ARCHIVE_FAILED",
                        "Archive failed",
                        task_id.clone(),
                    )),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                )
            })?;

        if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::GroupChanged);
        }

        return Ok(Json(storage_task_to_response(&archived)));
    }

    if !force {
        let task = match tasks::get_task(&project_key, &task_id).ok().flatten() {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                ));
            }
        };

        let mut worktree_dirty = false;
        let mut dirty_check_failed = false;
        match git::has_uncommitted_changes(&task.worktree_path) {
            Ok(v) => worktree_dirty = v,
            Err(_) => {
                dirty_check_failed = true;
            }
        }

        let mut branch_merged = true;
        let mut merge_check_failed = false;
        match git::is_merged(&project.path, &task.branch, &task.target) {
            Ok(v) => {
                branch_merged = v
                    || git::is_diff_empty(&project.path, &task.branch, &task.target)
                        .unwrap_or(false);
            }
            Err(_) => {
                merge_check_failed = true;
            }
        }

        let needs_confirm =
            worktree_dirty || !branch_merged || dirty_check_failed || merge_check_failed;
        if needs_confirm {
            return Err((
                StatusCode::CONFLICT,
                Json(ArchiveConfirmResponse::confirm_required(
                    task.name,
                    task.branch,
                    task.target,
                    worktree_dirty,
                    branch_merged,
                    dirty_check_failed,
                    merge_check_failed,
                )),
            ));
        }
    }

    let task_info = tasks::get_task(&project_key, &task_id).ok().flatten();
    let task_mux_str = task_info
        .as_ref()
        .map(|t| t.multiplexer.clone())
        .unwrap_or_default();
    let task_sname = task_info
        .as_ref()
        .map(|t| t.session_name.clone())
        .unwrap_or_default();

    let _ = crate::operations::tasks::archive_task(
        &project.path,
        &project_key,
        &task_id,
        &task_mux_str,
        &task_sname,
    )
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ArchiveConfirmResponse::error(
                "ARCHIVE_FAILED",
                "Archive failed",
                task_id.clone(),
            )),
        )
    })?;

    if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    let archived = loader::load_archived_worktrees(&project.path);
    let task = archived.iter().find(|wt| wt.id == task_id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ArchiveConfirmResponse::error(
                "ARCHIVED_TASK_NOT_FOUND",
                "Archived task not found",
                task_id.clone(),
            )),
        )
    })?;

    Ok(Json(common::worktree_to_response(task)))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/recover
pub async fn recover_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ApiError>)> {
    let (project, project_key) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let _result = crate::operations::tasks::recover_task(&project.path, &project_key, &task_id)
        .map_err(|e| {
            let status = match &e {
                crate::error::GroveError::NotFound(_) => StatusCode::NOT_FOUND,
                crate::error::GroveError::Git(_) => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (
                status,
                Json(ApiError {
                    error: e.to_string(),
                }),
            )
        })?;

    let project_path = project.path.clone();
    let tid = task_id.clone();
    let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
        let active = loader::load_worktrees(&project_path);
        active
            .iter()
            .find(|wt| wt.id == tid)
            .map(common::worktree_to_response)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: e.to_string(),
            }),
        )
    })?;

    let _ = crate::storage::taskgroups::ensure_system_groups();
    {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    result.map(Json).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Failed to find recovered task".to_string(),
            }),
        )
    })
}

/// PATCH /api/v1/projects/{id}/tasks/{taskId}
pub async fn rename_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<RenameTaskRequest>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (_project, project_key) = common::find_project_by_id(&id)?;

    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 200 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let pk = project_key.clone();
    let tid = task_id.clone();
    let new_name = name.clone();

    tokio::task::spawn_blocking(move || tasks::update_task_name(&pk, &tid, &new_name))
        .await
        .map_err(|e| {
            eprintln!("[rename_task] join error for task {}: {}", task_id, e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .map_err(|e| {
            eprintln!("[rename_task] storage error for task {}: {}", task_id, e);
            match e {
                crate::error::GroveError::NotFound(_) => StatusCode::NOT_FOUND,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            }
        })?;

    // Return the updated task
    get_task(Path((id, task_id))).await
}

/// Valid Kanban board columns, left → right.
const BOARD_COLUMNS: [&str; 4] = ["todo", "planned", "ongoing", "done"];

/// PATCH /api/v1/projects/{id}/tasks/{taskId}/stage
///
/// Move a task to a board column (kanban stage). Enforces the workflow lock: a
/// task already in `ongoing` or `done` may only advance to `done` (an in-work
/// card can be stopped or completed, but not dragged back). Broadcasts
/// `TaskStageChanged` so open boards update the card live.
pub async fn move_task_stage(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<MoveStageRequest>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (_project, project_key) = common::find_project_by_id(&id)?;

    let target = req.board_column.trim().to_string();
    if !BOARD_COLUMNS.contains(&target.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Read-lock-check-write happen atomically in the storage layer under one
    // DB-connection lock (see tasks::move_task_stage), so concurrent moves
    // cannot interleave.
    let pk = project_key.clone();
    let tid = task_id.clone();
    let col = target.clone();
    let explicit = req.board_order;
    let outcome =
        tokio::task::spawn_blocking(move || tasks::move_task_stage(&pk, &tid, &col, explicit))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let board_order = match outcome {
        tasks::StageMove::NotFound => return Err(StatusCode::NOT_FOUND),
        // Drag-locked: an ongoing/done task may only advance to done.
        tasks::StageMove::Locked => return Err(StatusCode::CONFLICT),
        tasks::StageMove::Moved { board_order } => board_order,
    };

    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::TaskStageChanged {
        project_id: id.clone(),
        task_id: task_id.clone(),
        board_column: target,
        board_order,
    });

    get_task(Path((id, task_id))).await
}

/// Build the opening prompt handed to a dispatched agent.
fn build_dispatch_prompt(title: &str, body: Option<&str>) -> String {
    let mut p = format!("# Task: {title}\n\n");
    if let Some(b) = body {
        if !b.trim().is_empty() {
            p.push_str(b.trim());
            p.push_str("\n\n");
        }
    }
    p.push_str(
        "Investigate and implement a fix for the above in this worktree. \
         When you are done, commit your changes with a clear message.",
    );
    p
}

/// POST /api/v1/projects/{id}/tasks/dispatch
///
/// Composite "create task + auto-start an agent" for external callers (e.g. the
/// nanobot bug connector). Creates the task (worktree + branch), files it on the
/// board in `todo`/`planned`, and — when `auto_start` — creates a chat, starts
/// the agent headlessly in the worktree, and sends the task body as the opening
/// prompt. The card stays in its filed column; the board surfaces it as IN WORK
/// off the live session status, not a persisted `ongoing`.
///
/// Partial success is explicit: once the task is created the call returns 200
/// even if the agent fails to start, with `agent_started:false` and an
/// `agent_error` reason (the task is still filed for a human to retry).
///
/// SECURITY: on the no-auth `grove web` (:3001, loopback) this endpoint lets any
/// local caller create a task and spawn an auto-approving agent. External
/// callers must use the HMAC-authenticated mobile server (:3002); :3001 is
/// loopback-only by design.
pub async fn dispatch_task(
    Path(id): Path<String>,
    Json(req): Json<DispatchRequest>,
) -> Result<Json<DispatchResponse>, (StatusCode, Json<ApiError>)> {
    let err = |s: StatusCode, m: &str| {
        (
            s,
            Json(ApiError {
                error: m.to_string(),
            }),
        )
    };

    let (project, project_key) =
        common::find_project_by_id(&id).map_err(|s| err(s, "Project not found"))?;
    let project_path = project.path.clone();
    let project_name = project.name.clone();

    let title = req.title.trim().to_string();
    if title.is_empty() || title.len() > 200 {
        return Err(err(StatusCode::BAD_REQUEST, "title required (1-200 chars)"));
    }
    // A card may only be *filed* into todo or planned. ongoing/done are
    // reached by the agent lifecycle / user action, never as an initial stage.
    let into = req
        .into
        .clone()
        .unwrap_or_else(|| if req.auto_start { "planned" } else { "todo" }.to_string());
    if into != "todo" && into != "planned" {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "into must be 'todo' or 'planned'",
        ));
    }

    let full_config = storage::config::load_config();
    let is_studio = project.project_type == workspace::ProjectType::Studio;

    // Validate the agent up front, BEFORE creating a task, so an unknown or
    // terminal-only agent fails fast without leaving an orphaned worktree.
    let agent = if req.auto_start {
        if is_studio {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "auto_start is not supported for Studio projects",
            ));
        }
        let a = crate::storage::installed_agents::canonicalize_agent_id(
            &req.agent.clone().unwrap_or_else(|| {
                full_config
                    .acp
                    .agent_command
                    .clone()
                    .unwrap_or_else(|| "claude-acp".to_string())
            }),
        );
        crate::api::handlers::acp::validate_dispatch_agent(&a)
            .map_err(|e| err(e.status(), &e.message()))?;
        Some(a)
    } else {
        None
    };

    // 1. Create the task (+ worktree for repo projects).
    let pk = project_key.clone();
    let ppath = project_path.clone();
    let name = title.clone();
    let target = req.target.clone();
    let cfg = full_config.clone();
    let result = tokio::task::spawn_blocking(move || {
        if is_studio {
            crate::operations::tasks::create_studio_task(
                &ppath,
                &pk,
                name,
                &cfg.default_session_type(),
                "dispatch",
            )
        } else {
            let target = target.unwrap_or_else(|| {
                git::current_branch(&ppath).unwrap_or_else(|_| "main".to_string())
            });
            crate::operations::tasks::create_task(
                &ppath,
                &pk,
                name,
                target,
                &cfg.default_session_type(),
                &cfg.auto_link.patterns,
                "dispatch",
            )
        }
    })
    .await
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "task join error"))?
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("already exists") {
            err(StatusCode::CONFLICT, &msg)
        } else {
            err(StatusCode::INTERNAL_SERVER_ERROR, &msg)
        }
    })?;

    let task = result.task;

    // 2. File the new card on the board (from the created default "todo"),
    //    capturing the atomic move's own result so the response and event
    //    reflect the true persisted stage without a lossy reload.
    let (board_column, board_order) = {
        let pk = project_key.clone();
        let tid = task.id.clone();
        let col = into.clone();
        match tokio::task::spawn_blocking(move || tasks::move_task_stage(&pk, &tid, &col, None))
            .await
        {
            Ok(Ok(tasks::StageMove::Moved { board_order })) => (into.clone(), board_order),
            other => {
                // The move should always succeed for a fresh task; if it did
                // not, the card is still at its created default (todo, order 0).
                eprintln!(
                    "[dispatch] failed to file task {} into {}: {:?}",
                    task.id, into, other
                );
                (task.board_column.clone(), task.board_order)
            }
        }
    };

    // 3. Optionally start an agent and hand it the opening prompt. Every failure
    //    past task creation is non-fatal: the task is already filed, so we
    //    report the reason via `agent_error` and still return 200.
    let AgentStartOutcome {
        chat_id: chat_id_out,
        agent_started,
        agent_error,
    } = match agent {
        Some(agent) => {
            start_agent_on_task(
                &id,
                &project_key,
                &project_path,
                &project_name,
                &task,
                &agent,
                &title,
                req.body.as_deref(),
                &full_config,
            )
            .await
        }
        None => AgentStartOutcome::default(),
    };

    // 3b. If an agent actually started, advance the card to IN WORK (ongoing)
    //     so the board places the running agent correctly across remounts. The
    //     persisted board_column is authoritative when no live Radio event has
    //     yet repainted the card; without this the card falls back to PLANNED
    //     the moment the board is re-rendered.
    let (board_column, board_order) = if agent_started {
        let pk = project_key.clone();
        let tid = task.id.clone();
        match tokio::task::spawn_blocking(move || {
            tasks::move_task_stage(&pk, &tid, "ongoing", None)
        })
        .await
        {
            Ok(Ok(tasks::StageMove::Moved { board_order })) => {
                ("ongoing".to_string(), board_order)
            }
            _ => (board_column, board_order),
        }
    } else {
        (board_column, board_order)
    };

    // 4. Build the response from the created task overlaid with the board
    //    stage captured from the atomic move (step 2) — no lossy reload.
    let mut resp_task = task;
    resp_task.board_column = board_column.clone();
    resp_task.board_order = board_order;

    // 5. Notify listeners and return.
    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);
    broadcast_radio_event(RadioEvent::TaskStageChanged {
        project_id: id.clone(),
        task_id: resp_task.id.clone(),
        board_column: board_column.clone(),
        board_order,
    });

    Ok(Json(DispatchResponse {
        task: storage_task_to_response(&resp_task),
        chat_id: chat_id_out,
        board_column,
        agent_started,
        agent_error,
    }))
}

/// Outcome of launching a headless agent on a task.
#[derive(Default)]
struct AgentStartOutcome {
    chat_id: Option<String>,
    agent_started: bool,
    agent_error: Option<String>,
}

/// Create a headless ACP chat on `task`, start the agent, and hand it the
/// opening prompt built from `title`/`body`. Shared by `POST /tasks/dispatch`
/// (brand-new task) and `POST /tasks/{taskId}/start` (an existing board card
/// dragged into PLANNED). `agent` must already be canonicalized + validated.
/// Every failure past chat creation is non-fatal and surfaced via `agent_error`
/// so the caller keeps the card filed. `id` is the public project id (radio
/// events); the rest are the resolved project + task.
#[allow(clippy::too_many_arguments)]
async fn start_agent_on_task(
    id: &str,
    project_key: &str,
    project_path: &str,
    project_name: &str,
    task: &tasks::Task,
    agent: &str,
    title: &str,
    body: Option<&str>,
    full_config: &crate::storage::config::Config,
) -> AgentStartOutcome {
    let mut out = AgentStartOutcome::default();

    let chat = tasks::ChatSession {
        id: tasks::generate_chat_id(),
        title: crate::api::handlers::acp::default_chat_title(
            agent,
            full_config,
            project_key,
            &task.id,
        ),
        agent: agent.to_string(),
        acp_session_id: None,
        created_at: chrono::Utc::now(),
        duty: None,
        // Headless dispatch drives the agent over ACP, not a PTY.
        launch_mode: "acp".to_string(),
    };
    let chat_id = chat.id.clone();
    out.chat_id = Some(chat_id.clone());

    let persisted = {
        let pk = project_key.to_string();
        let tid = task.id.clone();
        let chat = chat.clone();
        tokio::task::spawn_blocking(move || tasks::add_chat_session(&pk, &tid, chat)).await
    };

    match persisted {
        Ok(Ok(())) => {
            match crate::api::handlers::acp::start_dispatch_session(
                project_key,
                project_path,
                project_name,
                task,
                &chat_id,
                agent,
            )
            .await
            {
                Ok((handle, confirmed)) => {
                    let prompt = build_dispatch_prompt(title, body);
                    match handle
                        .send_prompt(prompt, vec![], Some("dispatch".to_string()), false, None)
                        .await
                    {
                        Ok(_) => {
                            out.agent_started = true;
                            if !confirmed {
                                out.agent_error = Some(
                                    "agent start not confirmed within 45s; it may still be initializing"
                                        .to_string(),
                                );
                            }
                        }
                        Err(e) => {
                            out.agent_error = Some(format!("failed to send opening prompt: {e}"));
                        }
                    }
                }
                Err(e) => out.agent_error = Some(e.message()),
            }
            // Let listeners know a chat now exists on this task.
            crate::api::handlers::walkie_talkie::broadcast_radio_event(
                crate::api::handlers::walkie_talkie::RadioEvent::ChatListChanged {
                    project_id: id.to_string(),
                    task_id: task.id.clone(),
                },
            );
        }
        Ok(Err(e)) => {
            out.agent_error = Some(format!("failed to persist chat: {e}"));
            out.chat_id = None;
        }
        Err(_) => {
            out.agent_error = Some("chat persistence task failed".to_string());
            out.chat_id = None;
        }
    }

    out
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/start
///
/// Start a headless agent on an *existing* task and file it into PLANNED. This
/// is the board's "drag a TODO card into PLANNED" gesture: unlike
/// `POST /tasks/dispatch` (which creates a fresh task + worktree), the task and
/// worktree already exist here — we only create the chat, start the agent, send
/// the opening prompt (the task's existing notes/body), and move the stage.
///
/// Idempotent-ish: if a session for this task is already live, `start_dispatch_session`
/// returns the existing handle rather than double-launching. Partial success is
/// explicit (agent may fail to start; the card is still moved to PLANNED).
pub async fn start_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<StartTaskRequest>,
) -> Result<Json<DispatchResponse>, (StatusCode, Json<ApiError>)> {
    let err = |s: StatusCode, m: &str| {
        (
            s,
            Json(ApiError {
                error: m.to_string(),
            }),
        )
    };

    let (project, project_key) =
        common::find_project_by_id(&id).map_err(|s| err(s, "Project not found"))?;

    if project.project_type == workspace::ProjectType::Studio {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "starting an agent is not supported for Studio projects",
        ));
    }

    let project_path = project.path.clone();
    let project_name = project.name.clone();

    // The task must already exist (with its worktree).
    let task = {
        let pk = project_key.clone();
        let tid = task_id.clone();
        tokio::task::spawn_blocking(move || tasks::get_task(&pk, &tid))
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "task join error"))?
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "Task not found"))?
    };

    let full_config = storage::config::load_config();

    // Validate + canonicalize the agent before creating the chat.
    let agent = crate::storage::installed_agents::canonicalize_agent_id(
        &req.agent.clone().unwrap_or_else(|| {
            full_config
                .acp
                .agent_command
                .clone()
                .unwrap_or_else(|| "claude-acp".to_string())
        }),
    );
    crate::api::handlers::acp::validate_dispatch_agent(&agent)
        .map_err(|e| err(e.status(), &e.message()))?;

    // File the card into PLANNED (append). Do this before starting so the board
    // reflects intent immediately even if the agent is slow to confirm.
    let (board_column, board_order) = {
        let pk = project_key.clone();
        let tid = task_id.clone();
        match tokio::task::spawn_blocking(move || {
            tasks::move_task_stage(&pk, &tid, "planned", None)
        })
        .await
        {
            Ok(Ok(tasks::StageMove::Moved { board_order })) => ("planned".to_string(), board_order),
            // Drag-locked (already ongoing/done) or not found — keep current stage.
            _ => (task.board_column.clone(), task.board_order),
        }
    };

    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::TaskStageChanged {
        project_id: id.clone(),
        task_id: task_id.clone(),
        board_column: board_column.clone(),
        board_order,
    });

    // The opening prompt reuses the task name as the title; the body defaults to
    // the caller-supplied text (a manual board start has none, and the agent
    // just picks up the worktree's own notes/context).
    let outcome = start_agent_on_task(
        &id,
        &project_key,
        &project_path,
        &project_name,
        &task,
        &agent,
        &task.name,
        req.body.as_deref(),
        &full_config,
    )
    .await;

    // If the agent actually started, advance the card from PLANNED to IN WORK
    // (ongoing) so the board reflects the running agent across remounts. The
    // persisted column is authoritative when no live Radio event has repainted
    // the card yet; without this the card silently falls back to PLANNED.
    let (board_column, board_order) = if outcome.agent_started {
        let pk = project_key.clone();
        let tid = task_id.clone();
        match tokio::task::spawn_blocking(move || {
            tasks::move_task_stage(&pk, &tid, "ongoing", None)
        })
        .await
        {
            Ok(Ok(tasks::StageMove::Moved { board_order })) => {
                broadcast_radio_event(RadioEvent::TaskStageChanged {
                    project_id: id.clone(),
                    task_id: task_id.clone(),
                    board_column: "ongoing".to_string(),
                    board_order,
                });
                ("ongoing".to_string(), board_order)
            }
            _ => (board_column, board_order),
        }
    } else {
        (board_column, board_order)
    };

    let mut resp_task = task;
    resp_task.board_column = board_column.clone();
    resp_task.board_order = board_order;

    Ok(Json(DispatchResponse {
        task: storage_task_to_response(&resp_task),
        chat_id: outcome.chat_id,
        board_column,
        agent_started: outcome.agent_started,
        agent_error: outcome.agent_error,
    }))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}
pub async fn delete_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Err(StatusCode::BAD_REQUEST);
    }

    let (project, project_key) = common::find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    if project.project_type == workspace::ProjectType::Studio {
        let task_path = std::path::Path::new(&task.worktree_path);
        let expected_prefix = workspace::studio_project_dir(&project.path).join("tasks");
        if task_path.exists() && task_path.starts_with(&expected_prefix) {
            fs::remove_dir_all(task_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }

        let _ = tasks::remove_task(&project_key, &task_id);
        let _ = tasks::remove_archived_task(&project_key, &task_id);
        hooks::remove_task_hook(&project_key, &task_id);
        let _ = storage::delete_task_data(&project_key, &task_id);
        crate::symbols::on_task_deleted(&project_key, &task_id);

        if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::GroupChanged);
        }

        return Ok(StatusCode::NO_CONTENT);
    }

    let task_session_type = session::resolve_session_type(&task.multiplexer);
    let session_name = session::resolve_session_name(&task.session_name, &project_key, &task_id);
    let _ = session::kill_session(&task_session_type, &session_name);
    if matches!(task_session_type, SessionType::Zellij) {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    let _ = git::remove_worktree(&project.path, &task.worktree_path);
    let _ = git::delete_branch(&project.path, &task.branch);

    let _ = tasks::remove_task(&project_key, &task_id);
    let _ = tasks::remove_archived_task(&project_key, &task_id);

    hooks::remove_task_hook(&project_key, &task_id);
    let _ = storage::delete_task_data(&project_key, &task_id);
    crate::symbols::on_task_deleted(&project_key, &task_id);

    if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    Ok(StatusCode::NO_CONTENT)
}
