//! Vellum-style Voice & Speech routes (TTS + STT).
//!
//! Four endpoints, all behind normal user authentication:
//!
//! - `GET  /api/voice/settings`   -> provider catalogs + non-secret settings,
//!   with per-provider `configured` and a masked `apiKeyHint` derived from the
//!   encrypted credential store.
//! - `PUT  /api/voice/settings`   -> update settings; API keys are written to
//!   [`crate::credentials`] (never to the settings file) and the updated
//!   `GET` payload is returned.
//! - `POST /api/tts/synthesize`   -> proxy text to the selected provider and
//!   stream the raw audio bytes back.
//! - `POST /api/stt/transcribe`   -> decode base64 audio, proxy it to the
//!   selected provider, and return `{ status, text, providerId }`.
//!
//! API keys are resolved from the request when supplied, otherwise from
//! `tts.<provider>/api_key` / `stt.<provider>/api_key`, otherwise from the
//! shared bare `<provider>/api_key` slot (so `openai/api_key`,
//! `deepgram/api_key`, ... configured elsewhere are reused automatically).

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::credentials;
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const SETTINGS_FILE: &str = "voice-settings.json";
const TTS_TIMEOUT: Duration = Duration::from_secs(60);
const STT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TTS_CHARS: usize = 8192;
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

fn bad_request(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.to_string())
}

fn settings_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join(SETTINGS_FILE)
}

// ---------------------------------------------------------------------------
// Provider catalogs
// ---------------------------------------------------------------------------

/// Text-to-speech providers offered by the UI.
pub fn tts_catalog() -> Vec<Value> {
    vec![
        json!({
            "id": "openai",
            "name": "OpenAI Speech",
            "displayName": "OpenAI Speech",
            "subtitle": "OpenAI TTS (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`) with natural voices.",
            "defaultModel": "tts-1",
            "defaultVoice": "alloy",
            "voices": ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"],
            "models": ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"],
            "supportsVoiceSelection": true,
            "supportsModelSelection": true,
            "supportsBaseUrl": true,
            "defaultBaseUrl": "https://api.openai.com/v1",
            "apiKeyPlaceholder": "sk-...",
            "docsUrl": "https://platform.openai.com/api-keys",
        }),
        json!({
            "id": "elevenlabs",
            "name": "ElevenLabs",
            "displayName": "ElevenLabs",
            "subtitle": "High-quality expressive voice synthesis for conversations and read-aloud.",
            "defaultModel": "eleven_turbo_v2_5",
            "defaultVoice": "EXAVITQu4vr4xnSDxMaL",
            "voices": ["EXAVITQu4vr4xnSDxMaL", "JBFqnCBsd6RMkjVDRZzb", "21m00Tcm4TlvDq8ikWAM", "AZnzlk1XvdvUeBnXmlld", "ErXwobaYiN019PkySvjV", "TxGEqnHWrfWFTfGW9XjX"],
            "models": ["eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_flash_v2_5"],
            "supportsVoiceSelection": true,
            "supportsModelSelection": true,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.elevenlabs.io",
            "apiKeyPlaceholder": "sk_...",
            "docsUrl": "https://elevenlabs.io/app/settings/api-keys",
        }),
        json!({
            "id": "deepgram",
            "name": "Deepgram Aura",
            "displayName": "Deepgram Aura",
            "subtitle": "Fast, low-latency text-to-speech synthesis. Shares key with Deepgram STT.",
            "defaultModel": "aura-2-thalia-en",
            "defaultVoice": "aura-2-thalia-en",
            "voices": ["aura-2-thalia-en", "aura-2-andromeda-en", "aura-2-apollo-en", "aura-asteria-en", "aura-orion-en"],
            "models": ["aura-2-thalia-en", "aura-2-andromeda-en", "aura-2-apollo-en", "aura-asteria-en"],
            "supportsVoiceSelection": true,
            "supportsModelSelection": true,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.deepgram.com",
            "apiKeyPlaceholder": "Enter your Deepgram API key",
            "docsUrl": "https://console.deepgram.com/",
        }),
        json!({
            "id": "fish-audio",
            "name": "Fish Audio",
            "displayName": "Fish Audio",
            "subtitle": "Natural-sounding voice synthesis with custom voice cloning reference IDs.",
            "defaultModel": "speech-1.5",
            "defaultVoice": "",
            "voices": [],
            "models": ["speech-1.5", "speech-1.6"],
            "supportsVoiceSelection": true,
            "supportsModelSelection": true,
            "supportsBaseUrl": true,
            "defaultBaseUrl": "https://api.fish.audio",
            "apiKeyPlaceholder": "Enter your Fish Audio API key",
            "docsUrl": "https://fish.audio/app/api-keys/",
        }),
        json!({
            "id": "xai",
            "name": "xAI Grok Voice",
            "displayName": "xAI Grok Voice",
            "subtitle": "Expressive text-to-speech from xAI (eve, ara, rex, sal, leo).",
            "defaultModel": "grok-tts",
            "defaultVoice": "eve",
            "voices": ["eve", "ara", "rex", "sal", "leo"],
            "models": ["grok-tts"],
            "supportsVoiceSelection": true,
            "supportsModelSelection": false,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.x.ai",
            "apiKeyPlaceholder": "xai-...",
            "docsUrl": "https://console.x.ai/",
        }),
        json!({
            "id": "custom-openai",
            "name": "Custom OpenAI-Compatible (9Router / LiteLLM)",
            "displayName": "Custom OpenAI-Compatible (9Router / LiteLLM)",
            "subtitle": "Any OpenAI-compatible `/v1/audio/speech` router such as 9Router, LiteLLM, LocalAI, or Kokoro.",
            "defaultModel": "tts-1",
            "defaultVoice": "alloy",
            "voices": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
            "models": ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"],
            "supportsVoiceSelection": true,
            "supportsModelSelection": true,
            "supportsBaseUrl": true,
            "requiresBaseUrl": true,
            "defaultBaseUrl": "http://localhost:20128/v1",
            "apiKeyPlaceholder": "sk-... or router key",
            "docsUrl": "https://platform.openai.com/docs/api-reference/audio/createSpeech",
        }),
        json!({
            "id": "browser-native",
            "name": "Browser Web Speech (Free / Offline)",
            "displayName": "Browser Web Speech (Free / Offline)",
            "subtitle": "Built-in browser SpeechSynthesis. Needs no API key.",
            "defaultModel": "browser",
            "defaultVoice": "default",
            "voices": ["default"],
            "models": ["browser"],
            "supportsVoiceSelection": false,
            "supportsModelSelection": false,
            "supportsBaseUrl": false,
            "keyless": true,
            "defaultBaseUrl": "",
            "apiKeyPlaceholder": "No API key required",
            "docsUrl": "",
        }),
    ]
}

/// Speech-to-text providers offered by the UI.
pub fn stt_catalog() -> Vec<Value> {
    vec![
        json!({
            "id": "deepgram",
            "name": "Deepgram Nova",
            "displayName": "Deepgram Nova",
            "subtitle": "Fast, accurate Nova-3 speech-to-text transcription.",
            "defaultModel": "nova-2",
            "models": ["nova-2", "nova-3", "whisper-large"],
            "supportsModelSelection": true,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.deepgram.com",
            "apiKeyPlaceholder": "Enter your Deepgram API key",
            "docsUrl": "https://console.deepgram.com/",
        }),
        json!({
            "id": "openai",
            "name": "OpenAI Whisper / GPT-4o Transcribe",
            "displayName": "OpenAI Whisper / GPT-4o Transcribe",
            "subtitle": "High-accuracy transcription via OpenAI `/v1/audio/transcriptions`.",
            "defaultModel": "whisper-1",
            "models": ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
            "supportsModelSelection": true,
            "supportsBaseUrl": true,
            "defaultBaseUrl": "https://api.openai.com/v1",
            "apiKeyPlaceholder": "sk-...",
            "docsUrl": "https://platform.openai.com/api-keys",
        }),
        json!({
            "id": "groq",
            "name": "Groq Whisper",
            "displayName": "Groq Whisper",
            "subtitle": "Ultra-fast Whisper Large v3 Turbo transcription on Groq LPUs.",
            "defaultModel": "whisper-large-v3-turbo",
            "models": ["whisper-large-v3-turbo", "whisper-large-v3", "distil-whisper-large-v3-en"],
            "supportsModelSelection": true,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.groq.com/openai/v1",
            "apiKeyPlaceholder": "gsk_...",
            "docsUrl": "https://console.groq.com/keys",
        }),
        json!({
            "id": "elevenlabs",
            "name": "ElevenLabs Scribe",
            "displayName": "ElevenLabs Scribe",
            "subtitle": "ElevenLabs Scribe v1 speech-to-text transcription.",
            "defaultModel": "scribe_v1",
            "models": ["scribe_v1"],
            "supportsModelSelection": true,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.elevenlabs.io",
            "apiKeyPlaceholder": "sk_...",
            "docsUrl": "https://elevenlabs.io/app/settings/api-keys",
        }),
        json!({
            "id": "xai",
            "name": "xAI Audio Transcription",
            "displayName": "xAI Audio Transcription",
            "subtitle": "Speech-to-text transcription powered by xAI.",
            "defaultModel": "grok-stt",
            "models": ["grok-stt", "whisper-1"],
            "supportsModelSelection": true,
            "supportsBaseUrl": false,
            "defaultBaseUrl": "https://api.x.ai/v1",
            "apiKeyPlaceholder": "xai-...",
            "docsUrl": "https://console.x.ai/",
        }),
        json!({
            "id": "custom-openai",
            "name": "Custom OpenAI-Compatible (9Router / LiteLLM / Whisper.cpp)",
            "displayName": "Custom OpenAI-Compatible (9Router / LiteLLM / Whisper.cpp)",
            "subtitle": "Any OpenAI-compatible `/v1/audio/transcriptions` endpoint such as 9Router, LiteLLM, or local Whisper.",
            "defaultModel": "whisper-1",
            "models": ["whisper-1", "gpt-4o-mini-transcribe", "whisper-large-v3"],
            "supportsModelSelection": true,
            "supportsBaseUrl": true,
            "requiresBaseUrl": true,
            "defaultBaseUrl": "http://localhost:20128/v1",
            "apiKeyPlaceholder": "sk-... or router key",
            "docsUrl": "https://platform.openai.com/docs/api-reference/audio/createTranscription",
        }),
        json!({
            "id": "browser-native",
            "name": "Browser Web Speech Recognition",
            "displayName": "Browser Web Speech Recognition",
            "subtitle": "Built-in browser SpeechRecognition API. Needs no API key.",
            "defaultModel": "browser",
            "models": ["browser"],
            "supportsModelSelection": false,
            "supportsBaseUrl": false,
            "keyless": true,
            "defaultBaseUrl": "",
            "apiKeyPlaceholder": "No API key required",
            "docsUrl": "",
        }),
    ]
}

fn spec_for(catalog: &[Value], id: &str) -> Option<Value> {
    catalog.iter().find(|spec| text(spec, "id") == id).cloned()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn is_keyless(spec: &Value) -> bool {
    spec.get("keyless").and_then(Value::as_bool).unwrap_or(false)
}

/// Providers whose bare `api_key` slot is shared with the rest of the app
/// (so an existing `openai/api_key` also powers voice).
fn is_shared(provider: &str) -> bool {
    matches!(
        provider,
        "openai" | "deepgram" | "elevenlabs" | "xai" | "groq" | "fish-audio" | "custom-openai"
    )
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

fn default_settings() -> Value {
    json!({
        "readAloudEnabled": true,
        "autoReadAloud": false,
        "ttsProvider": "browser-native",
        "sttProvider": "browser-native",
        "sttLanguage": "en",
        "ttsProviders": {},
        "sttProviders": {},
    })
}

pub(crate) async fn load_settings(state: &AppState) -> Result<Value, ApiError> {
    let stored = read_json(&settings_path(state), json!({})).await?;
    let mut settings = default_settings();
    if let (Some(base), Some(stored)) = (settings.as_object_mut(), stored.as_object()) {
        for (key, value) in stored {
            base.insert(key.clone(), value.clone());
        }
    }
    // Keep the provider maps as objects even if the file was hand-edited.
    for slot in ["ttsProviders", "sttProviders"] {
        if !settings[slot].is_object() {
            settings[slot] = json!({});
        }
    }
    Ok(settings)
}

/// Map of `service/field` -> masked hint for every stored credential.
async fn credential_hints(state: &AppState) -> BTreeMap<String, String> {
    let mut hints = BTreeMap::new();
    if let Ok(items) = credentials::list_metadata(state).await {
        for item in items {
            hints.insert(format!("{}/{}", item.service, item.field), item.hint);
        }
    }
    hints
}

fn hint_for(hints: &BTreeMap<String, String>, service: &str, fallback: &str) -> Option<String> {
    hints
        .get(&format!("{service}/api_key"))
        .or_else(|| hints.get(&format!("{fallback}/api_key")))
        .cloned()
}

fn has_key(hints: &BTreeMap<String, String>, service: &str, fallback: &str) -> bool {
    hints.contains_key(&format!("{service}/api_key"))
        || hints.contains_key(&format!("{fallback}/api_key"))
}

pub(crate) fn non_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn saved_config<'a>(settings: &'a Value, slot: &str, provider: &str) -> Option<&'a Value> {
    settings.get(slot).and_then(|map| map.get(provider))
}

fn build_settings_view(
    state_settings: &Value,
    hints: &BTreeMap<String, String>,
) -> (Map<String, Value>, Map<String, Value>) {
    let mut tts = Map::new();
    for spec in tts_catalog() {
        let id = text(&spec, "id").to_string();
        let saved = saved_config(state_settings, "ttsProviders", &id);
        let model = saved
            .and_then(|c| non_empty(c, "model"))
            .unwrap_or_else(|| text(&spec, "defaultModel"))
            .to_string();
        let voice = saved
            .and_then(|c| non_empty(c, "voiceId"))
            .or_else(|| saved.and_then(|c| c.get("voiceId")).and_then(Value::as_str))
            .unwrap_or_else(|| text(&spec, "defaultVoice"))
            .to_string();
        let base = saved
            .and_then(|c| non_empty(c, "baseUrl"))
            .unwrap_or_else(|| text(&spec, "defaultBaseUrl"))
            .to_string();
        let speed = saved
            .and_then(|c| c.get("speed"))
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        let requires_base = spec
            .get("requiresBaseUrl")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let configured = is_keyless(&spec)
            || (has_key(hints, &format!("tts.{id}"), &id) && (!requires_base || !base.trim().is_empty()));
        let hint = if is_keyless(&spec) {
            None
        } else {
            hint_for(hints, &format!("tts.{id}"), &id)
        };
        tts.insert(
            id,
            json!({
                "model": model,
                "voiceId": voice,
                "baseUrl": base,
                "speed": speed,
                "configured": configured,
                "apiKeyHint": hint,
            }),
        );
    }

    let mut stt = Map::new();
    for spec in stt_catalog() {
        let id = text(&spec, "id").to_string();
        let saved = saved_config(state_settings, "sttProviders", &id);
        let model = saved
            .and_then(|c| non_empty(c, "model"))
            .unwrap_or_else(|| text(&spec, "defaultModel"))
            .to_string();
        let base = saved
            .and_then(|c| non_empty(c, "baseUrl"))
            .unwrap_or_else(|| text(&spec, "defaultBaseUrl"))
            .to_string();
        let language = saved
            .and_then(|c| non_empty(c, "language"))
            .unwrap_or_else(|| text(state_settings, "sttLanguage"))
            .to_string();
        let requires_base = spec
            .get("requiresBaseUrl")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let configured = is_keyless(&spec)
            || (has_key(hints, &format!("stt.{id}"), &id) && (!requires_base || !base.trim().is_empty()));
        let hint = if is_keyless(&spec) {
            None
        } else {
            hint_for(hints, &format!("stt.{id}"), &id)
        };
        stt.insert(
            id,
            json!({
                "model": model,
                "baseUrl": base,
                "language": language,
                "configured": configured,
                "apiKeyHint": hint,
            }),
        );
    }

    (tts, stt)
}

async fn settings_payload(state: &AppState) -> Result<Value, ApiError> {
    let settings = load_settings(state).await?;
    let hints = credential_hints(state).await;
    let (tts, stt) = build_settings_view(&settings, &hints);
    let mut merged = settings;
    merged["ttsProviders"] = Value::Object(tts);
    merged["sttProviders"] = Value::Object(stt);
    Ok(json!({
        "ttsCatalog": tts_catalog(),
        "sttCatalog": stt_catalog(),
        "settings": merged,
    }))
}

// ---------------------------------------------------------------------------
// Handlers: settings
// ---------------------------------------------------------------------------

async fn get_settings(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(settings_payload(&state).await?))
}

enum CredOp {
    Set {
        service: String,
        value: String,
        label: String,
    },
    Delete {
        service: String,
    },
}

fn validate_provider(catalog: &[Value], provider: &str) -> Result<Value, ApiError> {
    spec_for(catalog, provider)
        .ok_or_else(|| bad_request(&format!("unknown voice provider: {provider}")))
}

async fn put_settings(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut ops: Vec<CredOp> = Vec::new();

    {
        let _guard = state.store.lock().await;
        let mut settings = load_settings(&state).await?;

        if let Some(enabled) = body.get("readAloudEnabled").and_then(Value::as_bool) {
            settings["readAloudEnabled"] = json!(enabled);
        }
        if let Some(enabled) = body.get("autoReadAloud").and_then(Value::as_bool) {
            settings["autoReadAloud"] = json!(enabled);
        }
        if let Some(provider) = non_empty(&body, "ttsProvider") {
            validate_provider(&tts_catalog(), provider)?;
            settings["ttsProvider"] = json!(provider);
        }
        if let Some(provider) = non_empty(&body, "sttProvider") {
            validate_provider(&stt_catalog(), provider)?;
            settings["sttProvider"] = json!(provider);
        }
        if let Some(language) = body.get("sttLanguage").and_then(Value::as_str) {
            settings["sttLanguage"] = json!(language.trim());
        }

        if let Some(update) = body.get("ttsProviderUpdate").and_then(Value::as_object) {
            let provider = update
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let spec = validate_provider(&tts_catalog(), &provider)?;
            let mut entry = settings["ttsProviders"][&provider]
                .as_object()
                .cloned()
                .unwrap_or_default();
            if let Some(model) = non_empty_map(update, "model") {
                entry.insert("model".into(), json!(model));
            }
            if let Some(voice) = update.get("voiceId").and_then(Value::as_str) {
                entry.insert("voiceId".into(), json!(voice));
            }
            if let Some(base) = update.get("baseUrl").and_then(Value::as_str) {
                entry.insert("baseUrl".into(), json!(base.trim().trim_end_matches('/')));
            }
            if let Some(speed) = update.get("speed").and_then(Value::as_f64) {
                entry.insert("speed".into(), json!(speed.clamp(0.25, 4.0)));
            }
            settings["ttsProviders"][&provider] = Value::Object(entry);
            collect_cred_ops(&mut ops, "tts", &provider, &spec, update);
        }

        if let Some(update) = body.get("sttProviderUpdate").and_then(Value::as_object) {
            let provider = update
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let spec = validate_provider(&stt_catalog(), &provider)?;
            let mut entry = settings["sttProviders"][&provider]
                .as_object()
                .cloned()
                .unwrap_or_default();
            if let Some(model) = non_empty_map(update, "model") {
                entry.insert("model".into(), json!(model));
            }
            if let Some(base) = update.get("baseUrl").and_then(Value::as_str) {
                entry.insert("baseUrl".into(), json!(base.trim().trim_end_matches('/')));
            }
            if let Some(language) = update.get("language").and_then(Value::as_str) {
                entry.insert("language".into(), json!(language.trim()));
            }
            settings["sttProviders"][&provider] = Value::Object(entry);
            collect_cred_ops(&mut ops, "stt", &provider, &spec, update);
        }

        write_json(&settings_path(&state), &settings).await?;
    }

    for op in ops {
        match op {
            CredOp::Set {
                service,
                value,
                label,
            } => {
                credentials::set(&state, &service, "api_key", &value, Some(&label)).await?;
            }
            CredOp::Delete { service } => {
                credentials::delete(&state, &service, "api_key").await?;
            }
        }
    }

    Ok(Json(settings_payload(&state).await?))
}

fn non_empty_map(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Translate an API-key action on a provider update into credential ops. Keys
/// are written to both the namespaced slot (`tts.<id>`) and, for shared
/// providers, the bare slot (`<id>`) so `GET /api/credentials` lists them.
fn collect_cred_ops(
    ops: &mut Vec<CredOp>,
    kind: &str,
    provider: &str,
    spec: &Value,
    update: &Map<String, Value>,
) {
    let clear = update
        .get("clearApiKey")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let api_key = update
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let label = format!("{} API key", text(spec, "name"));
    if clear {
        ops.push(CredOp::Delete {
            service: format!("{kind}.{provider}"),
        });
        if is_shared(provider) {
            ops.push(CredOp::Delete {
                service: provider.to_string(),
            });
        }
        return;
    }
    if let Some(value) = api_key {
        ops.push(CredOp::Set {
            service: format!("{kind}.{provider}"),
            value: value.to_string(),
            label: label.clone(),
        });
        if is_shared(provider) {
            ops.push(CredOp::Set {
                service: provider.to_string(),
                value: value.to_string(),
                label,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Key and config resolution
// ---------------------------------------------------------------------------

pub(crate) async fn resolve_key(
    state: &AppState,
    kind: &str,
    provider: &str,
    request_key: Option<&str>,
) -> Result<Option<String>, ApiError> {
    if let Some(key) = request_key.map(str::trim).filter(|key| !key.is_empty()) {
        return Ok(Some(key.to_string()));
    }
    if let Some(secret) =
        credentials::get_plaintext(state, &format!("{kind}.{provider}"), "api_key").await?
    {
        return Ok(Some(secret.expose().to_string()));
    }
    if let Some(secret) = credentials::get_plaintext(state, provider, "api_key").await? {
        return Ok(Some(secret.expose().to_string()));
    }
    Ok(None)
}

pub(crate) fn resolve_saved_string(
    settings: &Value,
    slot: &str,
    provider: &str,
    field: &str,
    fallback: &str,
) -> String {
    settings
        .get(slot)
        .and_then(|map| map.get(provider))
        .and_then(|entry| non_empty(entry, field))
        .unwrap_or(fallback)
        .to_string()
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/// Normalize an OpenAI-style base URL to its `/audio/speech` endpoint.
pub fn normalize_speech_url(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return "https://api.openai.com/v1/audio/speech".to_string();
    }
    if base.ends_with("/audio/speech") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/audio/speech")
    } else {
        format!("{base}/v1/audio/speech")
    }
}

/// Normalize an OpenAI-style base URL to its `/audio/transcriptions` endpoint.
pub fn normalize_transcription_url(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return "https://api.openai.com/v1/audio/transcriptions".to_string();
    }
    if base.ends_with("/audio/transcriptions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/audio/transcriptions")
    } else {
        format!("{base}/v1/audio/transcriptions")
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn tts_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TTS_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn stt_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(STT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn upstream_error(
    provider: &str,
    response: reqwest::Response,
    secret: Option<&str>,
) -> ApiError {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let mut message: String = body.chars().take(400).collect();
    if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
        message = message.replace(secret, "[REDACTED]");
    }
    ApiError(
        StatusCode::BAD_GATEWAY,
        format!("{provider} request failed ({status}): {message}"),
    )
}

pub(crate) struct Part<'a> {
    pub(crate) name: &'a str,
    pub(crate) filename: Option<&'a str>,
    pub(crate) content_type: Option<&'a str>,
    pub(crate) data: &'a [u8],
}

/// Build an RFC 2046 multipart/form-data body without pulling in the `multipart`
/// reqwest feature (which would churn `Cargo.lock`).
pub(crate) fn multipart_body(boundary: &str, parts: &[Part]) -> Vec<u8> {
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match part.filename {
            Some(filename) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
                    part.name, filename
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{}\"\r\n", part.name).as_bytes(),
            ),
        }
        if let Some(content_type) = part.content_type {
            body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(part.data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

fn audio_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/flac" => "flac",
        _ => "webm",
    }
}

// ---------------------------------------------------------------------------
// Handlers: synthesis
// ---------------------------------------------------------------------------

async fn synthesize(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let input = body
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if input.is_empty() {
        return Err(bad_request("text is required"));
    }
    if input.chars().count() > MAX_TTS_CHARS {
        return Err(bad_request("text is too long (max 8192 characters)"));
    }

    let settings = load_settings(&state).await?;
    let provider = non_empty(&body, "provider")
        .map(str::to_string)
        .unwrap_or_else(|| text(&settings, "ttsProvider").to_string());
    let spec = spec_for(&tts_catalog(), &provider)
        .ok_or_else(|| bad_request(&format!("unknown tts provider: {provider}")))?;

    if is_keyless(&spec) {
        return Err(bad_request(
            "browser-native text-to-speech is synthesized in the browser, not the server",
        ));
    }

    let model = non_empty(&body, "model")
        .map(str::to_string)
        .unwrap_or_else(|| {
            resolve_saved_string(&settings, "ttsProviders", &provider, "model", text(&spec, "defaultModel"))
        });
    let voice = body
        .get("voiceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            resolve_saved_string(
                &settings,
                "ttsProviders",
                &provider,
                "voiceId",
                text(&spec, "defaultVoice"),
            )
        });
    let base = non_empty(&body, "baseUrl")
        .map(|value| value.trim_end_matches('/').to_string())
        .unwrap_or_else(|| {
            resolve_saved_string(
                &settings,
                "ttsProviders",
                &provider,
                "baseUrl",
                text(&spec, "defaultBaseUrl"),
            )
        });
    let speed = settings
        .get("ttsProviders")
        .and_then(|map| map.get(&provider))
        .and_then(|entry| entry.get("speed"))
        .and_then(Value::as_f64)
        .unwrap_or(1.0);

    let api_key = resolve_key(&state, "tts", &provider, non_empty(&body, "apiKey")).await?;
    if api_key.is_none() {
        return Err(bad_request(&format!(
            "no API key configured for {provider} text-to-speech"
        )));
    }
    let api_key = api_key.unwrap_or_default();

    let (bytes, content_type) = match provider.as_str() {
        "openai" | "custom-openai" => {
            let url = normalize_speech_url(&base);
            let response = tts_client()
                .post(url)
                .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
                .json(&json!({
                    "model": model,
                    "input": input,
                    "voice": voice,
                    "speed": speed,
                    "response_format": "mp3",
                }))
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            finish_audio(&provider, response, Some(&api_key), "openai").await?
        }
        "elevenlabs" => {
            let base = if base.is_empty() {
                "https://api.elevenlabs.io".to_string()
            } else {
                base
            };
            let url = format!(
                "{}/v1/text-to-speech/{}?output_format=mp3_44100_128",
                base, voice
            );
            let response = tts_client()
                .post(url)
                .header("xi-api-key", api_key.clone())
                .json(&json!({ "text": input, "model_id": model }))
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            finish_audio(&provider, response, Some(&api_key), "elevenlabs").await?
        }
        "deepgram" => {
            let model_id = if voice.is_empty() { model.clone() } else { voice.clone() };
            let url = format!("https://api.deepgram.com/v1/speak?model={model_id}");
            let response = tts_client()
                .post(url)
                .header(header::AUTHORIZATION, format!("Token {api_key}"))
                .json(&json!({ "text": input }))
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            finish_audio(&provider, response, Some(&api_key), "deepgram").await?
        }
        "fish-audio" => {
            let base = if base.is_empty() {
                "https://api.fish.audio".to_string()
            } else {
                base
            };
            let url = format!("{base}/v1/tts");
            let response = tts_client()
                .post(url)
                .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
                .json(&json!({
                    "text": input,
                    "reference_id": voice,
                    "format": "mp3",
                }))
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            finish_audio(&provider, response, Some(&api_key), "fish-audio").await?
        }
        "xai" => {
            let response = tts_client()
                .post("https://api.x.ai/v1/tts")
                .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
                .json(&json!({
                    "text": input,
                    "voice_id": voice,
                    "output_format": {
                        "codec": "mp3",
                        "sample_rate": 24000,
                        "bit_rate": 128000,
                    },
                }))
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            finish_audio(&provider, response, Some(&api_key), "xai").await?
        }
        _ => return Err(bad_request(&format!("unsupported tts provider: {provider}"))),
    };

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    let content_type = content_type.unwrap_or_else(|| "audio/mpeg".to_string());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type).unwrap_or_else(|_| HeaderValue::from_static("audio/mpeg")),
    );
    Ok(response)
}

fn unreachable_error(provider: &str) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        format!("could not reach the {provider} API"),
    )
}

async fn finish_audio(
    provider: &str,
    response: reqwest::Response,
    secret: Option<&str>,
    default_type: &str,
) -> Result<(Vec<u8>, Option<String>), ApiError> {
    if !response.status().is_success() {
        return Err(upstream_error(provider, response, secret).await);
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| Some(format!("audio/{default_type}")));
    let bytes = response
        .bytes()
        .await
        .map_err(|_| unreachable_error(provider))?
        .to_vec();
    Ok((bytes, content_type))
}

// ---------------------------------------------------------------------------
// Handlers: transcription
// ---------------------------------------------------------------------------

async fn transcribe(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let encoded = body
        .get("audio")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if encoded.is_empty() {
        return Err(bad_request("audio is required"));
    }
    let audio = BASE64
        .decode(encoded)
        .map_err(|_| bad_request("audio must be valid base64"))?;
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(bad_request("audio is too large (max 25 MB)"));
    }

    let settings = load_settings(&state).await?;
    let provider = non_empty(&body, "provider")
        .map(str::to_string)
        .unwrap_or_else(|| text(&settings, "sttProvider").to_string());
    let spec = spec_for(&stt_catalog(), &provider)
        .ok_or_else(|| bad_request(&format!("unknown stt provider: {provider}")))?;

    if is_keyless(&spec) {
        return Err(bad_request(
            "browser-native speech recognition runs in the browser, not the server",
        ));
    }

    let model = non_empty(&body, "model")
        .map(str::to_string)
        .unwrap_or_else(|| {
            resolve_saved_string(&settings, "sttProviders", &provider, "model", text(&spec, "defaultModel"))
        });
    let base = non_empty(&body, "baseUrl")
        .map(|value| value.trim_end_matches('/').to_string())
        .unwrap_or_else(|| {
            resolve_saved_string(
                &settings,
                "sttProviders",
                &provider,
                "baseUrl",
                text(&spec, "defaultBaseUrl"),
            )
        });
    let language = body
        .get("language")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let saved = settings
                .get("sttProviders")
                .and_then(|map| map.get(&provider))
                .and_then(|entry| non_empty(entry, "language"));
            saved
                .map(str::to_string)
                .or_else(|| Some(text(&settings, "sttLanguage").to_string()).filter(|l| !l.is_empty()))
        });
    let mime_type = non_empty(&body, "mimeType").unwrap_or("audio/webm").to_string();

    let api_key = resolve_key(&state, "stt", &provider, non_empty(&body, "apiKey")).await?;
    if api_key.is_none() {
        return Err(bad_request(&format!(
            "no API key configured for {provider} speech-to-text"
        )));
    }
    let api_key = api_key.unwrap_or_default();

    let transcript = match provider.as_str() {
        "deepgram" => {
            let mut url = format!(
                "https://api.deepgram.com/v1/listen?model={model}&smart_format=true"
            );
            if let Some(language) = language.as_deref() {
                url.push_str(&format!("&language={language}"));
            }
            let response = stt_client()
                .post(url)
                .header(header::AUTHORIZATION, format!("Token {api_key}"))
                .header(header::CONTENT_TYPE, mime_type.clone())
                .body(audio)
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            if !response.status().is_success() {
                return Err(upstream_error(&provider, response, Some(&api_key)).await);
            }
            let value: Value = response
                .json()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            value
                .get("results")
                .and_then(|results| results.get("channels"))
                .and_then(|channels| channels.get(0))
                .and_then(|channel| channel.get("alternatives"))
                .and_then(|alternatives| alternatives.get(0))
                .and_then(|alternative| alternative.get("transcript"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }
        "elevenlabs" => {
            let boundary = format!("----amiro-{}", uuid::Uuid::new_v4().simple());
            let filename = format!("audio.{}", audio_extension(&mime_type));
            let body = multipart_body(
                &boundary,
                &[
                    Part {
                        name: "file",
                        filename: Some(&filename),
                        content_type: Some(&mime_type),
                        data: &audio,
                    },
                    Part {
                        name: "model_id",
                        filename: None,
                        content_type: None,
                        data: model.as_bytes(),
                    },
                ],
            );
            let response = stt_client()
                .post("https://api.elevenlabs.io/v1/speech-to-text")
                .header("xi-api-key", api_key.clone())
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(body)
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            if !response.status().is_success() {
                return Err(upstream_error(&provider, response, Some(&api_key)).await);
            }
            let value: Value = response
                .json()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }
        "openai" | "groq" | "xai" | "custom-openai" => {
            let url = normalize_transcription_url(&base);
            let boundary = format!("----amiro-{}", uuid::Uuid::new_v4().simple());
            let filename = format!("audio.{}", audio_extension(&mime_type));
            let mut parts = vec![
                Part {
                    name: "file",
                    filename: Some(&filename),
                    content_type: Some(&mime_type),
                    data: &audio,
                },
                Part {
                    name: "model",
                    filename: None,
                    content_type: None,
                    data: model.as_bytes(),
                },
            ];
            if let Some(language) = language.as_deref() {
                parts.push(Part {
                    name: "language",
                    filename: None,
                    content_type: None,
                    data: language.as_bytes(),
                });
            }
            let body = multipart_body(&boundary, &parts);
            let response = stt_client()
                .post(url)
                .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(body)
                .send()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            if !response.status().is_success() {
                return Err(upstream_error(&provider, response, Some(&api_key)).await);
            }
            let value: Value = response
                .json()
                .await
                .map_err(|_| unreachable_error(&provider))?;
            value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }
        _ => return Err(bad_request(&format!("unsupported stt provider: {provider}"))),
    };

    Ok(Json(json!({
        "status": "ok",
        "text": transcript,
        "providerId": provider,
    })))
}

async fn list_voices(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let settings = load_settings(&state).await?;
    let provider = non_empty(&body, "provider")
        .map(str::to_string)
        .unwrap_or_else(|| text(&settings, "ttsProvider").to_string());
    let spec = spec_for(&tts_catalog(), &provider)
        .ok_or_else(|| bad_request(&format!("unknown tts provider: {provider}")))?;

    let base = non_empty(&body, "baseUrl")
        .map(|value| value.trim_end_matches('/').to_string())
        .unwrap_or_else(|| {
            resolve_saved_string(
                &settings,
                "ttsProviders",
                &provider,
                "baseUrl",
                text(&spec, "defaultBaseUrl"),
            )
        });
    let api_key = resolve_key(&state, "tts", &provider, non_empty(&body, "apiKey")).await?;

    let default_voices: Vec<Value> = spec
        .get("voices")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|id| json!({ "id": id, "name": id }))
                .collect()
        })
        .unwrap_or_default();

    if provider == "elevenlabs" {
        if let Some(key) = api_key.as_deref() {
            let base_url = if base.is_empty() {
                "https://api.elevenlabs.io"
            } else {
                base.as_str()
            };
            if let Ok(resp) = tts_client()
                .get(format!("{base_url}/v1/voices"))
                .header("xi-api-key", key)
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(val) = resp.json::<Value>().await {
                        if let Some(arr) = val.get("voices").and_then(Value::as_array) {
                            let voices: Vec<Value> = arr
                                .iter()
                                .filter_map(|v| {
                                    let id = v.get("voice_id").and_then(Value::as_str)?;
                                    let name = v.get("name").and_then(Value::as_str).unwrap_or(id);
                                    let preview_url = v.get("preview_url").and_then(Value::as_str);
                                    let category = v.get("category").and_then(Value::as_str);
                                    Some(json!({
                                        "id": id,
                                        "name": name,
                                        "previewUrl": preview_url,
                                        "category": category,
                                    }))
                                })
                                .collect();
                            if !voices.is_empty() {
                                return Ok(Json(json!({ "provider": provider, "voices": voices })));
                            }
                        }
                    }
                }
            }
        }
    } else if provider == "fish-audio" {
        if let Some(key) = api_key.as_deref() {
            let base_url = if base.is_empty() {
                "https://api.fish.audio"
            } else {
                base.as_str()
            };
            if let Ok(resp) = tts_client()
                .get(format!("{base_url}/model?page_size=20&page_number=1"))
                .header(header::AUTHORIZATION, format!("Bearer {key}"))
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(val) = resp.json::<Value>().await {
                        if let Some(arr) = val.get("items").and_then(Value::as_array) {
                            let voices: Vec<Value> = arr
                                .iter()
                                .filter_map(|v| {
                                    let id = v.get("_id").or_else(|| v.get("id")).and_then(Value::as_str)?;
                                    let name = v.get("title").or_else(|| v.get("name")).and_then(Value::as_str).unwrap_or(id);
                                    Some(json!({ "id": id, "name": name }))
                                })
                                .collect();
                            if !voices.is_empty() {
                                return Ok(Json(json!({ "provider": provider, "voices": voices })));
                            }
                        }
                    }
                }
            }
        }
    } else if provider == "custom-openai" || provider == "openai" {
        if !base.is_empty() {
            let base_clean = base.trim_end_matches('/');
            let voices_url = if base_clean.ends_with("/v1") {
                format!("{base_clean}/audio/voices")
            } else {
                format!("{base_clean}/v1/audio/voices")
            };
            let mut req = tts_client().get(&voices_url);
            if let Some(key) = api_key.as_deref() {
                req = req.header(header::AUTHORIZATION, format!("Bearer {key}"));
            }
            if let Ok(resp) = req.send().await {
                if resp.status().is_success() {
                    if let Ok(val) = resp.json::<Value>().await {
                        let arr_opt = val
                            .get("voices")
                            .and_then(Value::as_array)
                            .or_else(|| val.get("data").and_then(Value::as_array))
                            .or_else(|| val.as_array());
                        if let Some(arr) = arr_opt {
                            let voices: Vec<Value> = arr
                                .iter()
                                .filter_map(|v| {
                                    if let Some(s) = v.as_str() {
                                        return Some(json!({ "id": s, "name": s }));
                                    }
                                    let id = v
                                        .get("voice_id")
                                        .or_else(|| v.get("id"))
                                        .or_else(|| v.get("name"))
                                        .and_then(Value::as_str)?;
                                    let name = v
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or(id);
                                    Some(json!({ "id": id, "name": name }))
                                })
                                .collect();
                            if !voices.is_empty() {
                                return Ok(Json(json!({ "provider": provider, "voices": voices })));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(Json(json!({
        "provider": provider,
        "voices": default_voices,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/voice/settings", get(get_settings).put(put_settings))
        .route("/api/tts/voices", post(list_voices))
        .route("/api/tts/synthesize", post(synthesize))
        .route("/api/stt/transcribe", post(transcribe))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn fixture() -> (AppState, PathBuf) {
        let root = std::env::temp_dir().join(format!("amiro-voice-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let state = AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("amiro-api.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("amiro-runtime"),
            token: String::new(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    fn user() -> AuthUser {
        AuthUser(json!({"id": "user-1", "role": "user"}))
    }

    #[test]
    fn catalogs_cover_expected_providers() {
        let tts: Vec<String> = tts_catalog()
            .iter()
            .map(|spec| text(spec, "id").to_string())
            .collect();
        assert_eq!(
            tts,
            vec![
                "openai",
                "elevenlabs",
                "deepgram",
                "fish-audio",
                "xai",
                "custom-openai",
                "browser-native"
            ]
        );
        let stt: Vec<String> = stt_catalog()
            .iter()
            .map(|spec| text(spec, "id").to_string())
            .collect();
        assert_eq!(
            stt,
            vec![
                "deepgram",
                "openai",
                "groq",
                "elevenlabs",
                "xai",
                "custom-openai",
                "browser-native"
            ]
        );
    }

    #[test]
    fn openai_catalog_matches_contract() {
        let openai = spec_for(&tts_catalog(), "openai").unwrap();
        assert_eq!(text(&openai, "name"), "OpenAI Speech");
        assert_eq!(text(&openai, "defaultModel"), "tts-1");
        assert_eq!(text(&openai, "defaultVoice"), "alloy");
        assert_eq!(text(&openai, "defaultBaseUrl"), "https://api.openai.com/v1");
        assert_eq!(text(&openai, "apiKeyPlaceholder"), "sk-...");
        assert_eq!(openai["voices"].as_array().unwrap().len(), 11);
        assert_eq!(openai["models"].as_array().unwrap().len(), 3);
        assert!(openai["supportsVoiceSelection"].as_bool().unwrap());
        assert!(openai["supportsBaseUrl"].as_bool().unwrap());
    }

    #[test]
    fn custom_openai_requires_base_url() {
        let custom = spec_for(&tts_catalog(), "custom-openai").unwrap();
        assert!(custom["requiresBaseUrl"].as_bool().unwrap());
        assert_eq!(text(&custom, "defaultBaseUrl"), "http://localhost:20128/v1");
        let browser = spec_for(&tts_catalog(), "browser-native").unwrap();
        assert!(browser["keyless"].as_bool().unwrap());
    }

    #[test]
    fn speech_url_normalization() {
        assert_eq!(
            normalize_speech_url("http://localhost:20128/v1"),
            "http://localhost:20128/v1/audio/speech"
        );
        assert_eq!(
            normalize_speech_url("http://localhost:20128/v1/"),
            "http://localhost:20128/v1/audio/speech"
        );
        assert_eq!(
            normalize_speech_url("http://localhost:20128"),
            "http://localhost:20128/v1/audio/speech"
        );
        assert_eq!(
            normalize_speech_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/speech"
        );
        assert_eq!(
            normalize_speech_url("https://router.example.com/v1/audio/speech"),
            "https://router.example.com/v1/audio/speech"
        );
        assert_eq!(
            normalize_speech_url(""),
            "https://api.openai.com/v1/audio/speech"
        );
    }

    #[test]
    fn transcription_url_normalization() {
        assert_eq!(
            normalize_transcription_url("http://localhost:20128/v1"),
            "http://localhost:20128/v1/audio/transcriptions"
        );
        assert_eq!(
            normalize_transcription_url("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/audio/transcriptions"
        );
        assert_eq!(
            normalize_transcription_url("https://api.openai.com"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(
            normalize_transcription_url("https://host/v1/audio/transcriptions"),
            "https://host/v1/audio/transcriptions"
        );
    }

    #[test]
    fn masking_matches_credential_store() {
        assert_eq!(credentials::masked_hint("sk-super-secret-1234"), "••••1234");
        assert_eq!(credentials::masked_hint("abc"), "••••");
        assert_eq!(credentials::masked_hint(""), "••••");
    }

    #[test]
    fn hint_resolution_prefers_namespaced_then_shared() {
        let mut hints = BTreeMap::new();
        hints.insert("openai/api_key".to_string(), "••••9999".to_string());
        assert_eq!(
            hint_for(&hints, "tts.openai", "openai").as_deref(),
            Some("••••9999")
        );
        assert!(hint_for(&hints, "tts.elevenlabs", "elevenlabs").is_none());
        hints.insert("tts.elevenlabs/api_key".to_string(), "••••4321".to_string());
        assert_eq!(
            hint_for(&hints, "tts.elevenlabs", "elevenlabs").as_deref(),
            Some("••••4321")
        );
    }

    #[test]
    fn multipart_body_is_well_formed() {
        let body = multipart_body(
            "BOUND",
            &[
                Part {
                    name: "file",
                    filename: Some("audio.webm"),
                    content_type: Some("audio/webm"),
                    data: b"ABC",
                },
                Part {
                    name: "model",
                    filename: None,
                    content_type: None,
                    data: b"whisper-1",
                },
            ],
        );
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with("--BOUND\r\n"));
        assert!(text.contains("name=\"file\"; filename=\"audio.webm\"\r\nContent-Type: audio/webm\r\n\r\nABC\r\n"));
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"));
        assert!(text.ends_with("--BOUND--\r\n"));
    }

    #[tokio::test]
    async fn settings_roundtrip_and_credential_masking() {
        let (state, root) = fixture();

        // GET defaults.
        let payload = settings_payload(&state).await.unwrap();
        assert_eq!(payload["settings"]["ttsProvider"], "browser-native");
        assert_eq!(payload["settings"]["sttProvider"], "browser-native");
        assert_eq!(payload["settings"]["sttLanguage"], "en");
        assert_eq!(payload["ttsCatalog"].as_array().unwrap().len(), 7);
        assert_eq!(payload["sttCatalog"].as_array().unwrap().len(), 7);
        let browser = &payload["settings"]["ttsProviders"]["browser-native"];
        assert_eq!(browser["configured"], true);
        assert_eq!(browser["apiKeyHint"], Value::Null);

        // PUT: switch to OpenAI TTS with a key.
        let Json(updated) = put_settings(
            State(state.clone()),
            user(),
            Json(json!({
                "ttsProvider": "openai",
                "readAloudEnabled": false,
                "ttsProviderUpdate": {
                    "provider": "openai",
                    "model": "tts-1-hd",
                    "voiceId": "nova",
                    "speed": 1.25,
                    "apiKey": "sk-openai-secret-1234",
                },
                "sttProviderUpdate": {
                    "provider": "deepgram",
                    "model": "nova-3",
                    "apiKey": "dg-secret-9876",
                },
            })),
        )
        .await
        .unwrap();

        assert_eq!(updated["settings"]["ttsProvider"], "openai");
        assert_eq!(updated["settings"]["readAloudEnabled"], false);
        let openai = &updated["settings"]["ttsProviders"]["openai"];
        assert_eq!(openai["model"], "tts-1-hd");
        assert_eq!(openai["voiceId"], "nova");
        assert_eq!(openai["speed"], 1.25);
        assert_eq!(openai["configured"], true);
        assert_eq!(openai["apiKeyHint"], "••••1234");
        let deepgram = &updated["settings"]["sttProviders"]["deepgram"];
        assert_eq!(deepgram["model"], "nova-3");
        assert_eq!(deepgram["configured"], true);
        assert_eq!(deepgram["apiKeyHint"], "••••9876");

        // The payload never leaks a secret.
        assert!(!updated.to_string().contains("sk-openai-secret-1234"));
        assert!(!updated.to_string().contains("dg-secret-9876"));

        // Keys were persisted to both namespaced and shared slots.
        assert!(credentials::get_plaintext(&state, "tts.openai", "api_key")
            .await
            .unwrap()
            .is_some());
        assert!(credentials::get_plaintext(&state, "openai", "api_key")
            .await
            .unwrap()
            .is_some());
        assert!(credentials::get_plaintext(&state, "stt.deepgram", "api_key")
            .await
            .unwrap()
            .is_some());
        assert!(credentials::get_plaintext(&state, "deepgram", "api_key")
            .await
            .unwrap()
            .is_some());

        // A fresh GET reflects the persisted config.
        let again = settings_payload(&state).await.unwrap();
        assert_eq!(again["settings"]["ttsProvider"], "openai");
        assert_eq!(again["settings"]["ttsProviders"]["openai"]["voiceId"], "nova");

        // Clearing removes both slots.
        let Json(cleared) = put_settings(
            State(state.clone()),
            user(),
            Json(json!({
                "ttsProviderUpdate": {"provider": "openai", "clearApiKey": true},
            })),
        )
        .await
        .unwrap();
        assert_eq!(cleared["settings"]["ttsProviders"]["openai"]["configured"], false);
        assert!(credentials::get_plaintext(&state, "tts.openai", "api_key")
            .await
            .unwrap()
            .is_none());
        assert!(credentials::get_plaintext(&state, "openai", "api_key")
            .await
            .unwrap()
            .is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn unknown_provider_is_rejected() {
        let (state, root) = fixture();
        let error = put_settings(
            State(state.clone()),
            user(),
            Json(json!({"ttsProvider": "not-a-provider"})),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn synthesize_requires_text_and_key() {
        let (state, root) = fixture();
        let missing_text = synthesize(
            State(state.clone()),
            user(),
            Json(json!({"provider": "openai", "text": "  "})),
        )
        .await
        .unwrap_err();
        assert_eq!(missing_text.0, StatusCode::BAD_REQUEST);

        let missing_key = synthesize(
            State(state.clone()),
            user(),
            Json(json!({"provider": "openai", "text": "hello"})),
        )
        .await
        .unwrap_err();
        assert_eq!(missing_key.0, StatusCode::BAD_REQUEST);

        let browser = synthesize(
            State(state.clone()),
            user(),
            Json(json!({"provider": "browser-native", "text": "hello"})),
        )
        .await
        .unwrap_err();
        assert_eq!(browser.0, StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn transcribe_rejects_bad_base64() {
        let (state, root) = fixture();
        let error = transcribe(
            State(state.clone()),
            user(),
            Json(json!({"audio": "not base64!!", "apiKey": "sk-x"})),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(root);
    }
}
