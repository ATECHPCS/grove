//! GET/PUT per-project task defaults (agent / prompt preamble / rules /
//! routing). Keyed by the project's stable hash. Served on both the loopback
//! `grove web` (:3001) and the HMAC mobile server (:3002) so the nanobot
//! file_bug classifier can read `routing_rules`.

use axum::{extract::Path, http::StatusCode, Json};

use crate::api::handlers::common;
use crate::storage::project_settings::{self, ProjectSettings};

/// GET /api/v1/projects/{id}/settings — returns all-empty defaults if unset.
pub async fn get_project_settings(
    Path(id): Path<String>,
) -> Result<Json<ProjectSettings>, StatusCode> {
    let (_project, project_key) = common::find_project_by_id(&id)?;
    let settings = tokio::task::spawn_blocking(move || project_settings::get(&project_key))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(settings))
}

/// PUT /api/v1/projects/{id}/settings — upsert and echo the saved settings.
pub async fn put_project_settings(
    Path(id): Path<String>,
    Json(body): Json<ProjectSettings>,
) -> Result<Json<ProjectSettings>, StatusCode> {
    let (_project, project_key) = common::find_project_by_id(&id)?;
    let saved = tokio::task::spawn_blocking(move || {
        project_settings::upsert(&project_key, &body).map(|_| body)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(saved))
}
