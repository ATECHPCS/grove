//! Hermes multi-provider quota dispatcher.
//!
//! Reads credentials from Hermes' `~/.hermes/auth.json` credential_pool.
//! Key names here are Hermes-specific and must NOT be shared with other agents.
//!
//! When no model is provided, `~/.hermes/config.yaml` is consulted to find
//! the user's configured default provider.

use super::super::hermes_auth::read_hermes_token;
use super::super::providers::zai;
use super::super::{AcpQuotaProvider, AgentUsage};
use super::{classify_model, classify_provider, dispatch_upstream, Upstream};
use std::fs;

// Hermes credential_pool key names (~/.hermes/auth.json).
const KEY_MINIMAX: &str = "minimax";
const KEY_KIMI: &str = "kimi-for-coding";
const KEY_SYNTHETIC: &str = "synthetic";
const KEY_COPILOT: &str = "github-copilot";

pub struct HermesProvider;

/// Read `model.provider` from `~/.hermes/config.yaml` without a YAML parser.
/// Looks for the first `  provider: <value>` line inside the `model:` block.
fn read_config_provider() -> Option<String> {
    let path = dirs::home_dir()?.join(".hermes/config.yaml");
    let content = fs::read_to_string(path).ok()?;
    let mut in_model_block = false;
    for line in content.lines() {
        if line.starts_with("model:") {
            in_model_block = true;
            continue;
        }
        if in_model_block {
            if !line.starts_with(' ') && !line.starts_with('\t') {
                break;
            }
            if let Some(rest) = line.trim().strip_prefix("provider:") {
                let v = rest.trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn classify(model: Option<&str>) -> Upstream {
    let Some(m) = model else {
        return classify_provider(read_config_provider().as_deref()).unwrap_or(Upstream::Unknown);
    };
    classify_model(m)
}

impl AcpQuotaProvider for HermesProvider {
    fn provider_id(&self) -> &str {
        "hermes"
    }

    fn quota_id(&self, model: Option<&str>) -> String {
        format!("hermes:{}", classify(model).as_str())
    }

    fn fetch_usage(&self, model: Option<&str>) -> Result<AgentUsage, String> {
        dispatch_upstream(classify(model), "hermes", |up| match up {
            Upstream::MiniMax => read_hermes_token(KEY_MINIMAX),
            Upstream::Kimi => read_hermes_token(KEY_KIMI),
            Upstream::Synthetic => read_hermes_token(KEY_SYNTHETIC),
            Upstream::Copilot => read_hermes_token(KEY_COPILOT),
            Upstream::Zai => zai::resolve_token(),
            Upstream::Unknown => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_prefixed() {
        assert_eq!(classify(Some("minimax/MiniMax-M3")), Upstream::MiniMax);
        assert_eq!(classify(Some("minimaxi/MiniMax-M2")), Upstream::MiniMax);
        assert_eq!(classify(Some("moonshotai/kimi-k2")), Upstream::Kimi);
        assert_eq!(classify(Some("zai/glm-4.5")), Upstream::Zai);
        assert_eq!(classify(Some("github-copilot/gpt-4o")), Upstream::Copilot);
        assert_eq!(
            classify(Some("synthetic/gpt-oss-120b")),
            Upstream::Synthetic
        );
    }

    #[test]
    fn classify_bare_model_names() {
        assert_eq!(classify(Some("MiniMax-M3")), Upstream::MiniMax);
        assert_eq!(classify(Some("MiniMax-Text-01")), Upstream::MiniMax);
        assert_eq!(classify(Some("kimi-k2-0528")), Upstream::Kimi);
    }

    #[test]
    fn classify_unknown() {
        assert_eq!(classify(Some("gpt-4o")), Upstream::Unknown);
        assert_eq!(classify(Some("claude-sonnet-4")), Upstream::Unknown);
    }
}
