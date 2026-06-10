//! Credential reader for Hermes' `~/.hermes/auth.json`.
//!
//! Hermes stores provider credentials in a `credential_pool` map keyed by
//! provider name. Each entry lists one or more credential objects; the actual
//! secret is NOT stored in the file — instead `source` names where to find it:
//!
//!   `"env:VAR_NAME"` → `std::env::var("VAR_NAME")`
//!
//! Multiple credentials for the same provider are sorted by `priority`
//! (descending) and the first that resolves successfully is returned.

use serde::Deserialize;
use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const AUTH_SUBPATH: &str = ".hermes/auth.json";

#[derive(Debug, Deserialize)]
struct Credential {
    source: Option<String>,
    priority: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct HermesAuth {
    credential_pool: Option<HashMap<String, Vec<Credential>>>,
}

fn auth_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(AUTH_SUBPATH))
}

/// Resolve the token for `provider_key` from Hermes' auth.json.
///
/// Returns `None` if the file is missing, unreadable, the key is absent, or
/// none of the credentials can be resolved to a non-empty string.
pub fn read_hermes_token(provider_key: &str) -> Option<String> {
    let path = auth_path()?;
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let parsed: HermesAuth = serde_json::from_str(&raw).ok()?;
    let mut credentials = parsed.credential_pool?.remove(provider_key)?;

    // Higher priority value = preferred credential.
    credentials.sort_by_key(|c| Reverse(c.priority.unwrap_or(0)));

    for cred in credentials {
        if let Some(source) = cred.source {
            if let Some(var_name) = source.strip_prefix("env:") {
                let var_name = var_name.trim();
                // Try the process environment first (e.g. when launched from terminal).
                if let Ok(val) = std::env::var(var_name) {
                    let trimmed = val.trim().to_string();
                    if !trimmed.is_empty() {
                        return Some(trimmed);
                    }
                }
                // Fall back to ~/.hermes/.env (used when Grove is launched from
                // the Dock/IDE and doesn't inherit the user's shell environment).
                if let Some(val) = read_dotenv_var(var_name) {
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Parse `~/.hermes/.env` and return the value for `var_name`.
/// Handles `KEY=value` lines; ignores comments and blank lines.
fn read_dotenv_var(var_name: &str) -> Option<String> {
    let path = dirs::home_dir()?.join(".hermes/.env");
    let content = std::fs::read_to_string(path).ok()?;
    let prefix = format!("{}=", var_name);
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix(&prefix) {
            // Strip surrounding quotes if present ("value" or 'value').
            let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}
