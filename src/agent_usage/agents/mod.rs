//! Agent layer — auth resolution + provider dispatch.
//!
//! Each module resolves credentials for its own agent (reads keychains,
//! auth.json files, env vars) and then calls the appropriate provider from
//! the `providers` layer. Shared model classification and the upstream
//! dispatcher live here so multi-provider agents (opencode, hermes) don't
//! duplicate the match logic.

pub mod claude;
pub mod codex;
pub mod gemini;
pub mod hermes;
pub mod opencode;

use super::providers::{copilot, kimi, minimax, synthetic, zai};
use super::AgentUsage;

/// Which upstream provider a given model routes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Upstream {
    Kimi,
    Synthetic,
    Zai,
    Copilot,
    MiniMax,
    Unknown,
}

impl Upstream {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Upstream::Kimi => "kimi",
            Upstream::Synthetic => "synthetic",
            Upstream::Zai => "zai",
            Upstream::Copilot => "copilot",
            Upstream::MiniMax => "minimax",
            Upstream::Unknown => "unknown",
        }
    }
}

/// Map a provider prefix (the segment before `/` in a model string, or a
/// standalone provider name from config) to an `Upstream`. Returns `None` for
/// unrecognised providers.
pub(crate) fn classify_provider(provider: Option<&str>) -> Option<Upstream> {
    match provider? {
        "minimax" | "minimaxi" => Some(Upstream::MiniMax),
        "moonshotai" | "moonshot" | "kimi" => Some(Upstream::Kimi),
        "zai" | "zhipuai" | "glm" | "z-ai" | "bigmodel" => Some(Upstream::Zai),
        "github-copilot" | "copilot" => Some(Upstream::Copilot),
        "synthetic" => Some(Upstream::Synthetic),
        _ => None,
    }
}

/// Classify a model string using prefix matching then keyword fallback.
///
/// The provider segment is whatever comes before the first `/`. If that
/// matches a known provider, it wins. Otherwise, keyword scanning is used
/// for bare model names like `"MiniMax-M3"` or `"kimi-k2-0528"`.
pub(crate) fn classify_model(model: &str) -> Upstream {
    let lower = model.to_ascii_lowercase();
    let provider = lower.split('/').next().unwrap_or("");

    if let Some(up) = classify_provider(Some(provider)) {
        return up;
    }
    // Keyword fallback for bare names (no `/` prefix).
    if lower.contains("minimax") {
        Upstream::MiniMax
    } else if lower.contains("kimi") || lower.contains("moonshot") {
        Upstream::Kimi
    } else if lower.contains("glm")
        || lower.contains("zhipu")
        || lower.contains("zai")
        || lower.contains("z-ai")
    {
        Upstream::Zai
    } else {
        Upstream::Unknown
    }
}

/// Dispatch to the correct upstream provider for multi-provider agents.
///
/// `resolve(upstream)` is called with the classified upstream to obtain a
/// token. Each agent provides its own resolver so it can use its own auth
/// key names (OpenCode's keys differ from Hermes's credential_pool keys).
///
/// Returning `None` from `resolve` is treated as "token not found" and
/// causes the fetch to fail with a descriptive error.
pub(super) fn dispatch_upstream(
    upstream: Upstream,
    agent_name: &str,
    resolve: impl Fn(Upstream) -> Option<String>,
) -> Result<AgentUsage, String> {
    if upstream == Upstream::Unknown {
        return Err("model does not map to a known upstream quota".into());
    }
    let token = resolve(upstream)
        .ok_or_else(|| format!("{} {} token not found", agent_name, upstream.as_str()))?;
    let mut usage = match upstream {
        Upstream::MiniMax => minimax::fetch_with_token(&token)?,
        Upstream::Kimi => kimi::fetch_with_token(&token)?,
        Upstream::Synthetic => synthetic::fetch_with_token(&token)?,
        Upstream::Zai => zai::fetch_with_token(&token)?,
        Upstream::Copilot => copilot::fetch_with_token(&token)?,
        Upstream::Unknown => unreachable!(),
    };
    // Rebrand so the frontend's `cached.agent === agentId` check matches the
    // active ACP agent name, not the underlying upstream ("kimi", "minimax", …).
    usage.agent = agent_name.to_string();
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_model_prefixed() {
        assert_eq!(classify_model("minimax/MiniMax-M3"), Upstream::MiniMax);
        assert_eq!(classify_model("minimaxi/MiniMax-M2"), Upstream::MiniMax);
        assert_eq!(classify_model("moonshotai/kimi-k2"), Upstream::Kimi);
        assert_eq!(classify_model("zai/glm-4.5"), Upstream::Zai);
        assert_eq!(classify_model("github-copilot/gpt-4o"), Upstream::Copilot);
        assert_eq!(
            classify_model("synthetic/gpt-oss-120b"),
            Upstream::Synthetic
        );
    }

    #[test]
    fn classify_model_bare_names() {
        assert_eq!(classify_model("MiniMax-M3"), Upstream::MiniMax);
        assert_eq!(classify_model("kimi-k2-0528"), Upstream::Kimi);
        assert_eq!(classify_model("glm-4-plus"), Upstream::Zai);
    }

    #[test]
    fn classify_model_unknown() {
        assert_eq!(classify_model("gpt-4o"), Upstream::Unknown);
        assert_eq!(classify_model("claude-sonnet-4"), Upstream::Unknown);
    }

    #[test]
    fn classify_provider_mapping() {
        assert_eq!(classify_provider(Some("minimax")), Some(Upstream::MiniMax));
        assert_eq!(classify_provider(Some("minimaxi")), Some(Upstream::MiniMax));
        assert_eq!(classify_provider(Some("moonshotai")), Some(Upstream::Kimi));
        assert_eq!(classify_provider(Some("unknown-provider")), None);
        assert_eq!(classify_provider(None), None);
    }
}
