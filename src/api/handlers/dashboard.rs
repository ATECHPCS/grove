//! Groove dashboard endpoint — a privacy-safe, 5s-cached overview snapshot of
//! projects, agents/sessions, token usage, and recent activity. Backs the
//! standalone status board.

use axum::http::StatusCode;
use axum::Json;

use crate::groove_dashboard::{load_snapshot_cached, GrooveDashboardSnapshot};

/// GET /api/v1/dashboard — current snapshot (served from the 5s cache).
pub async fn get_dashboard() -> Result<Json<GrooveDashboardSnapshot>, StatusCode> {
    match load_snapshot_cached() {
        Ok(snapshot) => Ok(Json(snapshot)),
        Err(err) => {
            eprintln!("[dashboard] failed to build snapshot: {err}");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
