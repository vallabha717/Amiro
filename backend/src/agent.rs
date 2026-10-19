// backend/src/agent.rs -- Agent identity, personality, Amiro runtime memory graph,
// and Amiro workspace file browser routes.
//
// Native port of adapter/src/routes/agent.mjs. No Node forwarding: every contract,
// status code, and response field shape is reproduced here in Rust.
//
// Security posture (mirrors the 2026-10-15 hardening):
//   - Identity/personality are per-user (agent-identity/<userId>.json) to prevent
//     cross-user persona clobbering. Legacy shared key is migrated read-only, and
//     only for an admin owner.
//     Persona markdown is written only under workspace/users/<userId>/ and never to
//     the runtime's global memory JSONs or global prompt-overlay.md.
//   - The Amiro runtime memory graph (engine storage) is READ ONLY. GET
//     /api/agent/memory is admin-gated and returns readOnly:true. POST /reinforce /
//     DELETE return 501 instead of mutating JSON.
//   - Workspace browser is admin-gated and allowlisted with realpath containment,
//     forbidding secrets/credentials/sessions and arbitrary engine-state files.
//   - Identity/personality inputs are strictly validated (name/traits/accent/image).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEGACY_IDENTITY_KEY: &str = "agent-identity.json";
const IDENTITY_DIR: &str = "agent-identity";

const GREEN_HEX: &str = "#4C9B50";
const ORANGE_HEX: &str = "#E9642F";
const PINK_HEX: &str = "#DB4B77";
const PURPLE_HEX: &str = "#A665C9";
const TEAL_HEX: &str = "#0E9B8B";
const YELLOW_HEX: &str = "#E9C91A";
const INDIGO_HEX: &str = "#5856D6";
const COBALT_HEX: &str = "#007AFF";
const BLACK_HEX: &str = "#17171C";

/// Accent palette keyed by color id. Kept byte-identical to `AVATAR_COLORS`
/// in the UI catalog. Sidebar themes are CSS-token driven and are NOT part
/// of this palette. `black` is the plush near-black the customizer offers.
fn accent_palette(color: &str) -> Option<&'static str> {
    match color {
        "green" => Some(GREEN_HEX),
        "orange" => Some(ORANGE_HEX),
        "pink" => Some(PINK_HEX),
        "purple" => Some(PURPLE_HEX),
        "teal" => Some(TEAL_HEX),
        "yellow" => Some(YELLOW_HEX),
        "indigo" => Some(INDIGO_HEX),
        "cobalt" => Some(COBALT_HEX),
        "black" => Some(BLACK_HEX),
        _ => None,
    }
}

const VALID_BODY_SHAPES: [&str; 6] = ["blob", "cloud", "sprout", "star", "ghost", "urchin"];
const VALID_EYE_STYLES: [&str; 9] = [
    "grumpy", "angry", "curious", "goofy", "surprised", "bashful", "gentle", "quirky", "dazed",
];
const VALID_COLORS: [&str; 9] = [
    "green", "orange", "pink", "purple", "teal", "yellow", "indigo", "cobalt", "black",
];

const DEFAULT_SLIDER_KEYS: [&str; 5] = [
    "companionCoworker",
    "genzBoomer",
    "executeCollaborate",
    "playfulSerious",
    "politeUnfiltered",
];

const DEFAULT_BODY_SHAPE: &str = "blob";
const DEFAULT_EYE_STYLE: &str = "curious";
const DEFAULT_COLOR: &str = "orange";

const DEFAULT_TAGLINE: &str = "Your Personal Intelligence powered by Amiro";

const MAX_NAME_LEN: usize = 32;
const MAX_TAGLINE_LEN: usize = 120;
const MAX_HANDLE_LEN: usize = 32;
const MAX_CUSTOM_IMAGE_RAW_LEN: usize = 4 * 1024 * 1024;
const MAX_CUSTOM_IMAGE_DECODED: u64 = 2 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES: u64 = 256 * 1024;

/// Legacy invalid eyeStyle -> canonical mapping.
fn legacy_eye_map(eye: &str) -> Option<&'static str> {
    match eye {
        "round" => Some("grumpy"),
        "happy" => Some("bashful"),
        "sleepy" => Some("gentle"),
        "wink" => Some("quirky"),
        _ => None,
    }
}

/// RFC3339 with milliseconds and `Z`, byte-compatible with JS `Date.toISOString()`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn sys_time_iso(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Small JS-compatibility helpers
//
// The port must reproduce JS truthiness / `Number()` / `String()` coercion
// because the adapter's validation and normalization logic depends on it.
// ---------------------------------------------------------------------------

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` in JS.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| js_string(x)).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Number(value)` in JS (NaN where JS yields NaN).
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(a) => match a.len() {
            0 => 0.0,
            1 => js_number(&a[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `value || default` where the fallback is a `&str`.
fn js_string_or(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(x) if is_truthy(x) => js_string(x),
        _ => default.to_string(),
    }
}

fn trim_or(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(x) if is_truthy(x) => js_string(x).trim().to_string(),
        _ => default.to_string(),
    }
}

/// JS `String.prototype.slice(0, n)`, counted in (unicode) chars.
fn slice_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn js_len(s: &str) -> usize {
    s.chars().count()
}

// ---------------------------------------------------------------------------
// Identity / personality normalization
// ---------------------------------------------------------------------------

fn valid_handle(handle: &str) -> bool {
    // /^@[a-z0-9_]{1,32}$/i
    let b = handle.as_bytes();
    if b.len() < 2 || b[0] != b'@' {
        return false;
    }
    let rest = &b[1..];
    if rest.is_empty() || rest.len() > MAX_HANDLE_LEN {
        return false;
    }
    rest.iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

fn valid_hex(v: &str) -> bool {
    // /^#[0-9a-fA-F]{6}$/
    let b = v.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

fn is_valid_data_image_url(v: &Value) -> bool {
    let s = js_string(v);
    if s.len() > MAX_CUSTOM_IMAGE_RAW_LEN {
        return false;
    }
    // /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
    let lower = &s; // prefix is case sensitive in the adapter regex
    let rest = if let Some(r) = lower.strip_prefix("data:image/png;base64,") {
        r
    } else if let Some(r) = lower.strip_prefix("data:image/jpeg;base64,") {
        r
    } else if let Some(r) = lower.strip_prefix("data:image/jpg;base64,") {
        r
    } else if let Some(r) = lower.strip_prefix("data:image/webp;base64,") {
        r
    } else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let pad = if rest.ends_with("==") {
        2
    } else if rest.ends_with('=') {
        1
    } else {
        0
    };
    let body = &rest[..rest.len() - pad];
    if body.is_empty() {
        return false;
    }
    if !body
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    {
        return false;
    }
    // decoded size = floor(b64Len * 3 / 4) - padding
    let decoded = (rest.len() as u64 * 3) / 4;
    let decoded = decoded.saturating_sub(pad as u64);
    if decoded > MAX_CUSTOM_IMAGE_DECODED {
        return false;
    }
    if decoded == 0 {
        return false;
    }
    true
}

fn clamp_slider(v: &Value, fallback: f64) -> i64 {
    let num = js_number(v);
    if !num.is_finite() {
        return fallback.round() as i64;
    }
    num.max(0.0).min(100.0).round() as i64
}

fn normalize_sliders(raw: &Value) -> Value {
    let get = |k: &str, dflt: f64| -> i64 {
        match raw.get(k) {
            Some(v) => clamp_slider(v, dflt),
            None => dflt.round() as i64,
        }
    };
    json!({
        "companionCoworker": get("companionCoworker", 65.0),
        "genzBoomer": get("genzBoomer", 42.0),
        "executeCollaborate": get("executeCollaborate", 35.0),
        "playfulSerious": get("playfulSerious", 55.0),
        "politeUnfiltered": get("politeUnfiltered", 60.0),
    })
}

fn normalize_traits(raw: &Value) -> Value {
    let mut body_shape = js_string_or(raw.get("bodyShape"), DEFAULT_BODY_SHAPE)
        .trim()
        .to_lowercase();
    let mut eye_style = js_string_or(raw.get("eyeStyle"), DEFAULT_EYE_STYLE)
        .trim()
        .to_lowercase();
    let mut color = js_string_or(raw.get("color"), DEFAULT_COLOR)
        .trim()
        .to_lowercase();
    if let Some(mapped) = legacy_eye_map(&eye_style) {
        eye_style = mapped.to_string();
    }
    if !VALID_BODY_SHAPES.contains(&body_shape.as_str()) {
        body_shape = DEFAULT_BODY_SHAPE.to_string();
    }
    if !VALID_EYE_STYLES.contains(&eye_style.as_str()) {
        eye_style = DEFAULT_EYE_STYLE.to_string();
    }
    if !VALID_COLORS.contains(&color.as_str()) {
        color = DEFAULT_COLOR.to_string();
    }
    json!({
        "bodyShape": body_shape,
        "eyeStyle": eye_style,
        "color": color,
    })
}

/// `summarizePersonality` -- exported from the adapter module for the chat worker.
pub fn summarize_personality(sliders: &Value) -> String {
    let s = normalize_sliders(sliders);
    let axes: [(&str, &str, &str); 5] = [
        ("companionCoworker", "Companion", "Coworker"),
        ("executeCollaborate", "Independent", "Collaborative"),
        ("playfulSerious", "Playful", "Serious"),
        ("politeUnfiltered", "Polite", "Unfiltered"),
        ("genzBoomer", "Gen Z", "Classic"),
    ];
    let mut parts: Vec<String> = Vec::new();
    for (id, left, right) in axes {
        let val = s.get(id).and_then(|v| v.as_f64()).unwrap_or(50.0);
        let lean = val - 50.0;
        if lean.abs() > 6.0 {
            let pct = if lean > 0.0 { val } else { 100.0 - val };
            let pole = if lean > 0.0 { right } else { left };
            parts.push(format!("{}% {}", pct.round() as i64, pole));
        }
    }
    if parts.is_empty() {
        return "Balanced across all five axes".to_string();
    }
    parts.truncate(3);
    parts.join(" · ")
}

/// `buildPersonaPromptBlock` -- exported for the chat worker's system reminder.
pub fn build_persona_prompt_block(identity: &Value) -> String {
    let name = js_string_or(identity.get("name"), "Amiro");
    let handle = js_string_or(identity.get("handle"), "@amiro");
    let summary = match identity.get("personalitySummary") {
        Some(v) if is_truthy(v) => js_string(v),
        _ => summarize_personality(identity.get("sliders").unwrap_or(&Value::Null)),
    };
    let s = normalize_sliders(identity.get("sliders").unwrap_or(&Value::Null));
    let n = |k: &str| -> i64 { s.get(k).and_then(|v| v.as_i64()).unwrap_or(50) };
    [
        format!("# Agent Identity & Persona ({name} / {handle})"),
        format!("- **Name:** {name}"),
        format!("- **Personality:** {summary}"),
        "- **Trait Calibration (0-100):**".to_string(),
        format!("  - Companion ({}) vs Coworker ({})", 100 - n("companionCoworker"), n("companionCoworker")),
        format!("  - Gen Z ({}) vs Baby Boomer ({})", 100 - n("genzBoomer"), n("genzBoomer")),
        format!(
            "  - Execute Independently ({}) vs Collaborative ({})",
            100 - n("executeCollaborate"),
            n("executeCollaborate")
        ),
        format!("  - Playful ({}) vs Serious ({})", 100 - n("playfulSerious"), n("playfulSerious")),
        format!("  - Polite ({}) vs Unfiltered ({})", 100 - n("politeUnfiltered"), n("politeUnfiltered")),
    ]
    .join("\n")
}

/// Metadata-only catalog of stored credentials, for the agent prompt.
///
/// Never contains a secret value: only the slot, the environment variable it is
/// injected under (`AMIRO_CRED_<SERVICE>_<FIELD>`), an optional label/usage
/// description, and any allowed domains. Returns an empty string when nothing is
/// stored. Read-only and key-safe: it never mints a credential store key.
pub fn build_credential_prompt_block(home: &Path) -> String {
    let items = crate::credentials::list_metadata_sync(home);
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "## Stored Credentials (Vault)\n\
         The following credentials are stored encrypted in Amiro's vault and pre-injected \
         into your tool execution environment as environment variables. Never echo or print \
         raw secret values in chat output; reference them by their environment variable name \
         (e.g. in bash commands or MCP headers) or via brokered tools:\n",
    );
    for item in &items {
        let mut line = format!("- {}/{} (${})", item.service, item.field, item.env_var);
        if let Some(label) = &item.label {
            line.push_str(&format!(": {label}"));
        }
        if let Some(usage) = &item.usage_description {
            line.push_str(&format!(" — {usage}"));
        }
        if !item.allowed_domains.is_empty() {
            line.push_str(&format!(
                " [allowed domains: {}]",
                item.allowed_domains.join(", ")
            ));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Vellum-style credential security and inline visualization guidance for agent turns.
pub fn build_capability_guidance_block(home: &Path) -> String {
    let mut blocks = vec![
        "## Credential Security (Encrypted Vault Box)\n\
         Never ask users to paste or share raw secrets (API keys, tokens, passwords, webhook secrets) in plain chat. \
         Whenever a task needs an API key, token, or secret that is not yet in the Stored Credentials list, \
         emit a secure credential prompt card on its own line in your response so the UI renders a dedicated encrypted input box:\n\
         `SECRET_PROMPT {\"service\":\"<service_slug>\",\"field\":\"<field_slug>\",\"label\":\"<Human Label>\",\"description\":\"<Why it is needed>\",\"purpose\":\"<Usage purpose>\",\"allowedDomains\":[\"<api.domain.com>\"]}`\n\
         (For example: `SECRET_PROMPT {\"service\":\"openai\",\"field\":\"api_key\",\"label\":\"OpenAI API Key\",\"description\":\"Needed to call OpenAI endpoints\",\"allowedDomains\":[\"api.openai.com\"]}`). \
         The user enters the key into that rendered box, which saves it directly to the encrypted vault (`$AMIRO_CRED_<SERVICE>_<FIELD>`) without the secret ever appearing in chat."
            .to_string(),
        "## Inline Visuals (`visualize` skill)\n\
         The \"Visualize\" skill (`visualize`) is available to render polished interactive SVG diagrams, charts, comparisons, or explainers inline in the chat transcript. \
         When asked to visualize something or when a diagram/chart explains a concept better than prose, use the `applet` tool with `placement: \"inline\"` and `view: { \"type\": \"html\", \"source\": \"<self-contained HTML/SVG fragment using CSS variables like var(--surface-lift), var(--content-default), var(--border-element)>\", \"height\": 320 }` (or load the `visualize` skill for full design-token and layout rules)."
            .to_string(),
    ];
    let catalog = build_credential_prompt_block(home);
    if !catalog.is_empty() {
        blocks.push(catalog.trim_end().to_string());
    }
    blocks.join("\n\n")
}

/// `personaFingerprint` -- sha256 of the same canonical JSON payload as the adapter
/// (same key order), truncated to 16 hex chars.
pub fn persona_fingerprint(identity: &Value) -> String {
    let s = normalize_sliders(identity.get("sliders").unwrap_or(&Value::Null));
    let traits = normalize_traits(identity.get("traits").unwrap_or(&Value::Null));
    let name = js_string_or(identity.get("name"), "Amiro");
    let handle = js_string_or(identity.get("handle"), "@amiro");
    let updated_at = js_string_or(identity.get("updatedAt"), "");
    let j = |v: &str| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_string());
    let ni = |k: &str| s.get(k).and_then(|v| v.as_i64()).unwrap_or(50);
    let payload = format!(
        "{{\"name\":{},\"handle\":{},\"traits\":{{\"bodyShape\":{},\"eyeStyle\":{},\"color\":{}}},\"sliders\":{{\"companionCoworker\":{},\"genzBoomer\":{},\"executeCollaborate\":{},\"playfulSerious\":{},\"politeUnfiltered\":{}}},\"updatedAt\":{}}}",
        j(&name),
        j(&handle),
        j(&js_string_or(traits.get("bodyShape"), DEFAULT_BODY_SHAPE)),
        j(&js_string_or(traits.get("eyeStyle"), DEFAULT_EYE_STYLE)),
        j(&js_string_or(traits.get("color"), DEFAULT_COLOR)),
        ni("companionCoworker"),
        ni("genzBoomer"),
        ni("executeCollaborate"),
        ni("playfulSerious"),
        ni("politeUnfiltered"),
        j(&updated_at),
    );
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest).chars().take(16).collect()
}

pub(crate) fn sanitize_user_id(user_id: Option<&str>) -> Option<String> {
    let s = user_id.unwrap_or("").trim();
    let safe: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if safe.is_empty() {
        None
    } else {
        Some(safe)
    }
}

fn identity_key_for_user(user_id: Option<&str>) -> String {
    match sanitize_user_id(user_id) {
        Some(safe) => format!("{IDENTITY_DIR}/{safe}.json"),
        None => LEGACY_IDENTITY_KEY.to_string(),
    }
}

/// JSON documents live under `$AMIRO_HOME/store/`, matching `createStore(home)`.
fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

// ---------------------------------------------------------------------------
// Identity read
// ---------------------------------------------------------------------------

/// Whether this user's agent identity was ever saved (not just defaults).
pub fn has_saved_identity(state: &AppState, user_id: &str) -> bool {
    store_path(state, &identity_key_for_user(Some(user_id))).is_file()
        || store_path(state, LEGACY_IDENTITY_KEY).is_file()
}

async fn is_legacy_owner_admin(state: &AppState, uid: &str) -> bool {
    let users = read_json_safe(&state.home.join("users.json"), json!({ "users": [] })).await;
    match users.get("users").and_then(|v| v.as_array()) {
        Some(list) => list.iter().any(|u| {
            js_string(u.get("id").unwrap_or(&Value::Null)) == uid
                && js_string(u.get("role").unwrap_or(&Value::Null)) == "admin"
        }),
        None => false,
    }
}

/// `getAgentIdentity` -- per-user identity with legacy admin-only migration.
pub async fn get_agent_identity(state: &AppState, user_id: Option<&str>) -> Result<Value, ApiError> {
    let uid = sanitize_user_id(user_id);

    let saved = match &uid {
        Some(uid) => {
            let per_user =
                read_json(&store_path(state, &identity_key_for_user(Some(uid))), Value::Null)
                    .await?;
            if is_truthy(&per_user) {
                per_user
            } else {
                let legacy =
                    read_json(&store_path(state, LEGACY_IDENTITY_KEY), Value::Null).await?;
                // Only migrate legacy to an admin owner to prevent leaking shared
                // legacy personalization to every user.
                if is_truthy(&legacy) && is_legacy_owner_admin(state, uid).await {
                    legacy
                } else {
                    Value::Null
                }
            }
        }
        None => read_json(&store_path(state, LEGACY_IDENTITY_KEY), Value::Null).await?,
    };

    let traits = normalize_traits(saved.get("traits").unwrap_or(&Value::Null));
    let sliders = normalize_sliders(saved.get("sliders").unwrap_or(&Value::Null));

    let accent_hex = match saved.get("accentHex") {
        Some(v) if valid_hex(&js_string(v)) => js_string(v),
        _ => {
            let color = js_string_or(traits.get("color"), DEFAULT_COLOR);
            accent_palette(&color).unwrap_or(ORANGE_HEX).to_string()
        }
    };

    let name = trim_or(saved.get("name"), "Amiro");
    let name = if name.is_empty() { "Amiro".to_string() } else { name };

    let handle_raw = match saved.get("handle") {
        Some(v) if is_truthy(v) => js_string(v).trim().to_string(),
        _ => format!("@{}", alpha_lower(&name)),
    };
    let handle_raw = if handle_raw == "@" {
        format!("@{}", alpha_lower(&name))
    } else {
        handle_raw
    };
    let handle = if valid_handle(&handle_raw) {
        handle_raw
    } else {
        let s = slice_chars(&alpha_lower(&name), 30);
        if s.is_empty() {
            "@amiro".to_string()
        } else {
            format!("@{s}")
        }
    };

    let personality_summary = match saved.get("personalitySummary") {
        Some(v) if is_truthy(v) => js_string(v),
        _ => summarize_personality(&sliders),
    };

    let custom_image_url = match saved.get("customImageUrl") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => {
            let s = js_string(v);
            if s.is_empty() || !is_valid_data_image_url(&Value::String(s)) {
                Value::Null
            } else {
                Value::String(js_string(v))
            }
        }
    };

    let updated_at = match saved.get("updatedAt") {
        Some(v) if is_truthy(v) => js_string(v),
        _ => now_iso(),
    };

    let tagline_raw = match saved.get("tagline") {
        Some(v) if is_truthy(v) => js_string(v),
        _ => DEFAULT_TAGLINE.to_string(),
    };
    let tagline = slice_chars(&tagline_raw, MAX_TAGLINE_LEN);
    let tagline = if tagline.is_empty() {
        DEFAULT_TAGLINE.to_string()
    } else {
        tagline
    };

    Ok(json!({
        "name": slice_chars(&name, MAX_NAME_LEN),
        "handle": slice_chars(&handle, MAX_HANDLE_LEN + 1),
        "tagline": tagline,
        "traits": traits,
        "accentHex": accent_hex,
        "customImageUrl": custom_image_url,
        "sliders": sliders,
        "personalitySummary": personality_summary,
        "updatedAt": updated_at,
    }))
}

/// `name.toLowerCase().replace(/[^a-z0-9]+/g, '')`
fn alpha_lower(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

// ---------------------------------------------------------------------------
// Identity validation
// ---------------------------------------------------------------------------

fn validate_identity_payload(body: &Value) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();

    if let Some(v) = body.get("name") {
        let n = js_string(v).trim().to_string();
        if n.is_empty() {
            errors.push("name must not be empty".to_string());
        } else if js_len(&n) > MAX_NAME_LEN {
            errors.push(format!("name must be <= {MAX_NAME_LEN} chars"));
        } else if n.chars().any(|c| (c as u32) < 0x20 || (c as u32) == 0x7f) {
            errors.push("name contains control characters".to_string());
        }
    }

    if let Some(v) = body.get("handle") {
        let h = js_string(v).trim().to_string();
        if !h.is_empty() && !valid_handle(&h) {
            errors.push("handle must be @alphanumeric (1-32 chars)".to_string());
        }
        if js_len(&h) > MAX_HANDLE_LEN + 1 {
            errors.push("handle too long".to_string());
        }
    }

    if let Some(v) = body.get("tagline") {
        let t = js_string(v).trim().to_string();
        if js_len(&t) > MAX_TAGLINE_LEN {
            errors.push(format!("tagline must be <= {MAX_TAGLINE_LEN} chars"));
        }
    }

    if let Some(v) = body.get("traits") {
        let tr = if is_truthy(v) { v } else { &Value::Null };
        if let Some(bs) = tr.get("bodyShape") {
            if !VALID_BODY_SHAPES.contains(&js_string(bs).to_lowercase().as_str()) {
                errors.push(format!(
                    "traits.bodyShape must be one of {}",
                    VALID_BODY_SHAPES.join(", ")
                ));
            }
        }
        if let Some(es) = tr.get("eyeStyle") {
            let mut eye = js_string(es).to_lowercase();
            if let Some(mapped) = legacy_eye_map(&eye) {
                eye = mapped.to_string();
            }
            if !VALID_EYE_STYLES.contains(&eye.as_str()) {
                errors.push(format!(
                    "traits.eyeStyle must be one of {}",
                    VALID_EYE_STYLES.join(", ")
                ));
            }
        }
        if let Some(c) = tr.get("color") {
            if !VALID_COLORS.contains(&js_string(c).to_lowercase().as_str()) {
                errors.push(format!(
                    "traits.color must be one of {}",
                    VALID_COLORS.join(", ")
                ));
            }
        }
    }

    if let Some(v) = body.get("accentHex") {
        if !v.is_null() {
            let s = js_string(v);
            if !s.is_empty() && !valid_hex(&s) {
                errors.push("accentHex must be #RRGGBB".to_string());
            }
        }
    }

    if let Some(v) = body.get("customImageUrl") {
        if !v.is_null() {
            let s = js_string(v);
            if !s.is_empty() {
                if s.len() > MAX_CUSTOM_IMAGE_RAW_LEN {
                    errors.push(format!(
                        "customImageUrl must be <= {MAX_CUSTOM_IMAGE_RAW_LEN} chars"
                    ));
                } else if !is_valid_data_image_url(&Value::String(s)) {
                    errors.push("customImageUrl must be data:image/(png|jpeg|webp);base64,... (decoded <=2MB, no http, no svg)".to_string());
                }
            }
        }
    }

    if let Some(v) = body.get("sliders") {
        let s = if is_truthy(v) { v } else { &Value::Null };
        for k in DEFAULT_SLIDER_KEYS {
            if let Some(sv) = s.get(k) {
                let n = js_number(sv);
                if !n.is_finite() || n < 0.0 || n > 100.0 {
                    errors.push(format!("sliders.{k} must be 0-100"));
                }
            }
        }
        let extra: Vec<String> = s
            .as_object()
            .map(|m| {
                m.keys()
                    .filter(|k| !DEFAULT_SLIDER_KEYS.contains(&k.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !extra.is_empty() {
            errors.push(format!("unknown slider keys: {}", extra.join(", ")));
        }
    }

    errors
}

// ---------------------------------------------------------------------------
// Persona mirror sync (workspace/users/<uid>/, symlink-guarded)
// ---------------------------------------------------------------------------

fn under_base(base: &Path, candidate: &Path) -> bool {
    candidate == base || candidate.starts_with(base)
}

fn sliders_to_lines(s: &Value) -> Vec<String> {
    let n = |k: &str| -> i64 { s.get(k).and_then(|v| v.as_i64()).unwrap_or(50) };
    let lean = |value: i64, high: &str, low: &str| -> String {
        // `value` is the percentage toward `high`.
        if value >= 50 {
            format!("Leans {high} ({value}%) over {low}")
        } else {
            format!("Leans {low} ({}%) over {high}", 100 - value)
        }
    };
    vec![
        lean(n("companionCoworker"), "coworker", "companion"),
        lean(n("genzBoomer"), "classic", "Gen Z"),
        lean(n("executeCollaborate"), "collaborating", "executing independently"),
        lean(n("playfulSerious"), "serious", "playful"),
        lean(n("politeUnfiltered"), "unfiltered", "polite"),
    ]
}

/// The generated `IDENTITY.md` (workspace root): name, handle, tagline, and
/// plain-language personality calibration from the Personality page sliders.
pub(crate) fn build_identity_md(
    name: &str,
    handle: &str,
    tagline: &str,
    personality: &str,
    sliders: &Value,
) -> String {
    let mut out = String::from(
        "_ Generated from the Personality page. Edit it there; changes here are overwritten.\n\n",
    );
    out.push_str(&format!(
        "# IDENTITY.md\n\n- **Name:** {name}\n- **Handle:** {handle}\n- **Tagline:** {tagline}\n\nYou are **{name}** ({handle}), a Personal Intelligence running on Amiro.\n\n## Personality\n\n"
    ));
    for line in sliders_to_lines(sliders) {
        out.push_str(&format!("- {line}\n"));
    }
    if !personality.trim().is_empty() {
        out.push_str(&format!("\nIn short: {}\n", personality.trim()));
    }
    out
}

/// `syncPersonaFiles` -- never fails the request; failures are logged only.
/// Write the owner's IDENTITY.md at the workspace root if it is missing, from
/// the saved identity (or the defaults). Without it a new agent would not know
/// its own name until someone saved the Personality page.
pub async fn ensure_owner_identity_file(state: &AppState) {
    if tokio::fs::try_exists(state.workspace.join("IDENTITY.md")).await.unwrap_or(false) {
        return;
    }
    let Some(owner) = crate::agent_home::owner_user(state).await else {
        return;
    };
    let Some(uid) = owner.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    match get_agent_identity(state, Some(&uid)).await {
        Ok(identity) => sync_persona_files(state, &identity, Some(&uid)).await,
        Err(err) => tracing::warn!(error = %err.1, "could not load identity for IDENTITY.md"),
    }
}

async fn sync_persona_files(state: &AppState, identity: &Value, user_id: Option<&str>) {
    if let Err(err) = sync_persona_files_inner(state, identity, user_id).await {
        tracing::warn!(error = %err, "failed to sync persona markdown files");
    }
}

async fn sync_persona_files_inner(
    state: &AppState,
    identity: &Value,
    user_id: Option<&str>,
) -> Result<(), String> {
    let uid = match sanitize_user_id(user_id) {
        Some(u) => u,
        None => return Ok(()),
    };
    let base_ws = state.workspace.clone();

    // Harden base: defend against workspaceDir itself being a symlink.
    let real_base_ws = match tokio::fs::canonicalize(&base_ws).await {
        Ok(p) => p,
        Err(_) => {
            let _ = tokio::fs::create_dir_all(&base_ws).await;
            tokio::fs::canonicalize(&base_ws)
                .await
                .unwrap_or_else(|_| base_ws.clone())
        }
    };

    let ws_dir = base_ws.join("users").join(&uid);
    let users_dir = base_ws.join("users");

    // Ensure the parent chain exists without following an attacker-planted symlink.
    if let Ok(md) = tokio::fs::symlink_metadata(&users_dir).await {
        if md.file_type().is_symlink() {
            let _ = tokio::fs::remove_file(&users_dir).await;
        }
    }
    tokio::fs::create_dir_all(&users_dir)
        .await
        .map_err(|e| e.to_string())?;

    match tokio::fs::symlink_metadata(&users_dir).await {
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err("users dir is a symlink".to_string());
            }
            let real_users = tokio::fs::canonicalize(&users_dir)
                .await
                .map_err(|e| e.to_string())?;
            if !under_base(&real_base_ws, &real_users) {
                return Err("users dir escapes workspace".to_string());
            }
        }
        Err(_) => {}
    }

    if let Ok(md) = tokio::fs::symlink_metadata(&ws_dir).await {
        if md.file_type().is_symlink() {
            let _ = tokio::fs::remove_file(&ws_dir).await;
        }
    }
    tokio::fs::create_dir_all(&ws_dir)
        .await
        .map_err(|e| e.to_string())?;

    let real_ws_dir = tokio::fs::canonicalize(&ws_dir)
        .await
        .unwrap_or_else(|_| ws_dir.clone());
    if !under_base(&real_base_ws, &real_ws_dir) {
        return Err("per-user dir escapes workspace".to_string());
    }

    let traits = normalize_traits(identity.get("traits").unwrap_or(&Value::Null));
    let name = js_string_or(identity.get("name"), "Amiro");
    let handle = js_string_or(identity.get("handle"), "@amiro");
    let tagline = js_string_or(identity.get("tagline"), DEFAULT_TAGLINE);
    let accent_hex = js_string_or(identity.get("accentHex"), ORANGE_HEX);
    let personality = js_string_or(identity.get("personalitySummary"), "");
    let updated_at = js_string_or(identity.get("updatedAt"), "");

    let s = normalize_sliders(identity.get("sliders").unwrap_or(&Value::Null));
    let identity_md = build_identity_md(
        &name,
        &handle,
        &tagline,
        &personality,
        &s,
    );
    let _ = (&accent_hex, &updated_at, &traits);

    // Guard each target against symlinks: remove any existing symlink before write.
    for name in ["IDENTITY.md", "prompt-overlay.md"] {
        let p = ws_dir.join(name);
        if let Ok(md) = tokio::fs::symlink_metadata(&p).await {
            if md.file_type().is_symlink() {
                let _ = tokio::fs::remove_file(&p).await;
            }
        }
    }
    tokio::fs::write(ws_dir.join("IDENTITY.md"), &identity_md)
        .await
        .map_err(|e| e.to_string())?;

    // The owner's agent home is the workspace root: IDENTITY.md there is the one
    // file owned by the Personality page, always regenerated. SOUL.md is the
    // agent's own and is only seeded (never overwritten) by `agent_home`.
    let is_owner = match crate::agent_home::owner_user(state).await {
        Some(owner) => owner.get("id").and_then(Value::as_str) == Some(uid.as_str()),
        None => true,
    };
    if is_owner {
        let root_identity = base_ws.join("IDENTITY.md");
        if let Ok(md) = tokio::fs::symlink_metadata(&root_identity).await {
            if md.file_type().is_symlink() {
                let _ = tokio::fs::remove_file(&root_identity).await;
            }
        }
        tokio::fs::write(&root_identity, &identity_md)
            .await
            .map_err(|e| e.to_string())?;
        crate::agent_home::seed(state).await;
    }

    // Per-user overlay only. Intentionally NOT the global home/prompt-overlay.md,
    // which would allow cross-user prompt injection.
    let mut overlay = format!("{}\n", build_persona_prompt_block(identity));
    // Metadata-only credential catalog: names and env vars, never values. Lets
    // the model reference `${AMIRO_CRED_...}` in tools without a secret ever
    // entering the prompt.
    let credentials_block = build_credential_prompt_block(&state.home);
    if !credentials_block.is_empty() {
        overlay.push('\n');
        overlay.push_str(&credentials_block);
        overlay.push('\n');
    }
    tokio::fs::write(ws_dir.join("prompt-overlay.md"), overlay)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Amiro runtime memory graph reader (engine storage) -- READ ONLY
// ---------------------------------------------------------------------------

fn empty_memory_graph() -> Value {
    json!({
        "graph_version": 2,
        "memories": {},
        "tags": {},
        "clusters": [],
        "edges": {},
        "reverse_edges": {},
        "metadata": { "retrieval_count": 0, "link_discovery_count": 0 },
    })
}

async fn read_json_safe(path: &Path, fallback: Value) -> Value {
    match tokio::fs::read_to_string(path).await {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn normalize_category_field(raw: &Value) -> String {
    match raw {
        Value::String(s) => {
            let t = s.trim().to_lowercase();
            if t.is_empty() {
                "fact".to_string()
            } else {
                t
            }
        }
        Value::Object(m) => {
            // Rust tagged enum: { Custom: "myCat" }, { Standard: "fact" }, or { name: "fact" }.
            if m.len() == 1 {
                let (k, v) = m.iter().next().unwrap();
                if let Value::String(s) = v {
                    let t = s.trim().to_lowercase();
                    return if t.is_empty() {
                        k.to_lowercase()
                    } else {
                        t
                    };
                }
                if let Value::Object(inner) = v {
                    for key in ["name", "value", "category"] {
                        if let Some(Value::String(s)) = inner.get(key) {
                            let t = s.trim().to_lowercase();
                            return if t.is_empty() {
                                k.to_lowercase()
                            } else {
                                t
                            };
                        }
                    }
                }
                return k.to_lowercase();
            }
            for key in ["name", "value"] {
                if let Some(Value::String(s)) = m.get(key) {
                    let t = s.trim().to_lowercase();
                    return if t.is_empty() {
                        "fact".to_string()
                    } else {
                        t
                    };
                }
            }
            "fact".to_string()
        }
        _ => "fact".to_string(),
    }
}

fn rel_posix(base: &Path, target: &Path) -> String {
    match target.strip_prefix(base) {
        Ok(rest) => rest
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => target.to_string_lossy().to_string(),
    }
}

fn parse_iso_millis(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// `loadAllMemoryGraphs` -- read-only ingestion of global + project memory JSONs.
pub async fn load_all_memory_graphs(state: &AppState) -> Value {
    let mem_dir = state.runtime_home.join("memory");
    let global_path = mem_dir.join("global.json");
    let projects_dir = mem_dir.join("projects");

    let mut scopes: Vec<Value> = Vec::new();
    let mut memories: Vec<Value> = Vec::new();
    let mut explicit_edges: Vec<Value> = Vec::new();
    let mut all_tags: BTreeSet<String> = BTreeSet::new();
    let mut by_category: BTreeMap<String, i64> = BTreeMap::new();

    async fn ingest(
        state: &AppState,
        file_path: &Path,
        scope_id: &str,
        scope_kind: &str,
        scope_label: &str,
        scopes: &mut Vec<Value>,
        memories: &mut Vec<Value>,
        explicit_edges: &mut Vec<Value>,
        all_tags: &mut BTreeSet<String>,
        by_category: &mut BTreeMap<String, i64>,
    ) {
        let stat = tokio::fs::metadata(file_path).await.ok();
        if stat.is_none() && scope_kind != "global" {
            return;
        }
        let doc = read_json_safe(file_path, empty_memory_graph()).await;
        let raw_memories = doc.get("memories").cloned().unwrap_or(json!({}));
        let entries: Vec<Value> = match raw_memories {
            Value::Array(a) => a,
            Value::Object(m) => m.into_values().collect(),
            _ => Vec::new(),
        };

        let mtime_iso = stat
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(sys_time_iso);

        let mut active_in_scope = 0i64;
        for m in entries {
            if !m.is_object() {
                continue;
            }
            let superseded = m.get("superseded_by").map(is_truthy).unwrap_or(false);
            let active_flag = !matches!(m.get("active"), Some(Value::Bool(false)));
            let active = active_flag && !superseded;
            if active {
                active_in_scope += 1;
            }
            let category = normalize_category_field(m.get("category").unwrap_or(&Value::Null));
            if active {
                *by_category.entry(category.clone()).or_insert(0) += 1;
            }
            let tags: Vec<String> = match m.get("tags") {
                Some(Value::Array(a)) => a.iter().map(|t| js_string(t)).collect(),
                Some(Value::Object(o)) => o
                    .keys()
                    .map(|k| k.strip_prefix("tag:").unwrap_or(k).to_string())
                    .collect(),
                _ => match m.get("tag") {
                    Some(Value::Array(a)) => a.iter().map(|t| js_string(t)).collect(),
                    _ => Vec::new(),
                },
            };
            for t in &tags {
                if !t.is_empty() {
                    all_tags.insert(t.clone());
                }
            }
            let reinforcements_count = match m.get("reinforcements") {
                Some(Value::Array(a)) => a.len() as i64,
                Some(v) => js_number(v) as i64,
                None => 0,
            };
            let num_or = |key: &str, dflt: f64| -> f64 {
                match m.get(key) {
                    Some(Value::Null) | None => dflt,
                    Some(v) => js_number(v),
                }
            };
            let id = match m.get("id") {
                Some(v) if is_truthy(v) => js_string(v),
                _ => format!("mem_{}", uuid::Uuid::new_v4()),
            };
            let created = match m.get("created_at").or_else(|| m.get("createdAt")) {
                Some(v) if is_truthy(v) => js_string(v),
                _ => mtime_iso.clone().unwrap_or_else(now_iso),
            };
            let updated = match m.get("updated_at").or_else(|| m.get("updatedAt")) {
                Some(v) if is_truthy(v) => js_string(v),
                _ => mtime_iso.clone().unwrap_or_else(now_iso),
            };
            memories.push(json!({
                "id": id,
                "content": js_string_or(m.get("content"), ""),
                "category": category,
                "scope": scope_id,
                "scopeKind": scope_kind,
                "scopeLabel": scope_label,
                "tags": tags,
                "source": js_string_or(m.get("source"), "local"),
                "trust": js_string_or(m.get("trust"), "high"),
                "strength": num_or("strength", 1.0),
                "confidence": num_or("confidence", 1.0),
                "accessCount": num_or("access_count", 0.0),
                "reinforcements": reinforcements_count,
                "active": active,
                "createdAt": created,
                "updatedAt": updated,
            }));
        }

        if let Some(Value::Object(raw_edges)) = doc.get("edges") {
            for (from_id, targets) in raw_edges {
                let list: Vec<Value> = match targets {
                    Value::Array(a) => a.clone(),
                    Value::Object(o) => o.keys().map(|k| Value::String(k.clone())).collect(),
                    _ => Vec::new(),
                };
                for t in list {
                    let to_id = match &t {
                        Value::String(s) => s.clone(),
                        Value::Object(o) => {
                            match o.get("target").or_else(|| o.get("to")) {
                                Some(v) if is_truthy(v) => js_string(v),
                                _ => continue,
                            }
                        }
                        _ => continue,
                    };
                    if from_id.is_empty() || to_id.is_empty() {
                        continue;
                    }
                    let label = match &t {
                        Value::Object(o) => match o.get("kind") {
                            Some(v) if is_truthy(v) => js_string(v),
                            _ => "linked".to_string(),
                        },
                        _ => "linked".to_string(),
                    };
                    explicit_edges.push(json!({
                        "id": format!("{from_id}->{to_id}"),
                        "source": from_id,
                        "target": to_id,
                        "kind": "explicit",
                        "label": label,
                    }));
                }
            }
        }

        if let Some(Value::Object(doc_tags)) = doc.get("tags") {
            for k in doc_tags.keys() {
                all_tags.insert(k.clone());
            }
        }

        scopes.push(json!({
            "id": scope_id,
            "label": scope_label,
            "kind": scope_kind,
            "file": rel_posix(&state.runtime_home, file_path),
            "count": active_in_scope,
            "updatedAt": mtime_iso,
        }));
    }

    ingest(
        state,
        &global_path,
        "global",
        "global",
        "Global Memory",
        &mut scopes,
        &mut memories,
        &mut explicit_edges,
        &mut all_tags,
        &mut by_category,
    )
    .await;

    if let Ok(mut rd) = tokio::fs::read_dir(&projects_dir).await {
        let mut files: Vec<String> = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                files.push(name);
            }
        }
        files.sort();
        for file in files {
            let hash = file.trim_end_matches(".json").to_string();
            let label = format!("Project {}", slice_chars(&hash, 8));
            let full = projects_dir.join(&file);
            ingest(
                state,
                &full,
                &hash,
                "project",
                &label,
                &mut scopes,
                &mut memories,
                &mut explicit_edges,
                &mut all_tags,
                &mut by_category,
            )
            .await;
        }
    }

    // Newest first (stable, matching Array.prototype.sort stability).
    memories.sort_by(|a, b| {
        let ta = parse_iso_millis(&js_string_or(a.get("updatedAt"), ""));
        let tb = parse_iso_millis(&js_string_or(b.get("updatedAt"), ""));
        tb.cmp(&ta)
    });

    let active_memories: Vec<&Value> = memories
        .iter()
        .filter(|m| m.get("active") == Some(&Value::Bool(true)))
        .collect();

    let mut edge_map: BTreeMap<String, Value> = BTreeMap::new();
    let mut edge_order: Vec<String> = Vec::new();
    for e in &explicit_edges {
        let id = js_string_or(e.get("id"), "");
        if !edge_map.contains_key(&id) {
            edge_order.push(id.clone());
        }
        edge_map.insert(id, e.clone());
    }

    let mut by_tag: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut tag_order: Vec<String> = Vec::new();
    for m in &active_memories {
        let id = js_string_or(m.get("id"), "");
        if let Some(Value::Array(tags)) = m.get("tags") {
            for tag in tags {
                let t = js_string(tag);
                if !by_tag.contains_key(&t) {
                    tag_order.push(t.clone());
                    by_tag.insert(t.clone(), Vec::new());
                }
                by_tag.get_mut(&t).unwrap().push(id.clone());
            }
        }
    }
    for tag in &tag_order {
        let ids = by_tag.get(tag).cloned().unwrap_or_default();
        for i in 0..ids.len() {
            let end = ids.len().min(i + 4);
            for j in (i + 1)..end {
                let key = format!("{}<->{}", ids[i], ids[j]);
                if !edge_map.contains_key(&key) {
                    edge_map.insert(
                        key.clone(),
                        json!({
                            "id": key,
                            "source": ids[i],
                            "target": ids[j],
                            "kind": "tag",
                            "label": format!("#{tag}"),
                        }),
                    );
                    edge_order.push(key);
                }
            }
        }
    }

    let mut by_cat: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut cat_order: Vec<String> = Vec::new();
    for m in &active_memories {
        let cat = js_string_or(m.get("category"), "fact");
        if !by_cat.contains_key(&cat) {
            cat_order.push(cat.clone());
            by_cat.insert(cat.clone(), Vec::new());
        }
        by_cat
            .get_mut(&cat)
            .unwrap()
            .push((*m).clone());
    }
    for cat in &cat_order {
        let list = by_cat.get(cat).cloned().unwrap_or_default();
        for i in 0..list.len() {
            if i + 1 < list.len() {
                let a = js_string_or(list[i].get("id"), "");
                let b = js_string_or(list[i + 1].get("id"), "");
                let key = format!("cat:{a}->{b}");
                if !edge_map.contains_key(&key) {
                    edge_map.insert(
                        key.clone(),
                        json!({
                            "id": key,
                            "source": a,
                            "target": b,
                            "kind": "category",
                            "label": cat,
                        }),
                    );
                    edge_order.push(key);
                }
            }
        }
    }

    let mut edges: Vec<Value> = Vec::new();
    for id in &edge_order {
        if let Some(e) = edge_map.get(id) {
            edges.push(e.clone());
        }
    }

    let project_count = active_memories
        .iter()
        .filter(|m| m.get("scopeKind") == Some(&Value::String("project".into())))
        .count();
    let global_count = active_memories
        .iter()
        .filter(|m| m.get("scopeKind") == Some(&Value::String("global".into())))
        .count();

    let mut by_category_obj = Map::new();
    for (k, v) in &by_category {
        by_category_obj.insert(k.clone(), json!(v));
    }

    json!({
        "stats": {
            "total": active_memories.len(),
            "allRecords": memories.len(),
            "active": active_memories.len(),
            "superseded": memories.len() - active_memories.len(),
            "projectCount": project_count,
            "globalCount": global_count,
            "uniqueTags": all_tags.len(),
            "byCategory": Value::Object(by_category_obj),
        },
        "scopes": scopes,
        "memories": active_memories.iter().map(|m| (*m).clone()).collect::<Vec<Value>>(),
        "edges": edges,
    })
}

fn empty_memory_stats() -> Value {
    json!({
        "total": 0,
        "active": 0,
        "superseded": 0,
        "projectCount": 0,
        "globalCount": 0,
        "uniqueTags": 0,
        "byCategory": {},
    })
}

// ---------------------------------------------------------------------------
// Workspace file browser (admin-gated, allowlisted, realpath-contained)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct WorkspaceRoot {
    id: &'static str,
    label: &'static str,
    base_path: PathBuf,
    description: &'static str,
}

/// Repository root for the `project` workspace root -- the native equivalent of
/// the adapter's `path.resolve(ctx.config.outDir, '..')`. Prefers an explicit
/// override, then the parent of the native `out_dir` helper, then the crate's
/// parent directory, then the workspace's parent.
fn repo_root(state: &AppState) -> PathBuf {
    if let Ok(explicit) = std::env::var("AMIRO_REPO_ROOT") {
        if !explicit.is_empty() {
            return PathBuf::from(explicit);
        }
    }
    if let Some(parent) = crate::state::out_dir(state).parent() {
        if parent.is_dir() {
            return parent.to_path_buf();
        }
    }
    if let Some(parent) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        return parent.to_path_buf();
    }
    state
        .workspace
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| state.workspace.clone())
}

fn workspace_roots(state: &AppState, user_id: &str) -> Vec<WorkspaceRoot> {
    // The `amiro` root is the current user's persona directory. `syncPersonaFiles`
    // mirrors IDENTITY.md / SOUL.md / prompt-overlay.md into
    // workspace/users/<userId>/, so rooting here makes those promised files
    // visible at the root instead of buried behind a hidden `users/` node.
    let persona_base = match sanitize_user_id(Some(user_id)) {
        Some(uid) => state.workspace.join("users").join(uid),
        None => state.workspace.clone(),
    };
    vec![
        WorkspaceRoot {
            id: "runtime",
            label: "Runtime",
            base_path: state.runtime_home.clone(),
            description: "Runtime files (read-only)",
        },
        WorkspaceRoot {
            id: "amiro",
            label: "Persona",
            base_path: persona_base,
            description: "Your agent identity and personality files (read-only)",
        },
        WorkspaceRoot {
            id: "project",
            label: "Project",
            base_path: repo_root(state),
            description: "Files in the current project (read-only)",
        },
    ]
}

const BLOCKED_WORKSPACE_NAMES: [&str; 18] = [
    ".env",
    ".env.local",
    ".env.production",
    "auth.json",
    "credentials.json",
    "users.json",
    "sessions.json",
    "admin-initial-password",
    "keys.enc",
    "node_modules",
    ".git",
    ".next",
    "openai-auth.json",
    "openai_oauth_usage.json",
    "antigravity_oauth.json",
    "auth-refresh-state.json",
    "servers.json",
    ".jcode",
];

fn split_rel_parts(rel: &str) -> Vec<&str> {
    rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect()
}

pub(crate) fn is_blocked_workspace_path(rel_path: &str) -> bool {
    for part in split_rel_parts(rel_path) {
        if BLOCKED_WORKSPACE_NAMES.contains(&part) {
            return true;
        }
        // `~/.jcode` is the embedded engine's real legacy state directory.
        if part == ".ssh" || part == ".aws" || part == ".gnupg" {
            return true;
        }
        if part.ends_with(".env")
            || part.ends_with(".key")
            || part.ends_with(".pem")
            || part.ends_with(".sock")
        {
            return true;
        }
    }
    let lower = rel_path.to_lowercase();
    if lower.contains("/sessions/") || lower.starts_with("sessions/") {
        return true;
    }
    if lower.contains("/client_sessions/") || lower.starts_with("client_sessions/") {
        return true;
    }
    if lower.contains("/pending-login/") || lower.starts_with("pending-login/") {
        return true;
    }
    false
}

/// Allowlist for each root: only these relative posix paths are readable.
///
/// Directory nodes are allowed explicitly. The adapter's `startsWith('memory/')`
/// form excluded the `memory` / `skills` / `users` nodes themselves, which hid
/// those directories from a root listing so the browser could never descend into
/// them. Individual files still pass through the per-path containment, blocklist,
/// and realpath checks that follow.
fn is_allowed_workspace_rel(root_id: &str, rel_posix: &str) -> bool {
    let rel = rel_posix.trim_start_matches('/');
    if rel.is_empty() || rel == "." {
        return true; // listing the root itself
    }
    if is_blocked_workspace_path(rel) {
        return false;
    }
    match root_id {
        "runtime" => {
            if rel == "prompt-overlay.md" || rel == "config.toml" {
                return true;
            }
            // Directory nodes stay listed so the browser can descend.
            if rel == "memory" || rel == "skills" || rel == "projects" {
                return true;
            }
            rel.starts_with("memory/") || rel.starts_with("skills/")
        }
        "amiro" => {
            if rel == "IDENTITY.md" || rel == "SOUL.md" || rel == "prompt-overlay.md" {
                return true;
            }
            if rel == "users" || rel == "skills" {
                return true;
            }
            if let Some(rest) = rel.strip_prefix("users/") {
                let parts: Vec<&str> = rest.split('/').collect();
                if parts.len() == 1 {
                    // The per-user persona directory itself.
                    return !parts[0].is_empty();
                }
                // users/<userId>/IDENTITY.md | SOUL.md | prompt-overlay.md
                return parts.len() == 2
                    && ["IDENTITY.md", "SOUL.md", "prompt-overlay.md"].contains(&parts[1]);
            }
            rel.starts_with("skills/")
        }
        "project" => !rel.contains(".."),
        _ => false,
    }
}

/// The workspace is display-only: mirrors under users/<uid>/ are regenerated from
/// JSON by the identity/personality PUTs and no workspace write is allowed, so the
/// UI never offers a fake-edit affordance.
fn is_writable_workspace_rel(_root_id: &str, _rel_posix: &str, _user_id: &str) -> bool {
    false
}

#[allow(dead_code)]
struct ContainedPath {
    resolved_base: PathBuf,
    resolved_target: PathBuf,
    clean_rel: String,
    real_rel: String,
}

fn forbidden(msg: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, msg.to_string())
}

/// `resolveContainedWorkspacePath` -- allowlist first, then lexical traversal
/// checks, then realpath (symlink) containment, then a re-check against the
/// resolved relative path.
async fn resolve_contained_workspace_path(
    base_dir: &Path,
    rel_path: &str,
    root_id: &str,
    user_id: &str,
    for_write: bool,
) -> Result<ContainedPath, ApiError> {
    let clean_rel_input = rel_path.trim_start_matches('/').to_string();
    let posix_rel = clean_rel_input.replace('\\', "/");

    if !posix_rel.is_empty() && !is_allowed_workspace_rel(root_id, &posix_rel) {
        return Err(if for_write {
            forbidden("file is read-only or not allowlisted")
        } else {
            forbidden("access to this file is not allowed")
        });
    }
    if is_blocked_workspace_path(&clean_rel_input) {
        return Err(forbidden("access to sensitive file is not allowed"));
    }

    let resolved_base = base_dir.to_path_buf();
    let resolved_target = normalize_path(&resolved_base.join(&clean_rel_input));
    if !under_base(&resolved_base, &resolved_target) {
        return Err(forbidden("path traversal is not allowed"));
    }

    let real_base = tokio::fs::canonicalize(&resolved_base)
        .await
        .unwrap_or_else(|_| resolved_base.clone());

    let real_target = match tokio::fs::canonicalize(&resolved_target).await {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = resolved_target.parent().unwrap_or(&resolved_base);
            match tokio::fs::canonicalize(parent).await {
                Ok(parent_real) => parent_real.join(
                    resolved_target
                        .file_name()
                        .map(|f| f.to_os_string())
                        .unwrap_or_default(),
                ),
                Err(_) => resolved_target.clone(),
            }
        }
        Err(_) => resolved_target.clone(),
    };

    if !under_base(&real_base, &real_target) {
        return Err(forbidden("path traversal via symlink is not allowed"));
    }

    let real_rel = path_to_posix(&real_target, &real_base);
    if !real_rel.is_empty() && real_rel != "." && !is_allowed_workspace_rel(root_id, &real_rel) {
        return Err(forbidden("access to this file is not allowed"));
    }
    if is_blocked_workspace_path(&real_rel) {
        return Err(forbidden("access to sensitive file is not allowed"));
    }
    if for_write && !is_writable_workspace_rel(root_id, &real_rel, user_id) {
        return Err(forbidden("file is read-only"));
    }

    let clean_rel = path_to_posix(&resolved_target, &resolved_base);
    Ok(ContainedPath {
        resolved_base,
        resolved_target: real_target,
        clean_rel,
        real_rel,
    })
}

/// Lexical normalization (`path.resolve` equivalent) without touching the filesystem.
fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn path_to_posix(target: &Path, base: &Path) -> String {
    rel_posix(base, target)
}

/// Index of the first `=` outside a quoted key/value on this line.
fn find_assignment_eq(line: &str) -> Option<usize> {
    let mut in_quote: Option<char> = None;
    for (i, c) in line.char_indices() {
        match in_quote {
            Some(q) => {
                if c == q {
                    in_quote = None;
                }
            }
            None => {
                if c == '"' || c == '\'' {
                    in_quote = Some(c);
                } else if c == '=' {
                    return Some(i);
                }
            }
        }
    }
    None
}

/// The runtime's `config.toml` is allowlisted for browsing, but it can hold
/// provider credentials inline. Mask any credential-bearing assignment before the
/// bytes leave the process: key names containing key/token/secret/password/
/// credential/auth, plus values that look like provider API keys.
fn redact_config_secrets(content: &str) -> String {
    const SENSITIVE: [&str; 7] = [
        "key",
        "token",
        "secret",
        "password",
        "credential",
        "auth",
        "passwd",
    ];
    const KEY_PREFIXES: [&str; 9] = [
        "sk-",
        "rk-",
        "ghp_",
        "gho_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "AKIA",
        "AIza",
    ];

    let mut out = String::with_capacity(content.len());
    for (i, line) in content.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let is_section = line.trim_start().starts_with('[');
        let eq = if is_section {
            None
        } else {
            find_assignment_eq(line)
        };
        match eq {
            Some(pos) => {
                let key = &line[..pos];
                let value = &line[pos + 1..];
                let key_lower = key.to_lowercase();
                let sensitive = SENSITIVE.iter().any(|s| key_lower.contains(s));
                let value_trim = value.trim().trim_matches('"').trim_matches('\'');
                let looks_like_key = KEY_PREFIXES.iter().any(|p| value_trim.starts_with(p));
                if sensitive || looks_like_key {
                    out.push_str(key);
                    out.push_str("= \"[redacted]\"");
                } else {
                    out.push_str(line);
                }
            }
            None => out.push_str(line),
        }
    }
    out
}

fn detect_language(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".md" | ".mdx" => "markdown",
        ".json" => "json",
        ".toml" => "toml",
        ".ts" | ".tsx" => "typescript",
        ".js" | ".mjs" => "javascript",
        ".css" => "css",
        _ => "text",
    }
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    let role = user.0.get("role").map(js_string).unwrap_or_default();
    if role == "admin" {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::FORBIDDEN,
            "Forbidden: admin required".to_string(),
        ))
    }
}

fn user_id_of(user: &AuthUser) -> String {
    user.0.get("id").map(js_string).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

fn bad_request(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn read_only_error() -> ApiError {
    ApiError(
        StatusCode::NOT_IMPLEMENTED,
        "Amiro runtime memory is read-only via the adapter".to_string(),
    )
}

/// GET /api/agent/identity -- per-user agent identity, avatar, personality.
async fn get_identity(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let identity = get_agent_identity(&state, Some(&uid)).await?;
    let fingerprint = persona_fingerprint(&identity);
    let role = user.0.get("role").map(js_string).unwrap_or_default();

    let mut out = match identity {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    // Only admin gets machine memory stats; other users get identity alone to
    // avoid leaking shared machine state.
    if role == "admin" {
        let graph = load_all_memory_graphs(&state).await;
        let stats = graph
            .get("stats")
            .cloned()
            .unwrap_or_else(empty_memory_stats);
        out.insert("memoryStats".to_string(), stats);
    }
    out.insert("fingerprint".to_string(), Value::String(fingerprint));
    Ok(Json(Value::Object(out)))
}

/// PUT /api/agent/identity -- per-user update with strict validation.
pub(crate) async fn put_identity(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let errors = validate_identity_payload(&body);
    if !errors.is_empty() {
        return Err(bad_request(errors.join("; ")));
    }
    let uid = user_id_of(&user);

    let _guard = state.store.lock().await;
    let current = get_agent_identity(&state, Some(&uid)).await?;

    let next_traits = match body.get("traits") {
        Some(patch) if is_truthy(patch) => {
            let mut merged = match current.get("traits") {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            if let Some(Value::Object(p)) = body.get("traits") {
                for (k, v) in p {
                    merged.insert(k.clone(), v.clone());
                }
            }
            normalize_traits(&Value::Object(merged))
        }
        Some(_) => normalize_traits(current.get("traits").unwrap_or(&Value::Null)),
        None => current.get("traits").cloned().unwrap_or(Value::Null),
    };

    let next_sliders = match body.get("sliders") {
        Some(s) if is_truthy(s) => normalize_sliders(s),
        _ => current.get("sliders").cloned().unwrap_or(Value::Null),
    };

    let current_name = js_string_or(current.get("name"), "Amiro");
    let next_name = match body.get("name") {
        Some(v) => {
            let t = js_string(v).trim().to_string();
            if t.is_empty() {
                current_name.clone()
            } else {
                t
            }
        }
        None => current_name.clone(),
    };

    let next_handle = match body.get("handle") {
        Some(v) => {
            let t = js_string(v).trim().to_string();
            if t.is_empty() {
                format!("@{}", alpha_lower(&next_name))
            } else {
                t
            }
        }
        None => {
            let a = alpha_lower(&next_name);
            if a.is_empty() {
                "@amiro".to_string()
            } else {
                format!("@{a}")
            }
        }
    };
    if !valid_handle(&next_handle) {
        return Err(bad_request(
            "handle must be @alphanumeric (1-32 chars)".to_string(),
        ));
    }

    let palette_for_traits = {
        let color = js_string_or(next_traits.get("color"), DEFAULT_COLOR);
        accent_palette(&color).unwrap_or(ORANGE_HEX).to_string()
    };
    let next_accent = match body.get("accentHex") {
        Some(v) => {
            let s = js_string(v);
            if is_truthy(v) && valid_hex(&s) {
                s
            } else {
                palette_for_traits.clone()
            }
        }
        None => palette_for_traits.clone(),
    };

    let mut next_image = current.get("customImageUrl").cloned().unwrap_or(Value::Null);
    if let Some(v) = body.get("customImageUrl") {
        if v.is_null() || js_string(v).is_empty() {
            next_image = Value::Null;
        } else {
            let s = js_string(v);
            if !is_valid_data_image_url(&Value::String(s.clone())) {
                return Err(bad_request("customImageUrl must be data:image/(png|jpeg|webp);base64,... (decoded <=2MB, no http, no svg)".to_string()));
            }
            next_image = Value::String(s);
        }
    }

    let current_tagline = js_string_or(current.get("tagline"), DEFAULT_TAGLINE);
    let next_tagline = match body.get("tagline") {
        Some(v) => slice_chars(js_string(v).trim(), MAX_TAGLINE_LEN),
        None => slice_chars(&current_tagline, MAX_TAGLINE_LEN),
    };

    let updated = json!({
        "name": slice_chars(&next_name, MAX_NAME_LEN),
        "handle": slice_chars(&next_handle, MAX_HANDLE_LEN + 1),
        "tagline": next_tagline,
        "traits": next_traits,
        "accentHex": next_accent,
        "customImageUrl": next_image,
        "sliders": next_sliders,
        "personalitySummary": summarize_personality(&next_sliders),
        "updatedAt": now_iso(),
    });

    write_json(&store_path(&state, &identity_key_for_user(Some(&uid))), &updated).await?;
    sync_persona_files(&state, &updated, Some(&uid)).await;

    let fingerprint = persona_fingerprint(&updated);
    let mut out = match updated {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.insert("fingerprint".to_string(), Value::String(fingerprint));
    Ok(Json(Value::Object(out)))
}

/// GET /api/agent/personality -- per-user read of the 5 sliders and persona summary.
async fn get_personality(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let identity = get_agent_identity(&state, Some(&uid)).await?;
    let fingerprint = persona_fingerprint(&identity);
    Ok(Json(json!({
        "name": identity.get("name").cloned().unwrap_or(Value::Null),
        "sliders": identity.get("sliders").cloned().unwrap_or(Value::Null),
        "personalitySummary": identity.get("personalitySummary").cloned().unwrap_or(Value::Null),
        "accentHex": identity.get("accentHex").cloned().unwrap_or(Value::Null),
        "traits": identity.get("traits").cloned().unwrap_or(Value::Null),
        "updatedAt": identity.get("updatedAt").cloned().unwrap_or(Value::Null),
        "fingerprint": fingerprint,
    })))
}

/// PUT /api/agent/personality -- per-user update; never mutates the runtime's
/// global memory (the engine owns its own memory writes through the native SDK).
async fn put_personality(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    // Support both {sliders:{...}} and a bare sliders object.
    let slider_input = match body.get("sliders") {
        Some(s) if is_truthy(s) => s.clone(),
        _ => body.clone(),
    };
    let candidate = json!({
        "sliders": slider_input,
        "name": body.get("name").cloned().unwrap_or(Value::Null),
    });
    let errors = validate_identity_payload(&candidate);
    if !errors.is_empty() {
        return Err(bad_request(errors.join("; ")));
    }

    let uid = user_id_of(&user);
    let _guard = state.store.lock().await;
    let current = get_agent_identity(&state, Some(&uid)).await?;

    let sliders = normalize_sliders(&slider_input);
    let personality_summary = summarize_personality(&sliders);

    let mut updated = match current {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    if let Some(v) = body.get("name") {
        if is_truthy(v) {
            let t = js_string(v).trim().to_string();
            let name = slice_chars(&t, MAX_NAME_LEN);
            if !name.is_empty() {
                updated.insert("name".to_string(), Value::String(name));
            }
        }
    }
    updated.insert("sliders".to_string(), sliders);
    updated.insert(
        "personalitySummary".to_string(),
        Value::String(personality_summary),
    );
    updated.insert("updatedAt".to_string(), Value::String(now_iso()));
    let updated = Value::Object(updated);

    write_json(&store_path(&state, &identity_key_for_user(Some(&uid))), &updated).await?;
    sync_persona_files(&state, &updated, Some(&uid)).await;

    let fingerprint = persona_fingerprint(&updated);
    let mut out = match updated {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.insert("fingerprint".to_string(), Value::String(fingerprint));
    Ok(Json(Value::Object(out)))
}

/// GET /api/agent/memory -- READ ONLY, admin-gated.
async fn get_memory(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let graph = load_all_memory_graphs(&state).await;
    let mut out = match graph {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.insert("readOnly".to_string(), Value::Bool(true));
    out.insert(
        "message".to_string(),
        Value::String("Amiro runtime memory is read-only via the adapter".to_string()),
    );
    Ok(Json(Value::Object(out)))
}

/// POST /api/agent/memory -- 501 read-only.
async fn post_memory(_user: AuthUser) -> Result<Json<Value>, ApiError> {
    Err(ApiError(
        StatusCode::NOT_IMPLEMENTED,
        "Amiro runtime memory is read-only via the adapter (use the runtime SDK directly)"
            .to_string(),
    ))
}

/// POST /api/agent/memory/:id/reinforce -- 501 read-only.
async fn post_reinforce(_user: AuthUser) -> Result<Json<Value>, ApiError> {
    Err(read_only_error())
}

/// DELETE /api/agent/memory/:id -- 501 read-only.
async fn delete_memory(_user: AuthUser) -> Result<Json<Value>, ApiError> {
    Err(read_only_error())
}

/// GET /api/agent/workspace -- admin-gated, allowlisted, realpath-contained.
async fn get_workspace(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let uid = user_id_of(&user);
    let roots = workspace_roots(&state, &uid);
    let root_id = params
        .get("root")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "runtime".to_string());
    let rel_path = params.get("path").cloned().unwrap_or_default();
    let active = roots
        .iter()
        .find(|r| r.id == root_id)
        .unwrap_or(&roots[0]);

    let _ = tokio::fs::create_dir_all(&active.base_path).await;

    let contained = resolve_contained_workspace_path(
        &active.base_path,
        &rel_path,
        active.id,
        &uid,
        false,
    )
    .await?;

    let mut entries: Vec<Value> = Vec::new();
    let mut rd = tokio::fs::read_dir(&contained.resolved_target)
        .await
        .map_err(|e| bad_request(e.to_string()))?;

    let real_base = tokio::fs::canonicalize(&active.base_path)
        .await
        .unwrap_or_else(|_| active.base_path.clone());

    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| bad_request(e.to_string()))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if BLOCKED_WORKSPACE_NAMES.contains(&name.as_str()) {
            continue;
        }
        if name.ends_with(".sock") || name.ends_with(".lock") || name.ends_with(".bak") {
            continue;
        }
        let entry_rel_posix = if contained.clean_rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", contained.clean_rel, name)
        };
        if !is_allowed_workspace_rel(active.id, &entry_rel_posix) {
            continue;
        }
        if is_blocked_workspace_path(&entry_rel_posix) {
            continue;
        }
        let full = contained.resolved_target.join(&name);

        // Realpath containment for the child: skip symlinks escaping the root.
        if let Ok(real_full) = tokio::fs::canonicalize(&full).await {
            if !under_base(&real_base, &real_full) {
                continue;
            }
            let real_rel_child = path_to_posix(&real_full, &real_base);
            if !is_allowed_workspace_rel(active.id, &real_rel_child) {
                continue;
            }
            if is_blocked_workspace_path(&real_rel_child) {
                continue;
            }
        }

        let md = match tokio::fs::metadata(&full).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = md.is_dir();
        let updated_at = md
            .modified()
            .ok()
            .map(sys_time_iso)
            .unwrap_or_else(now_iso);
        let ext = if is_dir {
            String::new()
        } else {
            full.extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default()
        };
        entries.push(json!({
            "name": name,
            "path": entry_rel_posix,
            "kind": if is_dir { "dir" } else { "file" },
            "size": if is_dir { 0 } else { md.len() },
            "updatedAt": updated_at,
            "ext": ext,
        }));
    }

    entries.sort_by(|a, b| {
        let ad = a.get("kind").and_then(|v| v.as_str()) == Some("dir");
        let bd = b.get("kind").and_then(|v| v.as_str()) == Some("dir");
        if ad != bd {
            return if ad {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        let an = js_string_or(a.get("name"), "");
        let bn = js_string_or(b.get("name"), "");
        an.cmp(&bn)
    });

    // The workspace is a read-only preview everywhere. Host paths stay on
    // the server: the UI only needs the id, label and description.
    let roots_out: Vec<Value> = roots
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "label": r.label,
                "description": r.description,
                "allowlisted": true,
            })
        })
        .collect();

    let current_path = if contained.clean_rel == "." {
        String::new()
    } else {
        contained.clean_rel.clone()
    };

    Ok(Json(json!({
        "roots": roots_out,
        "activeRoot": active.id,
        "currentPath": current_path,
        "entries": entries,
        "readOnly": true,
    })))
}

/// GET /api/agent/workspace/file -- admin-gated, allowlisted, realpath-contained.
async fn get_workspace_file(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let uid = user_id_of(&user);
    let roots = workspace_roots(&state, &uid);
    let root_id = params
        .get("root")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "runtime".to_string());
    let rel_path = params.get("path").cloned().unwrap_or_default();
    let active = roots
        .iter()
        .find(|r| r.id == root_id)
        .unwrap_or(&roots[0]);

    if rel_path.is_empty() {
        return Ok(Json(json!({
            "root": active.id,
            "path": "",
            "name": "",
            "size": 0,
            "updatedAt": now_iso(),
            "ext": "",
            "language": "text",
            "writable": false,
            "truncated": false,
            "content": "",
            "readOnly": true,
        })));
    }

    let contained = resolve_contained_workspace_path(
        &active.base_path,
        &rel_path,
        active.id,
        &uid,
        false,
    )
    .await?;

    let md = tokio::fs::metadata(&contained.resolved_target)
        .await
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
    if md.is_dir() {
        return Err(bad_request("path is a directory".to_string()));
    }

    let len = md.len().min(MAX_WORKSPACE_FILE_BYTES);
    let bytes = tokio::fs::read(&contained.resolved_target)
        .await
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
    let slice = &bytes[..(len as usize).min(bytes.len())];

    let ext = contained
        .resolved_target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let posix_rel = contained.clean_rel.clone();
    let writable = is_writable_workspace_rel(active.id, &posix_rel, &uid);
    let name = contained
        .resolved_target
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let updated_at = md
        .modified()
        .ok()
        .map(sys_time_iso)
        .unwrap_or_else(now_iso);

    let raw_content = String::from_utf8_lossy(slice).to_string();
    // Engine config can carry provider credentials inline; mask them on the way out.
    let content = if ext == ".toml" {
        redact_config_secrets(&raw_content)
    } else {
        raw_content
    };

    Ok(Json(json!({
        "root": active.id,
        "path": posix_rel,
        "name": name,
        "size": md.len(),
        "updatedAt": updated_at,
        "ext": ext,
        "language": detect_language(&ext),
        "writable": writable,
        "truncated": md.len() > MAX_WORKSPACE_FILE_BYTES,
        "content": content,
        "readOnly": !writable,
    })))
}

/// PUT /api/agent/workspace/file -- 501 read-only (mirrors are display-only).
async fn put_workspace_file(
    State(_state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Err(ApiError(
        StatusCode::NOT_IMPLEMENTED,
        "Workspace is read-only; edit persona via Customize (PUT /api/agent/identity) or Personality (PUT /api/agent/personality)".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Native replacement for `agent.register(app, ctx)`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agent/identity", get(get_identity).put(put_identity))
        .route(
            "/api/agent/personality",
            get(get_personality).put(put_personality),
        )
        .route("/api/agent/memory", get(get_memory).post(post_memory))
        .route("/api/agent/memory/{id}/reinforce", post(post_reinforce))
        .route("/api/agent/memory/{id}", delete(delete_memory))
        .route("/api/agent/workspace", get(get_workspace))
        .route(
            "/api/agent/workspace/file",
            get(get_workspace_file).put(put_workspace_file),
        )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_state() -> (AppState, PathBuf) {
        let root = std::env::temp_dir().join(format!("amiro-agent-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let workspace = home.join("workspace");
        let runtime_home = root.join("runtime");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&runtime_home).unwrap();
        let state = AppState {
            home,
            runtime_home,
            runtime_socket: root.join("runtime.sock"),
            workspace,
            runtime_bin: root.join("amiro"),
            token: "test-token".to_string(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }

    /// `ApiError` deliberately exposes no `Debug`, so tests unwrap explicitly.
    fn expect_ok<T>(result: Result<T, ApiError>) -> T {
        match result {
            Ok(value) => value,
            Err(err) => panic!("expected Ok, got {} {}", err.0.as_u16(), err.1),
        }
    }

    fn expect_denied<T>(result: Result<T, ApiError>) -> ApiError {
        match result {
            Ok(_) => panic!("expected a denial, got Ok"),
            Err(err) => err,
        }
    }

    const PNG_DATA_URL: &str =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

    // -- pure normalization ------------------------------------------------

    #[test]
    fn normalize_traits_defaults_and_legacy_eyes() {
        let t = normalize_traits(&json!({}));
        assert_eq!(t["bodyShape"], "blob");
        assert_eq!(t["eyeStyle"], "curious");
        assert_eq!(t["color"], "orange");

        let t = normalize_traits(&json!({"eyeStyle": "round", "color": "BLUE"}));
        assert_eq!(t["eyeStyle"], "grumpy");
        // "blue" is not a canonical color id.
        assert_eq!(t["color"], "orange");

        let t = normalize_traits(&json!({"bodyShape": "star", "eyeStyle": "Dazed", "color": "cobalt"}));
        assert_eq!(t["bodyShape"], "star");
        assert_eq!(t["eyeStyle"], "dazed");
        assert_eq!(t["color"], "cobalt");
    }

    #[test]
    fn normalize_sliders_clamps_and_defaults() {
        let s = normalize_sliders(&json!({"companionCoworker": 150, "genzBoomer": -20}));
        assert_eq!(s["companionCoworker"], 100);
        assert_eq!(s["genzBoomer"], 0);
        assert_eq!(s["executeCollaborate"], 35);

        let s = normalize_sliders(&json!({"companionCoworker": "42.6"}));
        assert_eq!(s["companionCoworker"], 43);
    }

    #[test]
    fn summarize_personality_axes_and_balancing() {
        let s = json!({
            "companionCoworker": 65,
            "genzBoomer": 42,
            "executeCollaborate": 35,
            "playfulSerious": 55,
            "politeUnfiltered": 60,
        });
        let summary = summarize_personality(&s);
        assert_eq!(summary, "65% Coworker · 65% Independent · 60% Unfiltered");

        let balanced = json!({
            "companionCoworker": 50,
            "genzBoomer": 50,
            "executeCollaborate": 50,
            "playfulSerious": 50,
            "politeUnfiltered": 50,
        });
        assert_eq!(
            summarize_personality(&balanced),
            "Balanced across all five axes"
        );
    }

    #[test]
    fn persona_prompt_block_shape() {
        let identity = json!({
            "name": "Nova",
            "handle": "@nova",
            "sliders": {"companionCoworker": 65, "genzBoomer": 42, "executeCollaborate": 35, "playfulSerious": 55, "politeUnfiltered": 60},
        });
        let block = build_persona_prompt_block(&identity);
        assert!(block.starts_with("# Agent Identity & Persona (Nova / @nova)"));
        assert!(block.contains("- **Name:** Nova"));
        assert!(block.contains("- **Personality:** 65% Coworker"));
        assert!(block.contains("  - Companion (35) vs Coworker (65)"));
        assert!(block.contains("  - Gen Z (58) vs Baby Boomer (42)"));
    }

    #[test]
    fn fingerprint_is_stable_and_sensitive() {
        let a = json!({"name": "Amiro", "handle": "@amiro", "sliders": {}, "updatedAt": "2026-01-01T00:00:00.000Z"});
        let b = a.clone();
        assert_eq!(persona_fingerprint(&a), persona_fingerprint(&b));
        assert_eq!(persona_fingerprint(&a).len(), 16);

        let c = json!({"name": "Amiro", "handle": "@amiro", "sliders": {"companionCoworker": 90}, "updatedAt": "2026-01-01T00:00:00.000Z"});
        assert_ne!(persona_fingerprint(&a), persona_fingerprint(&c));
    }

    #[test]
    fn handle_and_hex_validation() {
        assert!(valid_handle("@amiro"));
        assert!(valid_handle("@a_1"));
        assert!(!valid_handle("amiro"));
        assert!(!valid_handle("@"));
        assert!(!valid_handle("@with space"));
        assert!(!valid_handle(&format!("@{}", "a".repeat(33))));
        assert!(valid_hex("#E9642F"));
        assert!(!valid_hex("#E9642"));
        assert!(!valid_hex("E9642F"));
        assert!(!valid_hex("#E9642G"));
    }

    #[test]
    fn data_image_validation_allowlist() {
        assert!(is_valid_data_image_url(&Value::String(PNG_DATA_URL.to_string())));
        let jpeg = format!("data:image/jpeg;base64,{}", "A".repeat(64));
        assert!(is_valid_data_image_url(&Value::String(jpeg)));
        let webp = format!("data:image/webp;base64,{}", "B".repeat(64));
        assert!(is_valid_data_image_url(&Value::String(webp)));
        // http, svg, and gif are all rejected.
        assert!(!is_valid_data_image_url(&Value::String(
            "https://example.com/a.png".to_string()
        )));
        assert!(!is_valid_data_image_url(&Value::String(
            "data:image/svg+xml;base64,PHN2Zz4=".to_string()
        )));
        assert!(!is_valid_data_image_url(&Value::String(
            "data:image/gif;base64,R0lGOD".to_string()
        )));
        // Non-base64 payload.
        assert!(!is_valid_data_image_url(&Value::String(
            "data:image/png;base64,****".to_string()
        )));
        // Decoded size cap (~2MB) rejects an oversized payload.
        let huge = format!("data:image/png;base64,{}", "A".repeat(4 * 1024 * 1024));
        assert!(!is_valid_data_image_url(&Value::String(huge)));
    }

    #[test]
    fn validate_payload_reports_adapter_messages() {
        let errs = validate_identity_payload(&json!({"name": "   "}));
        assert_eq!(errs, vec!["name must not be empty".to_string()]);

        let errs = validate_identity_payload(&json!({"name": "a".repeat(33)}));
        assert_eq!(errs, vec![format!("name must be <= {MAX_NAME_LEN} chars")]);

        let errs = validate_identity_payload(&json!({"handle": "@bad handle"}));
        assert_eq!(
            errs,
            vec!["handle must be @alphanumeric (1-32 chars)".to_string()]
        );

        let errs = validate_identity_payload(&json!({"traits": {"bodyShape": "cube"}}));
        assert_eq!(
            errs,
            vec![format!(
                "traits.bodyShape must be one of {}",
                VALID_BODY_SHAPES.join(", ")
            )]
        );

        let errs = validate_identity_payload(&json!({"accentHex": "nothex"}));
        assert_eq!(errs, vec!["accentHex must be #RRGGBB".to_string()]);

        let errs = validate_identity_payload(&json!({"sliders": {"companionCoworker": 101}}));
        assert_eq!(errs, vec!["sliders.companionCoworker must be 0-100".to_string()]);

        let errs = validate_identity_payload(&json!({"sliders": {"nope": 5}}));
        assert_eq!(errs, vec!["unknown slider keys: nope".to_string()]);

        // Well-formed payload passes.
        let ok = json!({
            "name": "Nova",
            "handle": "@nova",
            "tagline": "hi",
            "traits": {"bodyShape": "star", "eyeStyle": "dazed", "color": "teal"},
            "accentHex": "#0E9B8B",
            "customImageUrl": PNG_DATA_URL,
            "sliders": {"companionCoworker": 50},
        });
        assert!(validate_identity_payload(&ok).is_empty());
    }

    #[test]
    fn category_normalization_handles_rust_tagged_enums() {
        assert_eq!(normalize_category_field(&json!("Preference")), "preference");
        assert_eq!(normalize_category_field(&json!("")), "fact");
        assert_eq!(normalize_category_field(&json!({"Custom": "myCat"})), "mycat");
        assert_eq!(normalize_category_field(&json!({"Standard": "fact"})), "fact");
        assert_eq!(normalize_category_field(&json!({"name": "entity"})), "entity");
        assert_eq!(normalize_category_field(&json!({"Other": {"name": "fact"}})), "fact");
        assert_eq!(normalize_category_field(&Value::Null), "fact");
    }

    #[test]
    fn language_detection() {
        assert_eq!(detect_language(".md"), "markdown");
        assert_eq!(detect_language(".JSON"), "json");
        assert_eq!(detect_language(".toml"), "toml");
        assert_eq!(detect_language(".tsx"), "typescript");
        assert_eq!(detect_language(".mjs"), "javascript");
        assert_eq!(detect_language(".css"), "css");
        assert_eq!(detect_language(".rs"), "text");
    }

    #[test]
    fn workspace_allowlists_and_blocking() {
        assert!(is_allowed_workspace_rel("runtime", ""));
        assert!(is_allowed_workspace_rel("runtime", "memory/global.json"));
        assert!(is_allowed_workspace_rel("runtime", "skills/x/SKILL.md"));
        assert!(is_allowed_workspace_rel("runtime", "prompt-overlay.md"));
        assert!(is_allowed_workspace_rel("runtime", "config.toml"));
        assert!(!is_allowed_workspace_rel("runtime", "sessions.json"));
        assert!(!is_allowed_workspace_rel("runtime", "random.txt"));

        assert!(is_allowed_workspace_rel("amiro", "IDENTITY.md"));
        assert!(is_allowed_workspace_rel("amiro", "users/u1/SOUL.md"));
        assert!(!is_allowed_workspace_rel("amiro", "users/u1/secret.md"));
        assert!(!is_allowed_workspace_rel("amiro", "users/u1/sub/SOUL.md"));

        assert!(is_allowed_workspace_rel("project", "src/app/page.tsx"));
        assert!(!is_allowed_workspace_rel("project", "../etc/passwd"));
        assert!(!is_allowed_workspace_rel("project", ".git/config"));
        assert!(!is_allowed_workspace_rel("project", "node_modules/x.js"));
        assert!(is_blocked_workspace_path("deep/.env"));
        assert!(is_blocked_workspace_path("a/keys.enc"));
        assert!(is_blocked_workspace_path("sessions/abc"));
        assert!(is_blocked_workspace_path("x/client_sessions/y"));
        assert!(is_blocked_workspace_path("pending-login/z"));
        assert!(is_blocked_workspace_path(".ssh/id_rsa"));
        assert!(is_blocked_workspace_path("cert.pem"));
        assert!(!is_blocked_workspace_path("src/readme.md"));
    }

    #[test]
    fn directory_nodes_stay_listable_so_browser_can_descend() {
        // The adapter's `startsWith('memory/')` form hid these nodes entirely.
        assert!(is_allowed_workspace_rel("runtime", "memory"));
        assert!(is_allowed_workspace_rel("runtime", "skills"));
        assert!(is_allowed_workspace_rel("runtime", "projects"));
        assert!(is_allowed_workspace_rel("amiro", "users"));
        assert!(is_allowed_workspace_rel("amiro", "users/u1"));
        assert!(is_allowed_workspace_rel("amiro", "skills"));
        // Descending still cannot read arbitrary files.
        assert!(!is_allowed_workspace_rel("runtime", "memory-something"));
        assert!(!is_allowed_workspace_rel("amiro", "users/u1/notes.txt"));
        assert!(!is_allowed_workspace_rel("amiro", "scratchpad"));
    }

    #[test]
    fn config_secrets_are_redacted() {
        let input = concat!(
            "# engine config\n",
            "model = \"fast\"\n",
            "[provider]\n",
            "api_key = \"sk-live-abcdefghijklmnop\"\n",
            "base_url = \"https://api.example.com\"\n",
            "authToken = \"opaque-value\"\n",
            "password='hunter2'\n",
            "endpoint = \"https://x\"\n",
        );
        let out = redact_config_secrets(input);
        assert!(!out.contains("sk-live-abcdefghijklmnop"));
        assert!(!out.contains("opaque-value"));
        assert!(!out.contains("hunter2"));
        assert!(out.contains("base_url = \"https://api.example.com\""));
        assert!(out.contains("model = \"fast\""));
        assert!(out.contains("[provider]"));
        assert!(out.contains("api_key = \"[redacted]\""));
        assert!(out.contains("authToken = \"[redacted]\""));
        assert!(out.contains("password= \"[redacted]\""));
        assert!(out.contains("endpoint = \"https://x\""));
    }

    #[test]
    fn config_secret_redaction_keeps_unrelated_assignments() {
        let input = "description = \"a=b and t=2\"\nretries = 3\n";
        let out = redact_config_secrets(input);
        assert_eq!(out, input);
    }

    #[tokio::test]
    async fn persona_root_points_at_current_user_directory() {
        let (state, root) = temp_state();
        let roots = workspace_roots(&state, "u-1");
        let amiro = roots.iter().find(|r| r.id == "amiro").unwrap();
        assert_eq!(amiro.base_path, state.workspace.join("users").join("u-1"));
        // Unsanitizable id falls back to the workspace root rather than a bogus dir.
        let roots = workspace_roots(&state, "!!!");
        let amiro = roots.iter().find(|r| r.id == "amiro").unwrap();
        assert_eq!(amiro.base_path, state.workspace);
        assert_eq!(roots.iter().find(|r| r.id == "runtime").unwrap().base_path, state.runtime_home);
        // The project root mirrors `resolve(outDir, '..')` and must be a real tree.
        let project = roots.iter().find(|r| r.id == "project").unwrap();
        assert!(project.base_path.is_dir(), "project root {project:?} missing");
        cleanup(&root);
    }

    // -- fs-backed identity ------------------------------------------------

    #[tokio::test]
    async fn identity_defaults_for_new_user() {
        let (state, root) = temp_state();
        let id = expect_ok(get_agent_identity(&state, Some("user-1")).await);
        assert_eq!(id["name"], "Amiro");
        assert_eq!(id["handle"], "@amiro");
        assert_eq!(id["traits"]["color"], "orange");
        assert_eq!(id["accentHex"], ORANGE_HEX);
        assert_eq!(id["customImageUrl"], Value::Null);
        assert!(id["personalitySummary"].as_str().unwrap().contains("Coworker"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn identity_is_per_user_and_persisted() {
        let (state, root) = temp_state();
        let key = store_path(&state, &identity_key_for_user(Some("user-1")));
        std::fs::create_dir_all(key.parent().unwrap()).unwrap();
        std::fs::write(
            &key,
            serde_json::to_string(&json!({
                "name": "Nova",
                "handle": "@nova",
                "tagline": "Run the lab",
                "traits": {"bodyShape": "star", "eyeStyle": "dazed", "color": "teal"},
                "accentHex": "#0E9B8B",
                "customImageUrl": PNG_DATA_URL,
                "sliders": {"companionCoworker": 90},
                "personalitySummary": "custom summary",
                "updatedAt": "2026-02-02T00:00:00.000Z",
            }))
            .unwrap(),
        )
        .unwrap();

        let id = expect_ok(get_agent_identity(&state, Some("user-1")).await);
        assert_eq!(id["name"], "Nova");
        assert_eq!(id["handle"], "@nova");
        assert_eq!(id["accentHex"], "#0E9B8B");
        assert_eq!(id["customImageUrl"], PNG_DATA_URL);
        assert_eq!(id["personalitySummary"], "custom summary");

        // A different user must NOT see user-1's persona.
        let other = expect_ok(get_agent_identity(&state, Some("user-2")).await);
        assert_eq!(other["name"], "Amiro");
        cleanup(&root);
    }

    #[tokio::test]
    async fn legacy_identity_only_migrates_for_admin_owner() {
        let (state, root) = temp_state();
        let legacy = store_path(&state, LEGACY_IDENTITY_KEY);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, r#"{"name":"Legacy","handle":"@legacy"}"#).unwrap();

        // No users.json -> no migration.
        let id = expect_ok(get_agent_identity(&state, Some("admin-1")).await);
        assert_eq!(id["name"], "Amiro");

        // Admin owner -> migrated.
        std::fs::write(
            state.home.join("users.json"),
            r#"{"users":[{"id":"admin-1","role":"admin"}]}"#,
        )
        .unwrap();
        let id = expect_ok(get_agent_identity(&state, Some("admin-1")).await);
        assert_eq!(id["name"], "Legacy");

        // Non-admin user never receives the shared legacy persona.
        let id = expect_ok(get_agent_identity(&state, Some("plain-1")).await);
        assert_eq!(id["name"], "Amiro");
        cleanup(&root);
    }

    #[tokio::test]
    async fn persona_mirrors_are_written_per_user_only() {
        let (state, root) = temp_state();
        let identity = json!({
            "name": "Nova",
            "handle": "@nova",
            "tagline": "Run the lab",
            "traits": {"bodyShape": "star", "eyeStyle": "dazed", "color": "teal"},
            "accentHex": "#0E9B8B",
            "customImageUrl": Value::Null,
            "sliders": {"companionCoworker": 65, "genzBoomer": 42, "executeCollaborate": 35, "playfulSerious": 55, "politeUnfiltered": 60},
            "personalitySummary": "65% Coworker",
            "updatedAt": "2026-02-02T00:00:00.000Z",
        });
        sync_persona_files(&state, &identity, Some("user-1")).await;

        let dir = state.workspace.join("users").join("user-1");
        let identity_md = std::fs::read_to_string(dir.join("IDENTITY.md")).unwrap();
        assert!(identity_md.contains("**Name:** Nova"));
        // SOUL.md belongs to the agent now; the persona sync never writes it per user.
        assert!(!dir.join("SOUL.md").exists());
        // IDENTITY.md is generated at the workspace root with plain-language traits.
        let root_identity = std::fs::read_to_string(state.workspace.join("IDENTITY.md")).unwrap();
        assert!(root_identity.starts_with("_ Generated from the Personality page."));
        assert!(root_identity.contains("**Name:** Nova"));
        assert!(root_identity.contains("## Personality"));
        assert!(root_identity.contains("Leans coworker (65%) over companion"));
        assert!(root_identity.contains("Leans Gen Z (58%) over classic"));
        assert!(root_identity.contains("Leans executing independently (65%) over collaborating"));
        assert!(root_identity.contains("Leans serious (55%) over playful"));
        assert!(root_identity.contains("Leans unfiltered (60%) over polite"));
        let overlay = std::fs::read_to_string(dir.join("prompt-overlay.md")).unwrap();
        assert!(overlay.starts_with("# Agent Identity & Persona (Nova / @nova)"));

        // The global overlay must never be created.
        assert!(!state.home.join("prompt-overlay.md").exists());
        cleanup(&root);
    }

    #[tokio::test]
    async fn persona_mirror_refuses_escaping_users_symlink() {
        let (state, root) = temp_state();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, state.workspace.join("users")).unwrap();

        let identity = json!({"name": "Nova", "handle": "@nova", "traits": {}, "sliders": {}, "updatedAt": "x"});
        sync_persona_files(&state, &identity, Some("user-1")).await;

        // The planted symlink is removed, not followed, so nothing lands outside.
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        cleanup(&root);
    }

    // -- memory graph ------------------------------------------------------

    #[tokio::test]
    async fn memory_graph_is_ingested_read_only() {
        let (state, root) = temp_state();
        let mem_dir = state.runtime_home.join("memory");
        std::fs::create_dir_all(mem_dir.join("projects")).unwrap();
        std::fs::write(
            mem_dir.join("global.json"),
            serde_json::to_string(&json!({
                "graph_version": 2,
                "memories": {
                    "m1": {"id": "m1", "content": "likes rust", "category": "Preference", "tags": ["lang", "shared"], "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-02T00:00:00.000Z"},
                    "m2": {"id": "m2", "content": "old", "category": {"Custom": "legacy"}, "active": false},
                    "m3": {"id": "m3", "content": "superseded", "superseded_by": "m1"},
                    "m4": {"id": "m4", "content": "prefers tables", "category": "fact", "tags": ["shared"], "updated_at": "2026-01-03T00:00:00.000Z"}
                },
                "edges": {"m1": ["m3"]},
                "tags": {"lang": {}}
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            mem_dir.join("projects").join("abcd1234.json"),
            serde_json::to_string(&json!({
                "memories": {
                    "p1": {"id": "p1", "content": "project note", "category": "fact", "tags": ["proj", "shared"], "updated_at": "2026-01-04T00:00:00.000Z"}
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let graph = load_all_memory_graphs(&state).await;
        let stats = &graph["stats"];
        assert_eq!(stats["allRecords"], 5);
        assert_eq!(stats["active"], 3);
        assert_eq!(stats["total"], 3);
        assert_eq!(stats["superseded"], 2);
        assert_eq!(stats["globalCount"], 2);
        assert_eq!(stats["projectCount"], 1);
        assert_eq!(stats["uniqueTags"], 3);
        assert_eq!(stats["byCategory"]["preference"], 1);
        assert_eq!(stats["byCategory"]["fact"], 2);
        // Inactive records contribute nothing to the category histogram.
        assert!(stats["byCategory"].get("legacy").is_none());

        let scopes = graph["scopes"].as_array().unwrap();
        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0]["id"], "global");
        assert_eq!(scopes[0]["label"], "Global Memory");
        assert_eq!(scopes[0]["kind"], "global");
        assert_eq!(scopes[0]["file"], "memory/global.json");
        assert_eq!(scopes[0]["count"], 2);
        assert_eq!(scopes[1]["kind"], "project");
        assert_eq!(scopes[1]["label"], "Project abcd1234");
        assert_eq!(scopes[1]["file"], "memory/projects/abcd1234.json");
        assert_eq!(scopes[1]["count"], 1);

        let memories = graph["memories"].as_array().unwrap();
        assert_eq!(memories.len(), 3);
        // Newest first.
        assert_eq!(memories[0]["id"], "p1");
        assert_eq!(memories[1]["id"], "m4");
        assert_eq!(memories[2]["id"], "m1");
        let m1 = memories.iter().find(|m| m["id"] == "m1").unwrap();
        assert_eq!(m1["scope"], "global");
        assert_eq!(m1["scopeKind"], "global");
        assert_eq!(m1["scopeLabel"], "Global Memory");
        assert_eq!(m1["category"], "preference");
        assert_eq!(m1["tags"][0], "lang");
        assert_eq!(m1["active"], true);
        assert_eq!(m1["source"], "local");
        assert_eq!(m1["trust"], "high");
        assert_eq!(m1["strength"], 1.0);
        assert_eq!(m1["accessCount"], 0.0);
        assert_eq!(m1["createdAt"], "2026-01-01T00:00:00.000Z");
        let p1 = memories.iter().find(|m| m["id"] == "p1").unwrap();
        assert_eq!(p1["scope"], "abcd1234");
        assert_eq!(p1["scopeKind"], "project");
        assert_eq!(p1["scopeLabel"], "Project abcd1234");

        let edges = graph["edges"].as_array().unwrap();
        assert!(edges
            .iter()
            .any(|e| e["kind"] == "explicit" && e["source"] == "m1" && e["target"] == "m3"));
        assert!(edges.iter().any(|e| e["kind"] == "tag" && e["label"] == "#shared"));
        assert!(edges
            .iter()
            .any(|e| e["kind"] == "category" && e["label"] == "fact"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn memory_graph_empty_when_missing() {
        let (state, root) = temp_state();
        let graph = load_all_memory_graphs(&state).await;
        assert_eq!(graph["stats"]["allRecords"], 0);
        assert_eq!(graph["scopes"].as_array().unwrap().len(), 1);
        assert_eq!(graph["memories"].as_array().unwrap().len(), 0);
        cleanup(&root);
    }

    #[tokio::test]
    async fn memory_graph_tolerates_corrupt_json() {
        let (state, root) = temp_state();
        let mem_dir = state.runtime_home.join("memory");
        std::fs::create_dir_all(&mem_dir).unwrap();
        std::fs::write(mem_dir.join("global.json"), "{not json").unwrap();
        let graph = load_all_memory_graphs(&state).await;
        assert_eq!(graph["stats"]["allRecords"], 0);
        cleanup(&root);
    }

    // -- workspace containment --------------------------------------------

    #[tokio::test]
    async fn containment_blocks_traversal_and_secrets() {
        let (state, root) = temp_state();
        let base = state.runtime_home.clone();
        std::fs::create_dir_all(base.join("memory")).unwrap();

        let err = expect_denied(
            resolve_contained_workspace_path(&base, "../escape", "runtime", "u1", false).await,
        );
        assert_eq!(err.0, StatusCode::FORBIDDEN);

        let err = expect_denied(
            resolve_contained_workspace_path(&base, "users.json", "runtime", "u1", false).await,
        );
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        // The allowlist consults the blocklist first, so a blocked name reports as
        // "not allowed" and the later "sensitive" branch is shadowed (as upstream).
        assert!(err.1.contains("not allowed"));

        let err = expect_denied(
            resolve_contained_workspace_path(&base, "auth.json", "project", "u1", false).await,
        );
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert!(err.1.contains("not allowed"));

        let err = expect_denied(
            resolve_contained_workspace_path(&base, "random.txt", "runtime", "u1", false).await,
        );
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert!(err.1.contains("not allowed"));

        let allowed = expect_ok(
            resolve_contained_workspace_path(&base, "memory/global.json", "runtime", "u1", false)
                .await,
        );
        assert_eq!(allowed.clean_rel, "memory/global.json");
        cleanup(&root);
    }

    #[tokio::test]
    async fn containment_blocks_symlink_escape() {
        let (state, root) = temp_state();
        let base = state.runtime_home.clone();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        std::fs::create_dir_all(base.join("skills")).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("skills").join("evil")).unwrap();

        let err = expect_denied(
            resolve_contained_workspace_path(&base, "skills/evil/secret.md", "runtime", "u1", false)
                .await,
        );
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        cleanup(&root);
    }

    #[tokio::test]
    async fn workspace_writes_are_never_allowed() {
        let (state, root) = temp_state();
        let base = state.runtime_home.clone();
        std::fs::create_dir_all(base.join("memory")).unwrap();
        let err = expect_denied(
            resolve_contained_workspace_path(&base, "memory/global.json", "runtime", "u1", true)
                .await,
        );
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert!(err.1.contains("read-only"));
        cleanup(&root);
    }
}
