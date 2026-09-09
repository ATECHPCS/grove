//! Agent Voice synthesis and connected-session delivery.
//!
//! The shared runtime only understands Grove providers and Speaking Profiles.
//! Vendor request shapes are isolated behind `SpeakingProviderAdapter`.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, RwLock};

use base64::Engine;
use once_cell::sync::Lazy;
use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;

use crate::storage::ai::{ProviderProfile, SpeakingProfile};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceClientEvent {
    AgentVoiceAudio {
        request_id: String,
        chat_id: String,
        profile_id: String,
        profile_name: String,
        mime_type: String,
        audio_base64: String,
        max_duration_seconds: u32,
    },
    AgentVoiceError {
        request_id: String,
        chat_id: String,
        message: String,
    },
}

#[derive(Clone)]
struct SessionRegistration {
    enabled: bool,
    profile_id: Option<String>,
}

static SESSION_REGISTRY: Lazy<Arc<RwLock<HashMap<String, SessionRegistration>>>> =
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));
static VOICE_EVENTS: Lazy<broadcast::Sender<VoiceClientEvent>> = Lazy::new(|| {
    let (tx, _) = broadcast::channel(128);
    tx
});
/// Fair async mutex: accepted calls synthesize and reach the connected client
/// in receive order. The frontend then owns device-level FIFO playback.
static SPEAK_SYNTHESIS_QUEUE: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

pub fn register_session(chat_id: &str, enabled: bool, profile_id: Option<String>) {
    if let Ok(mut registry) = SESSION_REGISTRY.write() {
        registry.insert(
            chat_id.to_string(),
            SessionRegistration {
                enabled,
                profile_id,
            },
        );
    }
}

pub fn subscribe_events() -> broadcast::Receiver<VoiceClientEvent> {
    VOICE_EVENTS.subscribe()
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SpeakResult {
    /// Whether Grove accepted the voice request.
    pub success: bool,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SpeakInput {
    /// A short, standalone spoken touchpoint. The complete response remains in text.
    pub text: String,
}

/// Accept a voice side effect without coupling the Agent's MCP lifecycle to
/// provider latency or device playback. Once accepted, all subsequent failures
/// are reported to Grove's client channel rather than returned to the Agent.
pub fn speak(chat_id: &str, text: &str) -> SpeakResult {
    let request_id = uuid::Uuid::new_v4().to_string();
    let delivery_request_id = request_id.clone();
    let delivery_chat_id = chat_id.to_string();
    let delivery_text = text.to_string();
    tokio::spawn(async move {
        if let Err(message) =
            deliver_speech(&delivery_request_id, &delivery_chat_id, &delivery_text).await
        {
            report_delivery_error(&delivery_request_id, &delivery_chat_id, message);
        }
    });

    SpeakResult { success: true }
}

async fn deliver_speech(request_id: &str, chat_id: &str, text: &str) -> Result<(), String> {
    let registration = SESSION_REGISTRY
        .read()
        .ok()
        .and_then(|registry| registry.get(chat_id).cloned());
    let Some(registration) = registration else {
        return Err("Agent Voice has no connected client".to_string());
    };
    if !registration.enabled {
        return Err("Agent Voice is disabled for this Session".to_string());
    }
    let Some(profile_id) = registration.profile_id else {
        return Err("No Speaking Profile is selected".to_string());
    };
    let profile = match crate::storage::ai::get_speaking_profile(&profile_id) {
        Ok(Some(profile)) => profile,
        _ => return Err("Speaking Profile is unavailable".to_string()),
    };
    let character_count = text.chars().count();
    if character_count == 0 || character_count > profile.max_characters as usize {
        return Err(format!(
            "Speak text must contain 1 to {} characters; received {}",
            profile.max_characters, character_count
        ));
    }
    let Some(provider) = crate::storage::ai::get_provider(&profile.provider_id) else {
        return Err("Speaking Provider is unavailable".to_string());
    };
    if provider.status != "verified" {
        return Err("Speaking Provider is not connected".to_string());
    }

    let _queue_turn = SPEAK_SYNTHESIS_QUEUE.lock().await;
    // The Session may have been disabled or disconnected while this call was
    // waiting behind another voice. Re-check before spending provider credits.
    let still_enabled = SESSION_REGISTRY
        .read()
        .ok()
        .and_then(|registry| registry.get(chat_id).cloned())
        .is_some_and(|current| {
            current.enabled && current.profile_id.as_deref() == Some(profile_id.as_str())
        });
    if !still_enabled {
        return Err("Agent Voice was disabled before synthesis began".to_string());
    }

    let profile_for_synthesis = profile.clone();
    let provider_for_synthesis = provider.clone();
    let text_for_synthesis = text.to_string();
    let synthesis = tokio::task::spawn_blocking(move || {
        adapter_for(&provider_for_synthesis)?.synthesize(
            &provider_for_synthesis,
            &profile_for_synthesis,
            &text_for_synthesis,
        )
    })
    .await;
    let (bytes, mime_type) = match synthesis {
        Ok(Ok(audio)) => audio,
        Ok(Err(error)) => return Err(error),
        Err(error) => return Err(format!("Speaking Provider task failed: {error}")),
    };

    let still_enabled_after_synthesis = SESSION_REGISTRY
        .read()
        .ok()
        .and_then(|registry| registry.get(chat_id).cloned())
        .is_some_and(|current| {
            current.enabled && current.profile_id.as_deref() == Some(profile_id.as_str())
        });
    if !still_enabled_after_synthesis {
        return Err("Agent Voice was disabled before audio delivery".to_string());
    }

    let event = VoiceClientEvent::AgentVoiceAudio {
        request_id: request_id.to_string(),
        chat_id: chat_id.to_string(),
        profile_id: profile.id,
        profile_name: profile.name,
        mime_type,
        audio_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        max_duration_seconds: profile.max_duration_seconds,
    };
    let _ = VOICE_EVENTS.send(event);

    Ok(())
}

fn report_delivery_error(request_id: &str, chat_id: &str, message: String) {
    let registration = SESSION_REGISTRY
        .read()
        .ok()
        .and_then(|registry| registry.get(chat_id).cloned());
    if registration.is_some() {
        let _ = VOICE_EVENTS.send(VoiceClientEvent::AgentVoiceError {
            request_id: request_id.to_string(),
            chat_id: chat_id.to_string(),
            message,
        });
    } else {
        eprintln!("Agent Voice delivery failed for chat {chat_id}: {message}");
    }
}

pub fn session_instruction(enabled: bool, profile_id: Option<&str>) -> String {
    if !enabled {
        return "Agent Voice is disabled for this Session. Do not call the `speak` tool unless a later Session instruction enables it.".to_string();
    }
    let profile =
        profile_id.and_then(|id| crate::storage::ai::get_speaking_profile(id).ok().flatten());
    match profile {
        Some(profile) => enabled_session_instruction(&profile.name, profile.max_characters),
        None => "Agent Voice is enabled for this Session, but no valid Speaking Profile is selected. Do not call `speak` until a later Session instruction provides one.".to_string(),
    }
}

fn enabled_session_instruction(profile_name: &str, max_characters: u32) -> String {
    format!(
        "Agent Voice is enabled for this Session using the Speaking Profile \"{profile_name}\". Before completing every turn, you must call the `speak` tool exactly once with a concise, standalone spoken summary of that turn. This is required for every turn; do not skip it based on the length or nature of the response. Never read the full written response aloud. Keep `text` within {max_characters} characters. The complete response must still be provided in normal text."
    )
}

pub fn verify_provider(provider: &ProviderProfile) -> Result<(), String> {
    adapter_for(provider)?.verify(provider)
}

#[derive(Debug, Clone, Default)]
pub struct VoiceListOptions {
    pub search: Option<String>,
    pub voice_type: Option<String>,
    pub language: Option<String>,
    pub voice_id: Option<String>,
    pub next_page_token: Option<String>,
    pub page_size: u32,
}

pub fn list_voices(
    provider: &ProviderProfile,
    options: &VoiceListOptions,
) -> Result<serde_json::Value, String> {
    adapter_for(provider)?.list_voices(provider, options)
}

pub fn validate_profile(
    provider: &ProviderProfile,
    profile: &SpeakingProfile,
) -> Result<(), String> {
    adapter_for(provider)?.validate_profile(profile)
}

pub fn synthesize_preview(
    provider: &ProviderProfile,
    profile: &SpeakingProfile,
    text: &str,
) -> Result<(Vec<u8>, String), String> {
    adapter_for(provider)?.synthesize(provider, profile, text)
}

pub fn provider_schema(provider: &ProviderProfile) -> Result<serde_json::Value, String> {
    if let Some(schema) = crate::storage::ai::load_provider_capability_schema(&provider.id) {
        return Ok(schema);
    }
    adapter_for(provider)?.profile_schema(provider)
}

pub fn discover_provider_schema(provider: &ProviderProfile) -> Result<serde_json::Value, String> {
    adapter_for(provider)?.discover_profile_schema(provider)
}

pub fn supports_provider(provider: &ProviderProfile) -> bool {
    adapter_for(provider).is_ok()
}

trait SpeakingProviderAdapter: Send + Sync {
    fn profile_schema(&self, provider: &ProviderProfile) -> Result<serde_json::Value, String>;
    fn discover_profile_schema(
        &self,
        provider: &ProviderProfile,
    ) -> Result<serde_json::Value, String>;
    fn verify(&self, provider: &ProviderProfile) -> Result<(), String>;
    fn list_voices(
        &self,
        provider: &ProviderProfile,
        options: &VoiceListOptions,
    ) -> Result<serde_json::Value, String>;
    fn validate_profile(&self, profile: &SpeakingProfile) -> Result<(), String>;
    fn synthesize(
        &self,
        provider: &ProviderProfile,
        profile: &SpeakingProfile,
        text: &str,
    ) -> Result<(Vec<u8>, String), String>;
}

struct ElevenLabsAdapter;
static ELEVENLABS: ElevenLabsAdapter = ElevenLabsAdapter;

fn adapter_for(provider: &ProviderProfile) -> Result<&'static dyn SpeakingProviderAdapter, String> {
    match provider.provider_type.to_ascii_lowercase().as_str() {
        "elevenlabs" => Ok(&ELEVENLABS),
        other => Err(format!(
            "Provider type {other} does not support speech synthesis"
        )),
    }
}

impl ElevenLabsAdapter {
    fn api_url(provider: &ProviderProfile, path: &str) -> String {
        let base = provider.base_url.trim_end_matches('/');
        if base.ends_with("/v1") {
            format!("{base}/{path}")
        } else {
            format!("{base}/v1/{path}")
        }
    }

    fn checked_response(
        response: Result<ureq::Response, ureq::Error>,
    ) -> Result<ureq::Response, String> {
        match response {
            Ok(response) => Ok(response),
            Err(ureq::Error::Status(status, response)) => {
                let detail = response.into_string().unwrap_or_default();
                Err(format!("ElevenLabs returned HTTP {status}: {detail}"))
            }
            Err(error) => Err(format!("ElevenLabs request failed: {error}")),
        }
    }

    fn api_v2_url(provider: &ProviderProfile, path: &str) -> String {
        let base = provider.base_url.trim_end_matches('/');
        let base = base.strip_suffix("/v1").unwrap_or(base);
        format!("{base}/v2/{path}")
    }

    fn fallback_model_options() -> Vec<serde_json::Value> {
        vec![
            json!({
                "value": "eleven_v3",
                "label": "Eleven v3",
                "badge": "Expressive",
                "description": "Expressive multilingual speech with prompt-directed delivery.",
                "metadata": ["70+ languages"],
                "disabledFieldKeys": ["speed", "similarityBoost", "useSpeakerBoost"],
            }),
            json!({
                "value": "eleven_v3_conversational",
                "label": "Eleven v3 Conversational",
                "badge": "Expressive realtime",
                "description": "Expressive low-latency speech for realtime conversations.",
                "metadata": ["70+ languages"],
                "disabledFieldKeys": ["speed", "similarityBoost", "useSpeakerBoost"],
            }),
            json!({
                "value": "eleven_multilingual_v2",
                "label": "Multilingual v2",
                "badge": "Studio quality",
                "description": "Stable, lifelike multilingual speech for longer spoken updates.",
                "metadata": ["29 languages"],
                "disabledFieldKeys": [],
            }),
            json!({
                "value": "eleven_flash_v2_5",
                "label": "Flash v2.5",
                "badge": "Low latency",
                "description": "Fast multilingual synthesis for responsive Agent conversations.",
                "metadata": ["32 languages"],
                "disabledFieldKeys": [],
            }),
        ]
    }

    fn schema_with_models(
        provider: &ProviderProfile,
        model_options: Vec<serde_json::Value>,
    ) -> serde_json::Value {
        let default_model = model_options
            .iter()
            .find(|model| {
                !provider.model.trim().is_empty()
                    && model["value"].as_str() == Some(provider.model.as_str())
            })
            .or_else(|| {
                model_options
                    .iter()
                    .find(|model| model["value"] == "eleven_multilingual_v2")
            })
            .or_else(|| model_options.first())
            .and_then(|model| model["value"].as_str())
            .unwrap_or("eleven_multilingual_v2");
        json!({
            "providerType": "elevenlabs",
            "fields": [
                { "key": "voiceId", "label": "Voice", "description": "Voice available to this ElevenLabs account.", "type": "voice", "defaultValue": "", "required": true },
                { "key": "modelId", "label": "Model", "description": "Text-to-speech models available from this ElevenLabs account.", "type": "select", "defaultValue": default_model, "options": model_options },
                { "key": "speed", "label": "Speed", "description": "Playback pace without changing the selected voice.", "type": "range", "defaultValue": 1.0, "min": 0.7, "max": 1.2, "step": 0.05 },
                { "key": "stability", "label": "Stability", "description": "Higher values make delivery more consistent.", "type": "range", "defaultValue": 0.5, "min": 0.0, "max": 1.0, "step": 0.05 },
                { "key": "similarityBoost", "label": "Similarity", "description": "How closely output follows the original voice.", "type": "range", "defaultValue": 0.75, "min": 0.0, "max": 1.0, "step": 0.05 },
                { "key": "style", "label": "Style", "description": "Amplifies the speaking style of the source voice.", "type": "range", "defaultValue": 0.0, "min": 0.0, "max": 1.0, "step": 0.05 },
                { "key": "useSpeakerBoost", "label": "Speaker boost", "description": "Improves similarity at a small latency cost.", "type": "boolean", "defaultValue": true }
            ]
        })
    }

    fn model_options_from_response(response: &serde_json::Value) -> Vec<serde_json::Value> {
        response
            .as_array()
            .into_iter()
            .flatten()
            .filter(|model| {
                model
                    .get("can_do_text_to_speech")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
            })
            .filter_map(|model| {
                let model_id = model.get("model_id")?.as_str()?;
                let label = model
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(model_id);
                let description = model
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("ElevenLabs text-to-speech model.");
                let language_count = model
                    .get("languages")
                    .and_then(serde_json::Value::as_array)
                    .map_or(0, Vec::len);
                let metadata = if language_count > 0 {
                    vec![format!("{language_count} languages")]
                } else {
                    Vec::new()
                };
                let badge = if model_id == "eleven_v3_conversational" {
                    Some("Expressive realtime")
                } else if model_id == "eleven_v3" {
                    Some("Expressive")
                } else if model_id.contains("flash") {
                    Some("Low latency")
                } else if model_id.contains("multilingual") {
                    Some("Studio quality")
                } else {
                    None
                };
                let mut disabled_fields = Vec::new();
                if model_id.starts_with("eleven_v3") {
                    disabled_fields.extend(["speed", "similarityBoost", "useSpeakerBoost"]);
                } else {
                    if model
                        .get("can_use_style")
                        .and_then(serde_json::Value::as_bool)
                        == Some(false)
                    {
                        disabled_fields.push("style");
                    }
                    if model
                        .get("can_use_speaker_boost")
                        .and_then(serde_json::Value::as_bool)
                        == Some(false)
                    {
                        disabled_fields.push("useSpeakerBoost");
                    }
                }
                let mut option = serde_json::Map::from_iter([
                    ("value".to_string(), json!(model_id)),
                    ("label".to_string(), json!(label)),
                    ("description".to_string(), json!(description)),
                    ("metadata".to_string(), json!(metadata)),
                    ("disabledFieldKeys".to_string(), json!(disabled_fields)),
                ]);
                if let Some(badge) = badge {
                    option.insert("badge".to_string(), json!(badge));
                }
                Some(serde_json::Value::Object(option))
            })
            .collect()
    }

    fn discover_model_options(
        &self,
        provider: &ProviderProfile,
    ) -> Result<Vec<serde_json::Value>, String> {
        let response = Self::checked_response(
            ureq::get(&Self::api_url(provider, "models"))
                .set("xi-api-key", &provider.api_key)
                .timeout(std::time::Duration::from_secs(10))
                .call(),
        )?
        .into_json::<serde_json::Value>()
        .map_err(|error| format!("Invalid ElevenLabs models response: {error}"))?;
        let models = Self::model_options_from_response(&response);
        if models.is_empty() {
            return Err("ElevenLabs returned no text-to-speech models".to_string());
        }
        Ok(models)
    }
}

impl SpeakingProviderAdapter for ElevenLabsAdapter {
    fn profile_schema(&self, provider: &ProviderProfile) -> Result<serde_json::Value, String> {
        // Profile controls are adapter capabilities, not account data. Keep
        // them local so opening a saved profile never waits on ElevenLabs.
        Ok(Self::schema_with_models(
            provider,
            Self::fallback_model_options(),
        ))
    }

    fn discover_profile_schema(
        &self,
        provider: &ProviderProfile,
    ) -> Result<serde_json::Value, String> {
        Ok(Self::schema_with_models(
            provider,
            self.discover_model_options(provider)?,
        ))
    }

    fn verify(&self, provider: &ProviderProfile) -> Result<(), String> {
        let mut url = url::Url::parse(&Self::api_v2_url(provider, "voices"))
            .map_err(|error| format!("Invalid ElevenLabs URL: {error}"))?;
        url.query_pairs_mut()
            .append_pair("page_size", "1")
            .append_pair("include_total_count", "false");
        Self::checked_response(
            ureq::get(url.as_str())
                .set("xi-api-key", &provider.api_key)
                .timeout(std::time::Duration::from_secs(10))
                .call(),
        )?;
        Ok(())
    }

    fn list_voices(
        &self,
        provider: &ProviderProfile,
        options: &VoiceListOptions,
    ) -> Result<serde_json::Value, String> {
        let mut url = url::Url::parse(&Self::api_v2_url(provider, "voices"))
            .map_err(|error| format!("Invalid ElevenLabs URL: {error}"))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("page_size", &options.page_size.clamp(1, 100).to_string())
                .append_pair("include_total_count", "true")
                .append_pair("sort", "name")
                .append_pair("sort_direction", "asc");
            if let Some(value) = options.search.as_deref().filter(|value| !value.is_empty()) {
                query.append_pair("search", value);
            }
            if let Some(value) = options
                .voice_type
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                query.append_pair("voice_type", value);
            }
            if let Some(value) = options
                .language
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                query.append_pair("language", value);
            }
            if let Some(value) = options
                .voice_id
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                query.append_pair("voice_ids", value);
            }
            if let Some(value) = options
                .next_page_token
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                query.append_pair("next_page_token", value);
            }
        }
        let response = Self::checked_response(
            ureq::get(url.as_str())
                .set("xi-api-key", &provider.api_key)
                .timeout(std::time::Duration::from_secs(15))
                .call(),
        )?;
        let page = response
            .into_json::<serde_json::Value>()
            .map_err(|error| format!("Invalid ElevenLabs voices response: {error}"))?;
        let voices = page
            .get("voices")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|voice| {
                let voice_id = voice.get("voice_id")?.as_str()?;
                let labels = voice.get("labels").and_then(serde_json::Value::as_object);
                let sharing = voice.get("sharing").and_then(serde_json::Value::as_object);
                let category = voice.get("category").and_then(serde_json::Value::as_str);
                let source = if voice.get("is_owner").and_then(serde_json::Value::as_bool) == Some(true) {
                    "Personal"
                } else if voice.get("is_bookmarked").and_then(serde_json::Value::as_bool) == Some(true)
                    || sharing.and_then(|value| value.get("status")).and_then(serde_json::Value::as_str) == Some("copied")
                {
                    "Saved"
                } else if category == Some("premade") {
                    "Default"
                } else {
                    "Workspace"
                };
                Some(json!({
                    "voiceId": voice_id,
                    "name": voice.get("name").and_then(serde_json::Value::as_str).unwrap_or("Untitled Voice"),
                    "category": category,
                    "description": voice.get("description").and_then(serde_json::Value::as_str),
                    "previewUrl": voice.get("preview_url").and_then(serde_json::Value::as_str),
                    "language": labels.and_then(|value| value.get("language")).and_then(serde_json::Value::as_str),
                    "locale": labels.and_then(|value| value.get("locale")).and_then(serde_json::Value::as_str),
                    "accent": labels.and_then(|value| value.get("accent")).and_then(serde_json::Value::as_str),
                    "gender": labels.and_then(|value| value.get("gender")).and_then(serde_json::Value::as_str),
                    "age": labels.and_then(|value| value.get("age")).and_then(serde_json::Value::as_str),
                    "useCase": labels.and_then(|value| value.get("use_case")).and_then(serde_json::Value::as_str),
                    "supportedModelIds": voice.get("high_quality_base_model_ids").and_then(serde_json::Value::as_array),
                    "source": source,
                }))
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "voices": voices,
            "hasMore": page.get("has_more").and_then(serde_json::Value::as_bool).unwrap_or(false),
            "nextPageToken": page.get("next_page_token").and_then(serde_json::Value::as_str),
            "totalCount": page.get("total_count").and_then(serde_json::Value::as_u64),
        }))
    }

    fn validate_profile(&self, profile: &SpeakingProfile) -> Result<(), String> {
        let voice_id = profile
            .config
            .get("voiceId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim();
        if voice_id.is_empty() {
            return Err("ElevenLabs Speaking Profiles require a voice".to_string());
        }
        for (key, min, max) in [
            ("stability", 0.0, 1.0),
            ("similarityBoost", 0.0, 1.0),
            ("style", 0.0, 1.0),
            ("speed", 0.7, 1.2),
        ] {
            if let Some(value) = profile.config.get(key).and_then(serde_json::Value::as_f64) {
                if !(min..=max).contains(&value) {
                    return Err(format!("ElevenLabs {key} must be between {min} and {max}"));
                }
            }
        }
        Ok(())
    }

    fn synthesize(
        &self,
        provider: &ProviderProfile,
        profile: &SpeakingProfile,
        text: &str,
    ) -> Result<(Vec<u8>, String), String> {
        self.validate_profile(profile)?;
        let voice_id = profile
            .config
            .get("voiceId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or("Speaking Profile has no ElevenLabs voice")?;
        let model_id = profile
            .config
            .get("modelId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| {
                if provider.model.trim().is_empty() {
                    "eleven_multilingual_v2"
                } else {
                    provider.model.as_str()
                }
            });
        let number = |key: &str, fallback: f64| {
            profile
                .config
                .get(key)
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(fallback)
        };
        let body = json!({
            "text": text,
            "model_id": model_id,
            "voice_settings": {
                "stability": number("stability", 0.5),
                "similarity_boost": number("similarityBoost", 0.75),
                "style": number("style", 0.0),
                "use_speaker_boost": profile.config.get("useSpeakerBoost").and_then(serde_json::Value::as_bool).unwrap_or(true),
                "speed": number("speed", 1.0)
            }
        });
        let url = Self::api_url(provider, &format!("text-to-speech/{voice_id}"));
        let response = Self::checked_response(
            ureq::post(&url)
                .set("xi-api-key", &provider.api_key)
                .set("Accept", "audio/mpeg")
                .timeout(std::time::Duration::from_secs(45))
                .send_json(body),
        )?;
        let mime_type = response
            .header("content-type")
            .unwrap_or("audio/mpeg")
            .split(';')
            .next()
            .unwrap_or("audio/mpeg")
            .to_string();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Failed to read ElevenLabs audio: {error}"))?;
        if bytes.is_empty() {
            return Err("ElevenLabs returned empty audio".to_string());
        }
        Ok((bytes, mime_type))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn next_voice_event_for(
        receiver: &mut tokio::sync::broadcast::Receiver<VoiceClientEvent>,
        expected_chat_id: &str,
    ) -> VoiceClientEvent {
        loop {
            let event = receiver.recv().await.expect("voice event");
            let chat_id = match &event {
                VoiceClientEvent::AgentVoiceAudio { chat_id, .. }
                | VoiceClientEvent::AgentVoiceError { chat_id, .. } => chat_id,
            };
            if chat_id == expected_chat_id {
                return event;
            }
        }
    }

    fn fake_elevenlabs_once(expected_text: &'static str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake ElevenLabs");
        let address = listener.local_addr().expect("fake ElevenLabs address");
        let server = std::thread::spawn(move || {
            use std::io::{Read as _, Write as _};

            let (mut stream, _) = listener.accept().expect("accept synthesis request");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .expect("set read timeout");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let count = stream.read(&mut chunk).expect("read synthesis request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                let Some(header_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }

            let request_text = String::from_utf8(request).expect("request is utf-8");
            assert!(request_text.starts_with("POST /v1/text-to-speech/voice-123 "));
            assert!(request_text
                .to_ascii_lowercase()
                .contains("xi-api-key: test-key"));
            let (_, body) = request_text.split_once("\r\n\r\n").expect("request body");
            let body: serde_json::Value = serde_json::from_str(body).expect("json request body");
            assert_eq!(body["text"], expected_text);
            assert_eq!(body["model_id"], "eleven_flash_v2_5");
            assert_eq!(body["voice_settings"]["speed"], 1.1);

            let audio = b"fake-mp3-audio";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                audio.len()
            )
            .expect("write response headers");
            stream.write_all(audio).expect("write response audio");
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn api_url_accepts_base_with_or_without_v1() {
        let mut provider = ProviderProfile {
            id: "p".into(),
            name: "ElevenLabs".into(),
            provider_type: "ElevenLabs".into(),
            base_url: "https://api.elevenlabs.io".into(),
            api_key: "key".into(),
            model: String::new(),
            status: "draft".into(),
        };
        assert_eq!(
            ElevenLabsAdapter::api_url(&provider, "voices"),
            "https://api.elevenlabs.io/v1/voices"
        );
        provider.base_url.push_str("/v1");
        assert_eq!(
            ElevenLabsAdapter::api_url(&provider, "voices"),
            "https://api.elevenlabs.io/v1/voices"
        );
    }

    #[test]
    fn disabled_instruction_is_explicit() {
        let instruction = session_instruction(false, None);
        assert!(instruction.contains("disabled for this Session"));
        assert!(instruction.contains("Do not call"));
    }

    #[test]
    fn enabled_instruction_requires_speech_on_every_turn() {
        let instruction = enabled_session_instruction("Alice", 280);
        assert!(instruction.contains("Before completing every turn"));
        assert!(instruction.contains("must call the `speak` tool exactly once"));
        assert!(instruction.contains("required for every turn"));
        assert!(instruction.contains("within 280 characters"));
    }

    #[test]
    fn elevenlabs_profile_schema_is_adapter_owned() {
        let provider = ProviderProfile {
            id: "p".into(),
            name: "ElevenLabs".into(),
            provider_type: "ElevenLabs".into(),
            base_url: "https://api.elevenlabs.io".into(),
            api_key: "test-key".into(),
            model: String::new(),
            status: "draft".into(),
        };
        let schema = provider_schema(&provider).expect("schema");
        assert_eq!(schema["providerType"], "elevenlabs");
        let fields = schema["fields"].as_array().expect("fields");
        assert!(fields.iter().any(|field| field["key"] == "voiceId"));
        assert!(fields.iter().any(|field| field["key"] == "speed"));
        let models = fields
            .iter()
            .find(|field| field["key"] == "modelId")
            .and_then(|field| field["options"].as_array())
            .expect("model options");
        assert!(models.iter().any(|model| model["value"] == "eleven_v3"));
        let expressive = models
            .iter()
            .find(|model| model["value"] == "eleven_v3")
            .expect("Eleven v3 fallback");
        assert!(expressive["disabledFieldKeys"]
            .as_array()
            .expect("disabled fields")
            .iter()
            .any(|field| field == "speed"));
    }

    #[test]
    fn elevenlabs_profile_schema_does_not_require_network_access() {
        let provider = ProviderProfile {
            id: "p".into(),
            name: "ElevenLabs".into(),
            provider_type: "ElevenLabs".into(),
            base_url: "http://127.0.0.1:1".into(),
            api_key: "restricted-key".into(),
            model: String::new(),
            status: "verified".into(),
        };

        let schema = provider_schema(&provider).expect("fallback schema");
        let models = schema["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .find(|field| field["key"] == "modelId")
            .and_then(|field| field["options"].as_array())
            .expect("fallback models");

        assert!(models.iter().any(|model| model["value"] == "eleven_v3"));
        assert!(models
            .iter()
            .any(|model| model["value"] == "eleven_multilingual_v2"));
    }

    #[test]
    fn elevenlabs_discovery_keeps_only_text_to_speech_models() {
        let response = json!([
            {
                "model_id": "eleven_v3_conversational",
                "name": "Eleven v3 Conversational",
                "description": "Realtime expressive speech",
                "can_do_text_to_speech": true,
                "can_use_style": true,
                "can_use_speaker_boost": false,
                "languages": [{ "language_id": "en" }, { "language_id": "zh" }]
            },
            {
                "model_id": "scribe_v1",
                "name": "Scribe",
                "can_do_text_to_speech": false,
                "languages": []
            }
        ]);

        let models = ElevenLabsAdapter::model_options_from_response(&response);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["value"], "eleven_v3_conversational");
        assert_eq!(models[0]["metadata"], json!(["2 languages"]));
        assert!(models[0]["disabledFieldKeys"]
            .as_array()
            .expect("disabled fields")
            .iter()
            .any(|field| field == "speed"));
    }

    #[tokio::test]
    async fn speak_without_connected_client_is_still_accepted_by_mcp() {
        let output = speak("missing-chat", "Short update");
        assert!(output.success);
    }

    #[tokio::test]
    async fn disabled_session_reports_failure_out_of_band() {
        let mut rx = subscribe_events();
        register_session("disabled-chat", false, None);

        let output = speak("disabled-chat", "Short update");

        assert!(output.success);
        let event = next_voice_event_for(&mut rx, "disabled-chat").await;
        assert!(matches!(
            event,
            VoiceClientEvent::AgentVoiceError { message, .. }
                if message.contains("disabled")
        ));
    }

    #[tokio::test]
    async fn enabled_session_without_profile_reports_failure_out_of_band() {
        let mut rx = subscribe_events();
        register_session("profileless-chat", true, None);

        let output = speak("profileless-chat", "Short update");

        assert!(output.success);
        let event = next_voice_event_for(&mut rx, "profileless-chat").await;
        assert!(matches!(
            event,
            VoiceClientEvent::AgentVoiceError { message, .. }
                if message.contains("No Speaking Profile")
        ));
    }

    #[tokio::test]
    async fn enabled_session_synthesizes_and_delivers_audio_to_its_connected_client() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().expect("tempdir");
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let (base_url, server) = fake_elevenlabs_once("Short update");
        let chat_id = format!("voice-chat-{}", uuid::Uuid::new_v4());

        crate::storage::ai::save_providers(&crate::storage::ai::ProvidersData {
            providers: vec![ProviderProfile {
                id: "eleven".into(),
                name: "ElevenLabs".into(),
                provider_type: "ElevenLabs".into(),
                base_url,
                api_key: "test-key".into(),
                model: String::new(),
                status: "verified".into(),
            }],
        })
        .expect("save provider");
        crate::storage::ai::save_speaking_profile(&SpeakingProfile {
            id: "narrator".into(),
            name: "Narrator".into(),
            provider_id: "eleven".into(),
            config: json!({
                "voiceId": "voice-123",
                "modelId": "eleven_flash_v2_5",
                "speed": 1.1,
            }),
            max_characters: 80,
            max_duration_seconds: 12,
        })
        .expect("save Speaking Profile");
        let mut rx = subscribe_events();
        register_session(&chat_id, true, Some("narrator".into()));

        let output = speak(&chat_id, "Short update");

        assert!(output.success);
        let event = next_voice_event_for(&mut rx, &chat_id).await;
        let VoiceClientEvent::AgentVoiceAudio {
            request_id,
            chat_id: delivered_chat_id,
            profile_id,
            profile_name,
            mime_type,
            audio_base64,
            max_duration_seconds,
        } = event
        else {
            panic!("expected audio event");
        };
        assert!(!request_id.is_empty());
        assert_eq!(delivered_chat_id, chat_id);
        assert_eq!(profile_id, "narrator");
        assert_eq!(profile_name, "Narrator");
        assert_eq!(mime_type, "audio/mpeg");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(audio_base64)
                .expect("decode delivered audio"),
            b"fake-mp3-audio"
        );
        assert_eq!(max_duration_seconds, 12);

        server.join().expect("fake ElevenLabs server");
        crate::storage::set_grove_dir_override(None);
    }
}
