//! Synthetic quota fetcher.
//!
//! Reads the token from OpenCode's auth.json under `synthetic`, calls
//! `https://api.synthetic.new/v2/quotas`. The response has three required
//! buckets: `subscription`, `search.hourly`, `freeToolCalls` — each carrying
//! `{limit, requests, renewsAt}` where `requests` is the count consumed so
//! far in the window. We expose all three as usage windows.

use super::super::{
    clamp_percent, iso_to_seconds_remaining, AgentUsage, ExtraInfo, UsageWindow,
    HTTP_TIMEOUT_SYNTHETIC,
};
use serde::Deserialize;

const USAGE_URL: &str = "https://api.synthetic.new/v2/quotas";

#[derive(Debug, Deserialize)]
struct Bucket {
    limit: Option<f64>,
    requests: Option<f64>,
    #[serde(rename = "renewsAt")]
    renews_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchBlock {
    hourly: Option<Bucket>,
}

#[derive(Debug, Deserialize)]
struct SyntheticResponse {
    subscription: Option<Bucket>,
    search: Option<SearchBlock>,
    #[serde(rename = "freeToolCalls")]
    free_tool_calls: Option<Bucket>,
}

pub(crate) fn fetch_with_token(token: &str) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT_SYNTHETIC)
        .build();
    let resp = agent
        .get(USAGE_URL)
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;
    let body: SyntheticResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    let subscription = body.subscription.ok_or("missing subscription bucket")?;
    let search_hourly = body
        .search
        .and_then(|s| s.hourly)
        .ok_or("missing search.hourly bucket")?;
    let free_tool_calls = body.free_tool_calls.ok_or("missing freeToolCalls bucket")?;

    let mut usage = AgentUsage::new("synthetic");
    usage.plan = Some("Synthetic".to_string());

    // Synthetic publishes three fixed-cadence buckets. Hard-code the windows
    // so the frontend can compute a safe-guard line.
    push_bucket(&mut usage, "Subscription", &subscription, Some(30 * 86400));
    push_bucket(&mut usage, "Search 1h", &search_hourly, Some(3600));
    push_bucket(&mut usage, "Free tools", &free_tool_calls, Some(86400));

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

fn push_bucket(usage: &mut AgentUsage, label: &str, b: &Bucket, total_window_seconds: Option<i64>) {
    let limit = b.limit.unwrap_or(0.0);
    let requests = b.requests.unwrap_or(0.0);
    let remaining = (limit - requests).max(0.0);
    let pct = if limit > 0.0 {
        clamp_percent(((remaining / limit) * 100.0) as f32)
    } else {
        0.0
    };
    usage.windows.push(UsageWindow {
        label: label.to_string(),
        percentage_remaining: pct,
        resets_at: b.renews_at.clone(),
        resets_in_seconds: b.renews_at.as_deref().and_then(iso_to_seconds_remaining),
        total_window_seconds,
    });
    usage.extras.push(ExtraInfo {
        label: label.to_string(),
        value: format!("{}/{} used", requests as i64, limit as i64),
    });
}
