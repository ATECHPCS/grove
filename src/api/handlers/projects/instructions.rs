//! Studio instructions and legacy memory migration handlers

use axum::{extract::Path, http::StatusCode, Json};
use uuid::Uuid;

use crate::api::error::ApiError;
use crate::storage::memory;

use super::crud::resolve_studio_dir;
use super::types::*;

/// GET /api/v1/projects/{id}/instructions
pub async fn get_instructions(
    Path(id): Path<String>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("instructions.md");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read instructions: {}", e),
                }),
            ))
        }
    };
    Ok(Json(InstructionsResponse { content }))
}

/// PUT /api/v1/projects/{id}/instructions
pub async fn update_instructions(
    Path(id): Path<String>,
    Json(body): Json<InstructionsUpdateRequest>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("instructions.md");
    std::fs::write(&path, &body.content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to write instructions: {}", e),
            }),
        )
    })?;
    Ok(Json(InstructionsResponse {
        content: body.content,
    }))
}

/// GET /api/v1/projects/{id}/memory
pub async fn get_memory(
    Path(id): Path<String>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("memory.md");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read memory: {}", e),
                }),
            ))
        }
    };
    Ok(Json(InstructionsResponse { content }))
}

/// POST /api/v1/projects/{id}/memory/migrate
///
/// Legacy Studio Memory predates the project Memory lifecycle. Move its full
/// Markdown body into one immutable migration Log, then remove the shared
/// `memory.md` target so new work cannot continue writing both systems.
pub async fn migrate_memory(
    Path(id): Path<String>,
) -> Result<Json<LegacyMemoryMigrationResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let source = studio_dir.join("memory.md");
    let content = std::fs::read_to_string(&source).map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (
            status,
            Json(ApiError {
                error: if status == StatusCode::NOT_FOUND {
                    "Legacy Project Memory no longer exists".to_string()
                } else {
                    format!("Failed to read legacy Project Memory: {error}")
                },
            }),
        )
    })?;
    if content.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "Legacy Project Memory is empty".to_string(),
            }),
        ));
    }

    // Rename first so concurrent migration requests cannot create duplicate
    // Logs. If SQLite persistence fails, restore the original source path.
    let staged = studio_dir.join(format!(".memory-migration-{}.md", Uuid::new_v4()));
    std::fs::rename(&source, &staged).map_err(|error| {
        (
            StatusCode::CONFLICT,
            Json(ApiError {
                error: format!("Legacy Project Memory could not be reserved: {error}"),
            }),
        )
    })?;

    let log = match memory::append_log(&memory::NewMemoryLog {
        project_id: &id,
        task_id: "_studio_memory_migration",
        chat_id: None,
        agent: Some("grove"),
        title: "Legacy Studio Project Memory",
        tags: &[
            "studio".to_string(),
            "legacy-memory".to_string(),
            "migration".to_string(),
        ],
        description: &content,
    }) {
        Ok(log) => log,
        Err(error) => {
            if let Err(restore_error) = std::fs::rename(&staged, &source) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!(
                            "Failed to create migration Log: {error}; also failed to restore memory.md: {restore_error}"
                        ),
                    }),
                ));
            }
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to create migration Log: {error}"),
                }),
            ));
        }
    };

    // The canonical legacy path is already gone. A failed cleanup leaves only
    // a hidden recoverable copy and must not invite a duplicate migration.
    if let Err(error) = std::fs::remove_file(&staged) {
        crate::automation::awarn!(
            "legacy Memory Log was created but staged source cleanup failed for {}: {error}",
            staged.display()
        );
    }

    Ok(Json(LegacyMemoryMigrationResponse { log_id: log.id }))
}
