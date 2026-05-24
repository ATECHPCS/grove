//! Chrome Extension integration handlers for Axum.
//! Enables dynamic page sniffing, multi-port discovery, and browser tab queries.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use once_cell::sync::OnceCell;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

use crate::api::error::ApiError;
use crate::api::state::{ExtensionSession, EXTENSION_SESSION};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

// ─── Extension auth token ────────────────────────────────────────────────────
//
// The Chrome companion authenticates with the loopback WS endpoint using a
// shared secret persisted under `~/.grove/extension-token`. The file is
// created once at startup with permissions 0600 on POSIX. Users wire the
// token into the extension via the popup's Settings field; the extension
// then appends `?token=<token>` to the WS URL.
//
// This token gates which local processes can drive the user's authenticated
// browser. It is NOT a cross-machine credential — anyone with read access to
// the user's home directory already has it, but that's the same trust model
// the rest of `~/.grove/` lives under.

static EXTENSION_TOKEN: OnceCell<String> = OnceCell::new();
// Serializes read-or-create within a process so two concurrent
// `get_or_create_extension_token()` callers don't generate two UUIDs and
// race their writes. Cross-process races are mitigated by the atomic
// tmp+rename in `write_token_file` plus re-reading after we lose to
// another writer.
static TOKEN_INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn token_file_path() -> PathBuf {
    crate::storage::grove_dir().join("extension-token")
}

/// Public token path used by `grove extension token` / docs to tell the user
/// where to read the secret from.
pub fn extension_token_path() -> PathBuf {
    token_file_path()
}

/// Lazily generate (or load) the extension auth token. Reads from disk if
/// present and non-empty; otherwise generates a fresh UUID-v4 and persists
/// it with 0600 permissions on POSIX. Safe across threads and best-effort
/// safe across concurrent grove processes (atomic write + re-read).
pub fn get_or_create_extension_token() -> Result<String, String> {
    if let Some(t) = EXTENSION_TOKEN.get() {
        return Ok(t.clone());
    }
    let _guard = TOKEN_INIT_LOCK
        .lock()
        .map_err(|_| "token init lock poisoned")?;
    // Recheck after acquiring — another thread may have populated the cell
    // while we were waiting.
    if let Some(t) = EXTENSION_TOKEN.get() {
        return Ok(t.clone());
    }
    let path = token_file_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            let _ = EXTENSION_TOKEN.set(trimmed.to_string());
            return Ok(trimmed.to_string());
        }
    }
    // Generate fresh and atomically write. simple() drops the hyphens for a
    // clean 32-char hex string easier to copy/paste.
    let token = uuid::Uuid::new_v4().simple().to_string();
    write_token_file(&path, &token)?;
    // Cross-process race window: another grove may have just written its
    // own token between our read and write. Re-read after the write to
    // pick up whichever token actually landed on disk — that keeps every
    // process consistent with the file, even if it's not the value WE
    // generated.
    let final_token = match std::fs::read_to_string(&path) {
        Ok(c) => {
            let trimmed = c.trim();
            if trimmed.is_empty() {
                token
            } else {
                trimmed.to_string()
            }
        }
        Err(_) => token,
    };
    let _ = EXTENSION_TOKEN.set(final_token.clone());
    Ok(final_token)
}

fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("token path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    // Atomic write: write to a per-pid tmp file then rename. Concurrent
    // readers never observe a half-written file (truncate-then-write
    // would expose an empty file mid-write).
    let tmp = parent.join(format!(".extension-token.{}.tmp", std::process::id()));
    std::fs::write(&tmp, token).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // chmod the tmp before rename so the file is never world-readable
        // at any point.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {}", path.display(), e))?;
    Ok(())
}

/// REST endpoint: GET /api/v1/extension/tabs
/// Fetches all active browser tabs in real-time from the connected extension.
pub async fn get_extension_tabs() -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    // 1. Retrieve the active extension session
    let session_tx = {
        let session_guard = EXTENSION_SESSION
            .read()
            .map_err(|_| ApiError::internal("Internal server lock error"))?;
        if let Some(session) = &*session_guard {
            session.sender.clone()
        } else {
            return Err(ApiError::bad_request(
                "Browser extension is offline or not connected",
            ));
        }
    };

    // 2. Generate a unique request ID and set up a oneshot channel for the response
    let req_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();

    {
        let session_guard = EXTENSION_SESSION
            .read()
            .map_err(|_| ApiError::internal("Internal server lock error"))?;
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                pending.insert(req_id.clone(), tx);
            }
        } else {
            return Err(ApiError::bad_request(
                "Browser extension disconnected during request",
            ));
        }
    }

    // 3. Send the request to the extension via WebSocket
    let request_payload = json!({
        "type": "GET_ALL_TABS",
        "id": req_id.clone()
    });

    if session_tx.send(request_payload).is_err() {
        // Clean up on send failure
        cleanup_request(&req_id);
        return Err(ApiError::internal(
            "Failed to send query to browser extension",
        ));
    }

    // 4. Await the response with a timeout (1.5 seconds)
    match tokio::time::timeout(Duration::from_millis(1500), rx).await {
        Ok(Ok(response_data)) => Ok(Json(response_data)),
        Ok(Err(_)) => Err(ApiError::internal(
            "Extension connection severed while awaiting response",
        )),
        Err(_) => {
            // Clean up on timeout
            cleanup_request(&req_id);
            Err(ApiError::internal("Query to browser extension timed out"))
        }
    }
}

/// Helper to clean up any orphaned oneshot channels from the pending list (e.g. on timeouts)
fn cleanup_request(req_id: &str) {
    if let Ok(session_guard) = EXTENSION_SESSION.read() {
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                pending.remove(req_id);
            }
        }
    }
}

/// WebSocket Upgrade handler: GET /api/v1/extension/ws?token=<token>
///
/// The Chrome companion must include the shared token (from
/// `~/.grove/extension-token`) as a query parameter; otherwise the upgrade
/// is refused. This stops other local processes from impersonating the
/// extension and driving the user's authenticated browser.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let expected = match get_or_create_extension_token() {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("extension token bootstrap failed: {e}"),
            )
                .into_response();
        }
    };
    let provided = params.get("token").map(|s| s.as_str()).unwrap_or("");
    // Constant-time compare to avoid timing oracles. Tokens are short (32
    // hex chars); `eq` would still be fine in practice, but ct_eq is the
    // standard recommendation.
    if provided.len() != expected.len()
        || !constant_time_eq(provided.as_bytes(), expected.as_bytes())
    {
        return (
            StatusCode::UNAUTHORIZED,
            "invalid or missing extension token",
        )
            .into_response();
    }
    ws.on_upgrade(handle_ws)
}

/// Byte-by-byte equality with no early exit, for token comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

async fn handle_ws(socket: WebSocket) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<serde_json::Value>();

    // 1. Register the new session globally. Refuse if an extension is
    //    already connected — accepting a second connection would orphan
    //    the first one's `pending_requests` map and the previously-routed
    //    responses would arrive at a session that no longer knows about
    //    them.
    let session = ExtensionSession {
        sender: tx,
        pending_requests: std::sync::Mutex::new(HashMap::new()),
    };

    // Take the slot atomically. `std::sync::RwLockWriteGuard` is !Send, so the
    // guard must be dropped before any `.await` below — keep this block tight.
    // Recover from a poisoned lock rather than panicking (poisoning would
    // cascade across every subsequent WS upgrade attempt).
    let claimed = {
        let mut session_guard = match EXTENSION_SESSION.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if session_guard.is_some() {
            false
        } else {
            *session_guard = Some(session);
            true
        }
    };
    if !claimed {
        // Politely tell the second connection it's not welcome, then send a
        // clean Close frame so the client surfaces a normal close handshake
        // (1008 policy-violation) instead of treating the drop as 1006.
        let _ = ws_sender
            .send(Message::Text(
                "{\"type\":\"AUTH_ERROR\",\"error\":\"another extension instance is already connected\"}".into(),
            ))
            .await;
        let _ = ws_sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1008,
                reason: "another extension instance is already connected".into(),
            })))
            .await;
        return;
    }

    // 2. Spawn a background task to forward outbound payloads to the WebSocket
    let mut ws_write_task = tokio::spawn(async move {
        while let Some(msg_val) = rx.recv().await {
            let text_frame = Message::Text(msg_val.to_string().into());
            if ws_sender.send(text_frame).await.is_err() {
                break;
            }
        }
    });

    // 3. Main loop to process inbound text messages from the extension
    let mut ws_read_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_receiver.next().await {
            if let Ok(text) = message.to_text() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
                    if let Some(msg_type) = parsed.get("type").and_then(|v| v.as_str()) {
                        match msg_type {
                            "ALL_TABS_RESPONSE"
                            | "ACTIVE_TAB_RESPONSE"
                            | "PROXY_FETCH_RESPONSE"
                            | "BROWSER_OPEN_RESPONSE"
                            | "BROWSER_SNAPSHOT_RESPONSE"
                            | "BROWSER_INTERACT_RESPONSE"
                            | "BROWSER_EXTRACT_RESPONSE"
                            | "BROWSER_SCREENSHOT_RESPONSE" => {
                                if let Some(req_id) = parsed.get("id").and_then(|v| v.as_str()) {
                                    resolve_pending_request(
                                        req_id,
                                        parsed
                                            .get("data")
                                            .cloned()
                                            .unwrap_or(serde_json::Value::Null),
                                    );
                                }
                            }
                            "ping" => {
                                // Keep-alive heartbeat; nothing to do here, the
                                // mere fact that the WS is still readable is the
                                // signal we care about.
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    });

    // 4. Await termination of either task (read or write disconnect)
    tokio::select! {
        _ = &mut ws_write_task => {},
        _ = &mut ws_read_task => {},
    };

    // 5. Clean up session on disconnect. Take the session out FIRST, then
    //    drop the senders explicitly so any REST callers blocked on `rx.await`
    //    wake immediately with `RecvError` rather than waiting for their
    //    individual timeouts. Without this drain, every in-flight request
    //    has to time out independently (1.5s–5s each) when the extension
    //    disconnects.
    let removed = EXTENSION_SESSION.write().ok().and_then(|mut g| g.take());
    if let Some(session) = removed {
        if let Ok(mut pending) = session.pending_requests.lock() {
            pending.clear();
        }
    }
    ws_write_task.abort();
    ws_read_task.abort();
}

/// Resolves a pending REST thread's oneshot channel when the WS replies
fn resolve_pending_request(req_id: &str, data: serde_json::Value) {
    if let Ok(session_guard) = EXTENSION_SESSION.read() {
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                if let Some(tx) = pending.remove(req_id) {
                    let _ = tx.send(data);
                }
            }
        }
    }
}

/// Sends a request to the connected browser extension to fetch the title of a URL dynamically.
/// This runs in the browser context, preserving active cookie sessions (perfect for SSO internal sites).
///
/// Respects the master `browser_control.enabled` switch — when the user has
/// turned off "Allow AI Browser Action", we do NOT route fetches through the
/// extension (cookies / SSO state must not leak through a disabled feature).
pub async fn proxy_fetch_title(url: &str) -> Option<String> {
    if !crate::storage::config::load_config()
        .browser_control
        .enabled
    {
        return None;
    }
    // 1. Retrieve the active extension session
    let session_tx = {
        let session_guard = EXTENSION_SESSION.read().ok()?;
        if let Some(session) = &*session_guard {
            session.sender.clone()
        } else {
            return None;
        }
    };

    // 2. Generate a unique request ID and register it
    let req_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();

    {
        let session_guard = EXTENSION_SESSION.read().ok()?;
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                pending.insert(req_id.clone(), tx);
            } else {
                return None;
            }
        } else {
            return None;
        }
    }

    // 3. Send the request to the extension via WebSocket
    let request_payload = json!({
        "type": "PROXY_FETCH_TITLE",
        "id": req_id.clone(),
        "url": url
    });

    if session_tx.send(request_payload).is_err() {
        cleanup_request(&req_id);
        return None;
    }

    // 4. Await the response with a timeout (2.5 seconds)
    match tokio::time::timeout(Duration::from_millis(2500), rx).await {
        Ok(Ok(response_data)) => {
            // Extension returns { "url": "...", "title": "..." }
            if let Some(title) = response_data.get("title").and_then(|v| v.as_str()) {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            None
        }
        _ => {
            cleanup_request(&req_id);
            None
        }
    }
}

/// Dispatch a browser command to the connected Chrome Companion Extension
/// over WebSocket. All MCP browser tools + the REST /extension/command
/// endpoint funnel through here. Single critical section per call: we
/// grab the sender and register the pending oneshot under one `read()`
/// guard, then release before awaiting the response.
async fn send_extension_command(
    cmd_type: &str,
    payload: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let req_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();

    // Single guard scope: clone sender + insert pending entry atomically.
    let session_tx = {
        let session_guard = EXTENSION_SESSION.read().map_err(|_| "Server lock error")?;
        let Some(session) = &*session_guard else {
            return Err("Browser Companion Extension is offline or not connected".to_string());
        };
        let mut pending = session
            .pending_requests
            .lock()
            .map_err(|_| "Pending requests registry lock error")?;
        pending.insert(req_id.clone(), tx);
        session.sender.clone()
    };

    let mut request_payload = payload;
    if let Some(obj) = request_payload.as_object_mut() {
        obj.insert("type".to_string(), json!(cmd_type));
        obj.insert("id".to_string(), json!(req_id));
    } else {
        cleanup_request(&req_id);
        return Err("Payload must be a JSON object".to_string());
    }

    if session_tx.send(request_payload).is_err() {
        cleanup_request(&req_id);
        return Err("Failed to send command to Browser Companion Extension".to_string());
    }

    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(response_data)) => Ok(response_data),
        Ok(Err(_)) => Err("Extension connection severed while awaiting response".to_string()),
        Err(_) => {
            cleanup_request(&req_id);
            Err("Command query to Browser Companion Extension timed out".to_string())
        }
    }
}

/// REST endpoint POST /api/v1/extension/command
#[derive(Debug, serde::Deserialize)]
pub struct ExtensionCommandRequest {
    pub cmd_type: String,
    pub payload: serde_json::Value,
}

pub async fn handle_extension_command(
    Json(req): Json<ExtensionCommandRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    // Respect the master `browser_control.enabled` switch — without this gate
    // a REST caller can still drive the user's browser via the connected
    // extension even after the user has disabled "Allow AI Browser Action".
    if !crate::storage::config::load_config()
        .browser_control
        .enabled
    {
        return Err(ApiError::bad_request(
            "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
        ));
    }
    // Route through the same dispatcher the MCP tools use.
    match send_extension_command(&req.cmd_type, req.payload, 5000).await {
        Ok(res) => Ok(Json(res)),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// Opens a URL in the browser and automatically moves the tab into a project-scoped Chrome Tab Group
pub async fn browser_open(
    url: &str,
    group_name: Option<&str>,
) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_OPEN",
        json!({
            "url": url,
            "groupName": group_name
        }),
        3000,
    )
    .await
}

/// Takes a snapshot of a specific tab, generating an A11y Tree with unique reference tags (@e1, @e2).
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_snapshot(tab_id: u32) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_SNAPSHOT",
        json!({
            "tabId": tab_id,
        }),
        4000,
    )
    .await
}

/// Simulates interactive DOM gestures (click, fill, focus, check, etc.) via element reference tags (@e) or CSS selectors.
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_interact(
    tab_id: u32,
    action: &str,
    target: &str,
    value: Option<&str>,
) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_INTERACT",
        json!({
            "tabId": tab_id,
            "action": action,
            "target": target,
            "value": value
        }),
        3000,
    )
    .await
}

/// Extracts structured elements (innerText, outerHTML, value, URL, document title) from a specific tab.
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_extract(
    tab_id: u32,
    extract_type: &str,
    target: Option<&str>,
) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_EXTRACT",
        json!({
            "tabId": tab_id,
            "extractType": extract_type,
            "target": target
        }),
        3000,
    )
    .await
}

/// Captures a viewport-wide screenshot of a specific tab as a base64 PNG.
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_screenshot(tab_id: u32) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_SCREENSHOT",
        json!({
            "tabId": tab_id,
        }),
        5000,
    )
    .await
}
