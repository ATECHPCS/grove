//! Codex agent — credential resolution.
//!
//! Reads `~/.codex/auth.json` for `tokens.access_token`, then delegates to
//! `providers::codex::fetch_with_token`.

use super::super::providers::codex::fetch_with_token;
use super::super::{AcpQuotaProvider, AgentUsage};
use serde::Deserialize;
use std::fs;

const AUTH_PATH: &str = ".codex/auth.json";

#[derive(Debug, Deserialize)]
struct AuthFile {
    tokens: Option<TokensBlock>,
}

#[derive(Debug, Deserialize)]
struct TokensBlock {
    access_token: Option<String>,
}

pub struct CodexProvider;

impl AcpQuotaProvider for CodexProvider {
    fn provider_id(&self) -> &str {
        "codex"
    }

    fn quota_id(&self, _model: Option<&str>) -> String {
        "codex".to_string()
    }

    fn fetch_usage(&self, _model: Option<&str>) -> Result<AgentUsage, String> {
        let token = read_access_token()?;
        fetch_with_token(&token)
    }
}

fn read_access_token() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    let path = home.join(AUTH_PATH);
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {:?}: {}", path, e))?;
    let auth: AuthFile =
        serde_json::from_str(&raw).map_err(|e| format!("parse auth.json: {}", e))?;
    let token = auth
        .tokens
        .and_then(|t| t.access_token)
        .ok_or("missing tokens.access_token")?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err("empty access_token".into());
    }
    Ok(token)
}
