//! Agent discovery API handlers

use axum::extract::Path;
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AgentCapabilitiesDto {
    /// (id, label) pairs. Empty when the agent has never connected.
    pub models: Vec<(String, String)>,
    pub modes: Vec<(String, String)>,
    pub thought_levels: Vec<(String, String)>,
}

/// GET /api/v1/agents/{id}/capabilities
/// Returns the cached model/mode/thought-level options for an agent id, or
/// empty arrays if it has never reached `session_ready`.
pub async fn get_agent_capabilities(Path(id): Path<String>) -> Json<AgentCapabilitiesDto> {
    let caps = crate::storage::agent_capabilities::read(&id).unwrap_or_default();
    Json(AgentCapabilitiesDto {
        models: caps.models,
        modes: caps.modes,
        thought_levels: caps.thought_levels,
    })
}

#[cfg(test)]
mod capability_endpoint_tests {
    use super::*;

    #[tokio::test]
    async fn unknown_agent_returns_empty_lists() {
        let tmp = std::env::temp_dir().join(format!("grove-cap-ep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        crate::storage::set_grove_dir_override(Some(tmp.clone()));

        let Json(dto) = get_agent_capabilities(axum::extract::Path("never-ran".to_string())).await;
        assert!(dto.models.is_empty());
        assert!(dto.modes.is_empty());
        assert!(dto.thought_levels.is_empty());

        crate::storage::set_grove_dir_override(None);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
