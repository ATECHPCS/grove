//! Kimi (Moonshot) usage quota fetcher.
//!
//! Reads the token from OpenCode's auth.json under the `kimi-for-coding`
//! entry, then calls `https://api.kimi.com/coding/v1/usages`. Even the
//! standalone Kimi ACP CLI shares login state with OpenCode.

use super::super::{
    clamp_percent, iso_to_seconds_remaining, AcpQuotaProvider, AgentUsage, ExtraInfo, UsageWindow,
    HTTP_TIMEOUT_KIMI,
};
use serde::Deserialize;

const USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
pub(crate) const OPENCODE_KEY: &str = "kimi-for-coding";

#[derive(Debug, Deserialize)]
struct UsageDetail {
    limit: serde_json::Value,
    used: serde_json::Value,
    remaining: serde_json::Value,
    #[serde(rename = "resetTime")]
    reset_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LimitWindow {
    duration: Option<u32>,
    #[serde(rename = "timeUnit")]
    time_unit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LimitEntry {
    window: LimitWindow,
    detail: UsageDetail,
}

#[derive(Debug, Deserialize)]
struct KimiResponse {
    usage: Option<UsageDetail>,
    limits: Option<Vec<LimitEntry>>,
}

pub struct KimiProvider;

impl AcpQuotaProvider for KimiProvider {
    fn provider_id(&self) -> &str {
        "kimi"
    }

    fn quota_id(&self, _model: Option<&str>) -> String {
        "kimi".to_string()
    }

    fn fetch_usage(&self, _model: Option<&str>) -> Result<AgentUsage, String> {
        let token = super::super::opencode_auth::read_opencode_token(OPENCODE_KEY)
            .ok_or("Kimi token not found")?;
        fetch_with_token(&token)
    }
}

pub(crate) fn fetch_with_token(token: &str) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT_KIMI).build();
    let resp = agent
        .get(USAGE_URL)
        .set(
            "Authorization",
            &format!("Bearer {}", normalize_bearer(token)),
        )
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;
    let body: KimiResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    let main = body.usage.ok_or("missing usage field")?;
    let main_limit = to_i64(&main.limit).ok_or("usage.limit invalid")?;
    let main_used = to_i64(&main.used).ok_or("usage.used invalid")?;
    let main_remaining = to_i64(&main.remaining).ok_or("usage.remaining invalid")?;

    let mut usage = AgentUsage::new("kimi");
    usage.plan = Some("Kimi".to_string());

    // Skip the bucket entirely when the limit is non-positive — otherwise we'd
    // surface "0% remaining" and the UI would falsely warn the user is out of
    // quota when really we don't know the cap. The matching extras row is
    // gated below for the same reason.
    if main_limit > 0 {
        let main_pct = clamp_percent((main_remaining as f32 / main_limit as f32) * 100.0);
        usage.windows.push(UsageWindow {
            label: "Total".to_string(),
            percentage_remaining: main_pct,
            resets_at: main.reset_time.clone(),
            resets_in_seconds: main
                .reset_time
                .as_deref()
                .and_then(iso_to_seconds_remaining),
            // Kimi's main "Total" bucket is the monthly subscription quota.
            total_window_seconds: Some(30 * 86400),
        });
    }
    let main_total_pushed = main_limit > 0;

    if let Some(first) = body.limits.as_ref().and_then(|v| v.first()) {
        let d = &first.detail;
        if let (Some(limit), Some(used), Some(remaining)) =
            (to_i64(&d.limit), to_i64(&d.used), to_i64(&d.remaining))
        {
            let window_min = to_window_minutes(
                first.window.duration.unwrap_or(0),
                first.window.time_unit.as_deref().unwrap_or(""),
            );
            let label = if window_min >= 1440 && window_min.is_multiple_of(1440) {
                format!("{}d window", window_min / 1440)
            } else if window_min >= 60 && window_min.is_multiple_of(60) {
                format!("{}h window", window_min / 60)
            } else if window_min > 0 {
                format!("{}m window", window_min)
            } else {
                "Rate limit".to_string()
            };
            if limit > 0 {
                let pct = clamp_percent((remaining as f32 / limit as f32) * 100.0);
                usage.windows.push(UsageWindow {
                    label,
                    percentage_remaining: pct,
                    resets_at: d.reset_time.clone(),
                    resets_in_seconds: d.reset_time.as_deref().and_then(iso_to_seconds_remaining),
                    total_window_seconds: if window_min > 0 {
                        Some(i64::from(window_min) * 60)
                    } else {
                        None
                    },
                });
                usage.extras.push(ExtraInfo {
                    label: "Rate".to_string(),
                    value: format!("{}/{} used", used, limit),
                });
            }
        }
    }

    if main_total_pushed {
        usage.extras.push(ExtraInfo {
            label: "Total".to_string(),
            value: format!("{}/{} used", main_used, main_limit),
        });
    }

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

fn to_i64(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(n) = v.as_f64() {
        return Some(n as i64);
    }
    v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
}

fn to_window_minutes(duration: u32, time_unit: &str) -> u32 {
    match time_unit {
        "TIME_UNIT_HOUR" => duration * 60,
        "TIME_UNIT_DAY" => duration * 1440,
        _ => duration,
    }
}

/// Accept tokens written as either `Bearer eyJ…` or just `eyJ…` — strip the
/// prefix so we always emit one `Bearer` ourselves.
fn normalize_bearer(token: &str) -> String {
    let t = token.trim();
    if t.len() >= 7 && t[..7].eq_ignore_ascii_case("bearer ") {
        t[7..].trim().to_string()
    } else {
        t.to_string()
    }
}
