//! Per-agent capability cache. Records the model/mode/thought-level option
//! lists an agent declares at ACP `session_ready`, keyed by agent id (the
//! same id used by `acp.agent_command` and a chat's stored `agent`), so the
//! Settings UI can offer valid choices without spawning a session.

// Public API consumed by later tasks (acp session_ready handler, REST endpoint).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// (id, human-label) pairs, matching the ACP `available_*` shape.
pub type OptionList = Vec<(String, String)>;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AgentCapabilities {
    #[serde(default)]
    pub models: OptionList,
    #[serde(default)]
    pub modes: OptionList,
    #[serde(default)]
    pub thought_levels: OptionList,
}

fn cache_path() -> std::path::PathBuf {
    crate::storage::grove_dir().join("agent_capabilities.json")
}

fn load_all() -> HashMap<String, AgentCapabilities> {
    match std::fs::read_to_string(cache_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Read the cached capabilities for an agent id, or `None` if it has never
/// reached `session_ready`.
pub fn read(agent_id: &str) -> Option<AgentCapabilities> {
    load_all().get(agent_id).cloned()
}

/// Upsert (last-writer-wins) the capabilities for an agent id. Errors are
/// swallowed: a failed cache write must never break a live session.
pub fn upsert(agent_id: &str, caps: AgentCapabilities) {
    let mut all = load_all();
    if all.get(agent_id) == Some(&caps) {
        return;
    }
    all.insert(agent_id.to_string(), caps);
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_string_pretty(&all) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_then_read_round_trips() {
        let tmp = std::env::temp_dir().join(format!("grove-cap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        crate::storage::set_grove_dir_override(Some(tmp.clone()));

        assert_eq!(read("claude"), None);

        let caps = AgentCapabilities {
            models: vec![("opus".into(), "Opus".into())],
            modes: vec![("auto".into(), "Auto".into())],
            thought_levels: vec![("high".into(), "High".into())],
        };
        upsert("claude", caps.clone());
        assert_eq!(read("claude"), Some(caps));
        assert_eq!(read("codex"), None);

        crate::storage::set_grove_dir_override(None);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
