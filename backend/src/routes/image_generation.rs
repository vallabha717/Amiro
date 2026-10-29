//! Image generation: one configured provider per agent, like web search.
//!
//! The choice (provider, model, API base) lives in `store/image-generation.json`
//! (a team agent keeps its own in its private folder); the key lives in the
//! encrypted vault as `image.<provider>/api_key`, never in the store or a
//! response. The agent draws through the `image_generate` tool, which saves
//! each picture as an artifact so it shows in the chat and the Files tab.
//!
//! Providers:
//! - `9router`: your own 9Router, `POST {base}/v1/images/generations`, the
//!   same call Vellum makes (model `ag/gemini-3.1-flash-image` by default).
//! - `openai`: OpenAI's images API.
//! - `gemini`: Google's `generateContent` with image output.
//! - `openai-compatible`: any other OpenAI-style images API at your own URL.

use std::path::PathBuf;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde_json::{json, Value};

use crate::routes::agents::AgentState;
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const STORE: &str = "image-generation.json";
const TIMEOUT: Duration = Duration::from_secs(180);
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 4000;

pub fn catalog() -> Vec<Value> {
    vec![
        json!({"kind":"9router","label":"9Router","defaultModel":"ag/gemini-3.1-flash-image","needsApiBase":true,"docs":"https://github.com/decolua/9router"}),
        json!({"kind":"openai","label":"OpenAI","defaultModel":"gpt-image-1","defaultApiBase":"https://api.openai.com/v1","docs":"https://platform.openai.com/api-keys"}),
        json!({"kind":"gemini","label":"Google Gemini","defaultModel":"gemini-2.5-flash-image","defaultApiBase":"https://generativelanguage.googleapis.com/v1beta","docs":"https://aistudio.google.com/apikey"}),
        json!({"kind":"openai-compatible","label":"OpenAI-compatible","defaultModel":"","needsApiBase":true,"docs":"https://platform.openai.com/docs/api-reference/images"}),
    ]
}

fn spec(kind: &str) -> Option<Value> {
    catalog().into_iter().find(|s| s["kind"] == kind)
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn bad_request(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    Ok(())
}

fn store_path(state: &AppState) -> PathBuf {
    match state.agent_scope() {
        Some(agent) => crate::state::agent_private_root(&state.home, &agent)
            .join("store")
            .join(STORE),
        None => state.home.join("store").join(STORE),
    }
}

/// Vault slot for a provider's key.
pub fn key_service(kind: &str) -> String {
    format!("image.{kind}")
}

/// The saved choice, or `None` when image generation is not set up.
pub async fn config(state: &AppState) -> Result<Option<Value>, ApiError> {
    let saved = read_json(&store_path(state), Value::Null).await?;
    Ok(Some(saved).filter(|v| !text(v, "provider").is_empty()))
}

/// The settings a client may see: never the key, only whether one is saved.
pub async fn public_settings(state: &AppState) -> Result<Value, ApiError> {
    let saved = config(state).await?;
    let mut settings = json!({"catalog": catalog(), "config": Value::Null});
    if let Some(saved) = saved {
        let kind = text(&saved, "provider").to_string();
        let key = crate::credentials::get_plaintext(state, &key_service(&kind), "api_key").await?;
        settings["config"] = json!({
            "provider": kind,
            "model": text(&saved, "model"),
            "apiBase": text(&saved, "apiBase"),
            "keySet": key.is_some(),
            "keyHint": key.map(|k| crate::credentials::masked_hint(k.expose())),
        });
    }
    Ok(settings)
}

fn validate_base(base: &str) -> Result<(), ApiError> {
    let url = url::Url::parse(base).map_err(|_| bad_request("API base must be an absolute HTTP(S) URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(bad_request(
            "API base must be an HTTP(S) URL without credentials, query or fragment",
        ));
    }
    Ok(())
}

/// Save the provider choice; a non-empty `apiKey` replaces the vault key.
pub async fn save_settings(state: &AppState, body: &Value) -> Result<Value, ApiError> {
    let kind = text(body, "provider").to_lowercase();
    let Some(spec) = spec(&kind) else {
        return Err(bad_request("unknown image provider"));
    };
    let model = match text(body, "model") {
        "" => text(&spec, "defaultModel").to_string(),
        m => m.to_string(),
    };
    if model.is_empty() {
        return Err(bad_request("a model is required for this provider"));
    }
    let api_base = match text(body, "apiBase").trim_end_matches('/') {
        "" => text(&spec, "defaultApiBase").to_string(),
        base => base.to_string(),
    };
    if api_base.is_empty() {
        return Err(bad_request("this provider needs its API base URL"));
    }
    validate_base(&api_base)?;
    let key = text(body, "apiKey");
    if !key.is_empty() {
        crate::credentials::set(state, &key_service(&kind), "api_key", key, Some("Image generation API key")).await?;
    } else if crate::credentials::get_plaintext(state, &key_service(&kind), "api_key").await?.is_none() {
        return Err(bad_request("an API key is required"));
    }
    write_json(
        &store_path(state),
        &json!({"provider": kind, "model": model, "apiBase": api_base, "updatedAt": crate::state::now_iso()}),
    )
    .await?;
    public_settings(state).await
}

pub async fn clear_settings(state: &AppState) -> Result<(), ApiError> {
    write_json(&store_path(state), &json!({})).await
}

/// One generated picture.
pub struct Generated {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub model: String,
}

/// The endpoint for an OpenAI-style images API: `{base}/images/generations`,
/// adding `/v1` for a bare 9Router origin.
pub fn images_endpoint(kind: &str, base: &str) -> String {
    let base = base.trim_end_matches('/');
    if kind == "9router" && !base.ends_with("/v1") {
        format!("{base}/v1/images/generations")
    } else {
        format!("{base}/images/generations")
    }
}

/// The request body for an OpenAI-style images API. gpt-image models always
/// answer in base64 and reject `response_format`; the rest are asked for it.
pub fn images_body(model: &str, prompt: &str) -> Value {
    let mut body = json!({"model": model, "prompt": prompt, "n": 1});
    if !model.starts_with("gpt-image") {
        body["response_format"] = json!("b64_json");
    }
    body
}

/// The first image in an OpenAI-style answer: inline base64, or a URL.
pub fn image_from_openai(answer: &Value) -> Option<Result<Vec<u8>, String>> {
    let item = answer.get("data")?.as_array()?.first()?;
    if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
        return Some(
            base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|_| "the provider sent an image that is not valid base64".to_string()),
        );
    }
    item.get("url")
        .and_then(Value::as_str)
        .map(|url| Err(format!("url:{url}")))
}

/// The first image in a Gemini `generateContent` answer.
pub fn image_from_gemini(answer: &Value) -> Option<(Vec<u8>, String)> {
    let parts = answer.pointer("/candidates/0/content/parts")?.as_array()?;
    parts.iter().find_map(|part| {
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"))?;
        let data = inline.get("data")?.as_str()?;
        let mime = inline
            .get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
        Some((bytes, mime.to_string()))
    })
}

/// Sniff the picture's type from its first bytes.
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'G', b'I', b'F', ..] => "image/gif",
        _ => "image/png",
    }
}

fn provider_error(kind: &str, status: reqwest::StatusCode, body: &str) -> String {
    let detail: String = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status.as_u16() {
        401 | 403 => format!("{kind} rejected the API key. Check it in Admin → Image generation."),
        429 => format!("{kind} is rate limiting image requests; try again in a moment."),
        s if s >= 500 => format!("{kind} or its upstream image model is unavailable right now ({s}): {detail}"),
        s => format!("{kind} refused the image request ({s}): {detail}"),
    }
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("could not download the image ({})", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

/// Draw one picture with the configured provider. `model` overrides the
/// configured one for this call.
pub async fn generate(state: &AppState, prompt: &str, model: Option<&str>) -> Result<Generated, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("describe the picture to draw".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("the description is longer than {MAX_PROMPT_CHARS} characters"));
    }
    let Some(saved) = config(state).await.map_err(|e| e.1)? else {
        return Err("Image generation is not set up. Pick a provider in Admin → Image generation (9Router, OpenAI, Gemini or any OpenAI-compatible API).".into());
    };
    let kind = text(&saved, "provider").to_string();
    let label = spec(&kind).map(|s| text(&s, "label").to_string()).unwrap_or_else(|| kind.clone());
    let key = crate::credentials::get_plaintext(state, &key_service(&kind), "api_key")
        .await
        .map_err(|e| e.1)?
        .ok_or_else(|| format!("The {label} API key is missing. Add it in Admin → Image generation."))?;
    let model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| text(&saved, "model"))
        .to_string();
    let base = text(&saved, "apiBase").to_string();
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let (bytes, mime) = if kind == "gemini" {
        let url = format!("{}/models/{}:generateContent", base.trim_end_matches('/'), model);
        let response = client
            .post(&url)
            .header("x-goog-api-key", key.expose())
            .json(&json!({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]},
            }))
            .send()
            .await
            .map_err(|e| format!("could not reach {label}: {e}"))?;
        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(provider_error(&label, status, &body));
        }
        let answer: Value = serde_json::from_str(&body).map_err(|_| format!("{label} sent an answer that is not JSON"))?;
        image_from_gemini(&answer).ok_or_else(|| format!("{label} answered without an image; try describing the picture differently"))?
    } else {
        let response = client
            .post(images_endpoint(&kind, &base))
            .bearer_auth(key.expose())
            .json(&images_body(&model, prompt))
            .send()
            .await
            .map_err(|e| format!("could not reach {label}: {e}"))?;
        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(provider_error(&label, status, &body));
        }
        let answer: Value = serde_json::from_str(&body).map_err(|_| format!("{label} sent an answer that is not JSON"))?;
        let bytes = match image_from_openai(&answer) {
            Some(Ok(bytes)) => bytes,
            Some(Err(e)) if e.starts_with("url:") => fetch_bytes(&client, &e["url:".len()..]).await?,
            Some(Err(e)) => return Err(e),
            None => return Err(format!("{label} answered without an image; try describing the picture differently")),
        };
        let mime = sniff_mime(&bytes).to_string();
        (bytes, mime)
    };
    if bytes.is_empty() {
        return Err(format!("{label} sent an empty image"));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("the image is larger than 10 MB".into());
    }
    Ok(Generated { bytes, mime, model })
}

/// Draw a picture and keep it as an artifact of `owner`. Returns the artifact.
pub async fn generate_artifact(
    state: &AppState,
    owner: &str,
    prompt: &str,
    model: Option<&str>,
    title: Option<&str>,
) -> Result<Value, String> {
    let image = generate(state, prompt, model).await?;
    let ext = match image.mime.as_str() {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    };
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| prompt.chars().take(60).collect::<String>());
    let slug: String = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let filename = format!("{}.{ext}", if slug.is_empty() { "image".to_string() } else { slug });
    let mut entry = crate::routes::artifacts::create_artifact_record(
        state,
        owner,
        Some(title),
        Some("image".into()),
        None,
        Some(filename),
        Some(image.mime.clone()),
        None,
        image.bytes,
    )
    .await
    .map_err(|e| e.1)?;
    entry["model"] = json!(image.model);
    entry["prompt"] = json!(prompt);
    Ok(entry)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async fn get_settings(AgentState(state): AgentState, _user: AuthUser) -> Result<Json<Value>, ApiError> {
    Ok(Json(public_settings(&state).await?))
}

async fn put_settings(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(save_settings(&state, &body).await?))
}

async fn delete_settings(AgentState(state): AgentState, user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    clear_settings(&state).await?;
    Ok(Json(public_settings(&state).await?))
}

/// Body: `{ prompt, model? }`. Draws one picture and keeps it as an artifact.
async fn post_generate(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let owner = user.0.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let model = Some(text(&body, "model")).filter(|m| !m.is_empty());
    let entry = generate_artifact(&state, &owner, text(&body, "prompt"), model, None)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(entry))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/image-generation",
            get(get_settings).put(put_settings).delete(delete_settings),
        )
        .route("/api/image-generation/generate", post(post_generate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nine_router_draws_like_vellum() {
        assert_eq!(
            images_endpoint("9router", "https://router.example"),
            "https://router.example/v1/images/generations"
        );
        assert_eq!(
            images_endpoint("9router", "https://router.example/v1/"),
            "https://router.example/v1/images/generations"
        );
        assert_eq!(
            images_endpoint("openai", "https://api.openai.com/v1"),
            "https://api.openai.com/v1/images/generations"
        );
        let body = images_body("ag/gemini-3.1-flash-image", "a brass coffee tumbler");
        assert_eq!(body["model"], "ag/gemini-3.1-flash-image");
        assert_eq!(body["response_format"], "b64_json");
        assert!(images_body("gpt-image-1", "x").get("response_format").is_none());
        assert_eq!(spec("9router").unwrap()["defaultModel"], "ag/gemini-3.1-flash-image");
    }

    #[test]
    fn answers_are_read_from_each_provider_shape() {
        let png = [0x89u8, b'P', b'N', b'G', 1, 2, 3];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let openai = json!({"data": [{"b64_json": b64}]});
        assert_eq!(image_from_openai(&openai).unwrap().unwrap(), png);
        let by_url = json!({"data": [{"url": "https://cdn.example/x.png"}]});
        assert_eq!(image_from_openai(&by_url).unwrap().unwrap_err(), "url:https://cdn.example/x.png");
        assert!(image_from_openai(&json!({"data": []})).is_none());

        let gemini = json!({"candidates": [{"content": {"parts": [
            {"text": "Here you go"},
            {"inlineData": {"mimeType": "image/png", "data": b64}}
        ]}}]});
        let (bytes, mime) = image_from_gemini(&gemini).unwrap();
        assert_eq!(bytes, png);
        assert_eq!(mime, "image/png");
        assert!(image_from_gemini(&json!({"candidates": []})).is_none());

        assert_eq!(sniff_mime(&png), "image/png");
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
    }

    #[test]
    fn errors_say_what_to_do() {
        let e = provider_error("9Router", reqwest::StatusCode::UNAUTHORIZED, "{}");
        assert!(e.contains("API key"), "{e}");
        let e = provider_error("OpenAI", reqwest::StatusCode::BAD_REQUEST, r#"{"error":{"message":"bad model"}}"#);
        assert!(e.contains("bad model"), "{e}");
    }

    #[test]
    fn api_base_must_be_a_clean_url() {
        assert!(validate_base("https://router.example/v1").is_ok());
        assert!(validate_base("https://user:pw@router.example").is_err());
        assert!(validate_base("ftp://router.example").is_err());
        assert!(validate_base("not a url").is_err());
    }
}
