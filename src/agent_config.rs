//! Agent runtime configuration selected from a persisted capability snapshot.
//!
//! This is shared by Automations, Memory organization, and Custom Agents. It
//! intentionally lives outside those product domains: each consumer owns when
//! the Agent runs, while this type only describes how the Agent is configured.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum AgentConfigSelection {
    Default {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
    },
    ConfigOptions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default)]
        values: BTreeMap<String, crate::acp::ConfigOptionValue>,
    },
    Modes {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        mode_id: String,
    },
}

impl Default for AgentConfigSelection {
    fn default() -> Self {
        Self::Default { agent_id: None }
    }
}

impl AgentConfigSelection {
    pub fn agent_id(&self) -> Option<&str> {
        match self {
            Self::Default { agent_id }
            | Self::ConfigOptions { agent_id, .. }
            | Self::Modes { agent_id, .. } => agent_id.as_deref(),
        }
    }

    pub fn queued_config(&self) -> Option<crate::acp::QueuedConfig> {
        match self {
            Self::Default { .. } => None,
            Self::ConfigOptions { values, .. } => Some(crate::acp::QueuedConfig {
                model: None,
                mode: None,
                thought_level: None,
                thought_level_config_id: None,
                config_options: values.clone(),
            }),
            Self::Modes { mode_id, .. } => Some(crate::acp::QueuedConfig {
                model: None,
                mode: Some(mode_id.clone()),
                thought_level: None,
                thought_level_config_id: None,
                config_options: BTreeMap::new(),
            }),
        }
    }
}
