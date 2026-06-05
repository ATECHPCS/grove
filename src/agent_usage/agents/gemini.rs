//! Gemini agent — credential resolution.
//!
//! Reads `~/.gemini/oauth_creds.json` for `access_token` + `id_token`,
//! validates the expiry guard, optionally rejects non-OAuth auth types from
//! `~/.gemini/settings.json`, then delegates to `providers::gemini::fetch_usage`.

use super::super::providers::gemini::fetch_usage;
use super::super::{AcpQuotaProvider, AgentUsage};
use serde::Deserialize;
use std::fs;

const SETTINGS_PATH: &str = ".gemini/settings.json";
const CREDS_PATH: &str = ".gemini/oauth_creds.json";

#[derive(Debug, Deserialize)]
struct SettingsFile {
    #[serde(rename = "authType")]
    auth_type: Option<String>,
    security: Option<SecurityBlock>,
}

#[derive(Debug, Deserialize)]
struct SecurityBlock {
    auth: Option<SecurityAuthBlock>,
}

#[derive(Debug, Deserialize)]
struct SecurityAuthBlock {
    #[serde(rename = "selectedType")]
    selected_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthCreds {
    access_token: Option<String>,
    id_token: Option<String>,
    expiry_date: Option<i64>,
}

pub struct GeminiProvider;

impl AcpQuotaProvider for GeminiProvider {
    fn provider_id(&self) -> &str {
        "gemini"
    }

    fn quota_id(&self, _model: Option<&str>) -> String {
        "gemini".to_string()
    }

    fn fetch_usage(&self, _model: Option<&str>) -> Result<AgentUsage, String> {
        let home = dirs::home_dir().ok_or("no home directory")?;

        // settings.json auth-type guard (best-effort; missing file → accept)
        let settings_path = home.join(SETTINGS_PATH);
        if settings_path.exists() {
            let raw = fs::read_to_string(&settings_path)
                .map_err(|e| format!("read settings.json: {}", e))?;
            let settings: SettingsFile =
                serde_json::from_str(&raw).map_err(|e| format!("parse settings.json: {}", e))?;
            let effective_auth = settings
                .security
                .as_ref()
                .and_then(|s| s.auth.as_ref())
                .and_then(|a| a.selected_type.as_deref())
                .or(settings.auth_type.as_deref())
                .unwrap_or("");
            if effective_auth == "api-key" || effective_auth == "vertex-ai" {
                return Err(format!("unsupported auth type: {}", effective_auth));
            }
        }

        // oauth_creds.json
        let creds_path = home.join(CREDS_PATH);
        let raw =
            fs::read_to_string(&creds_path).map_err(|e| format!("read {:?}: {}", creds_path, e))?;
        let creds: OAuthCreds =
            serde_json::from_str(&raw).map_err(|e| format!("parse oauth_creds.json: {}", e))?;
        let access_token = creds
            .access_token
            .as_deref()
            .ok_or("missing access_token")?
            .trim()
            .to_string();
        if access_token.is_empty() {
            return Err("empty access_token".into());
        }

        // Expiry guard — we do not refresh tokens
        if let Some(expiry_ms) = creds.expiry_date {
            if expiry_ms > 0 && expiry_ms < chrono::Utc::now().timestamp_millis() {
                return Err("access_token expired".into());
            }
        }

        fetch_usage(&access_token, creds.id_token.as_deref())
    }
}
