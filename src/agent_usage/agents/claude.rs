//! Claude Code agent — credential resolution.
//!
//! Reads credentials from:
//!   1. macOS login keychain (`security find-generic-password`)
//!   2. `~/.claude/.credentials.json`
//!
//! Then delegates to `providers::claude::fetch_with_credentials`.

use super::super::providers::claude::{fetch_with_credentials, Credentials};
use super::super::AcpQuotaProvider;
use super::super::AgentUsage;
use serde::Deserialize;
use std::fs;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

const CREDENTIALS_PATH: &str = ".claude/.credentials.json";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const REQUIRED_SCOPE: &str = "user:profile";

#[derive(Debug, Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OAuthBlock>,
}

#[derive(Debug, Deserialize)]
struct OAuthBlock {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier_camel: Option<String>,
    #[serde(rename = "rate_limit_tier", default)]
    rate_limit_tier_snake: Option<String>,
    #[serde(rename = "subscriptionType", default)]
    subscription_type_camel: Option<String>,
    #[serde(rename = "subscription_type", default)]
    subscription_type_snake: Option<String>,
}

impl OAuthBlock {
    fn rate_limit_tier(&self) -> Option<&str> {
        self.rate_limit_tier_camel
            .as_deref()
            .or(self.rate_limit_tier_snake.as_deref())
    }
    fn subscription_type(&self) -> Option<&str> {
        self.subscription_type_camel
            .as_deref()
            .or(self.subscription_type_snake.as_deref())
    }
}

pub struct ClaudeProvider;

impl AcpQuotaProvider for ClaudeProvider {
    fn provider_id(&self) -> &str {
        "claude"
    }

    fn quota_id(&self, _model: Option<&str>) -> String {
        "claude".to_string()
    }

    fn fetch_usage(&self, _model: Option<&str>) -> Result<AgentUsage, String> {
        let creds = read_credentials()?;
        fetch_with_credentials(&creds)
    }
}

fn read_credentials() -> Result<Credentials, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(value) = read_keychain_password(KEYCHAIN_SERVICE) {
            if let Some(c) = parse_credential_text(&value) {
                return Ok(c);
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let path = home.join(CREDENTIALS_PATH);
        if path.exists() {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Some(c) = parse_credential_text(&text) {
                    return Ok(c);
                }
            }
        }
    }

    Err("Claude credentials not found (file or keychain)".into())
}

fn parse_credential_text(text: &str) -> Option<Credentials> {
    let parsed: CredentialsFile = serde_json::from_str(text)
        .ok()
        .or_else(|| try_decode_hex_json(text))?;
    let oauth = parsed.claude_ai_oauth?;
    let raw_token = oauth.access_token.as_deref().unwrap_or("").trim();
    if raw_token.is_empty() {
        return None;
    }
    let access_token = normalize_bearer(raw_token);
    if !oauth.scopes.iter().any(|s| s == REQUIRED_SCOPE) {
        return None;
    }
    Some(Credentials {
        access_token,
        rate_limit_tier: oauth.rate_limit_tier().map(|s| s.to_string()),
        subscription_type: oauth.subscription_type().map(|s| s.to_string()),
    })
}

fn normalize_bearer(token: &str) -> String {
    let t = token.trim();
    if t.len() >= 7 && t[..7].eq_ignore_ascii_case("bearer ") {
        t[7..].trim().to_string()
    } else {
        t.to_string()
    }
}

fn try_decode_hex_json(text: &str) -> Option<CredentialsFile> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return None; // already plain JSON, don't re-try
    }
    let bytes: Vec<u8> = (0..trimmed.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&trimmed[i..i + 2], 16))
        .collect::<Result<_, _>>()
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(target_os = "macos")]
fn read_keychain_password(service: &str) -> Option<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            service,
            "-w", // print only the password
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}
