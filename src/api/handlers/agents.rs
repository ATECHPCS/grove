//! Agent discovery API handlers

use axum::extract::Path;
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct BaseAgentDto {
    pub id: String,
    pub display_name: String,
    pub icon_id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Launch modes this agent can run in (e.g. `["acp", "terminal"]`). Lets the
    /// New-chat picker offer a per-chat ACP-vs-terminal choice without a second
    /// round-trip to the marketplace endpoint.
    pub supported_launch_modes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BaseAgentsResponse {
    pub agents: Vec<BaseAgentDto>,
}

/// GET /api/v1/agents/base
///
/// Return every built-in ACP base agent with backend-derived availability.
/// Settings uses this as the source of truth instead of probing commands in
/// the browser.
///
/// `base_acp_agent_statuses` probes PATH on every call (no cache) so the UI
/// immediately reflects newly installed agents without a restart.
pub async fn list_base_agents() -> Json<BaseAgentsResponse> {
    let agents = crate::acp::base_acp_agent_statuses()
        .into_iter()
        .map(|status| BaseAgentDto {
            id: status.agent.id.to_string(),
            display_name: status.agent.display_name.to_string(),
            icon_id: status.agent.icon_id.to_string(),
            available: status.available,
            unavailable_reason: status.unavailable_reason,
            supported_launch_modes: crate::storage::agent_supplement::supported_launch_modes(
                status.agent.id,
            )
            .iter()
            .map(|m| m.to_string())
            .collect(),
        })
        .collect();

    Json(BaseAgentsResponse { agents })
}

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
