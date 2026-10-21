//! End-to-end tests for the Voice & Speech routes.
//!
//! An in-process mock provider server stands in for an OpenAI-compatible
//! `/v1` router (the 9Router / custom-openai case) so synthesis and
//! transcription are exercised as served, including URL normalization.
//! The real router is driven through `tower::ServiceExt::oneshot`, so auth and
//! the JSON contract are covered too.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const USER_TOKEN: &str = "tok-voice-user";
const USER_ID: &str = "user-voice";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

struct Fixture {
    state: AppState,
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn seed(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("amiro-voice-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();

    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": USER_ID, "name": "User", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            USER_TOKEN: {"userId": USER_ID, "createdAt": now_iso()},
        }}),
    );

    let state = AppState {
        home,
        runtime_home,
        runtime_socket: root.join("amiro-api.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("amiro-runtime"),
        token: "fixture-sidecar-secret".to_string(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    Fixture { state, root }
}

fn app(fixture: &Fixture) -> Router {
    router().with_state(fixture.state.clone())
}

async fn send(
    app: &Router,
    token: Option<&str>,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, bytes::Bytes, Option<String>) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => builder
            .header("content-length", "0")
            .body(Body::empty())
            .unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    (status, bytes, content_type)
}

async fn call_json(
    app: &Router,
    token: Option<&str>,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (status, bytes, _) = send(app, token, method, uri, body).await;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible provider
// ---------------------------------------------------------------------------

async fn speak() -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("content-type", "audio/mpeg".parse().unwrap());
    (StatusCode::OK, headers, vec![9, 8, 7, 6])
}

async fn transcribe(headers: HeaderMap, body: Bytes) -> (HeaderMap, Json<Value>) {
    // Assert the multipart body actually carried the `file` and `model` parts.
    let raw = String::from_utf8_lossy(&body);
    let has_file = raw.contains("name=\"file\"") && raw.contains("audio.webm");
    let has_model = raw.contains("name=\"model\"") && raw.contains("whisper-1");
    assert!(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("multipart/form-data; boundary=")),
        "upstream should receive multipart/form-data"
    );
    assert!(has_file, "multipart body is missing the file part");
    let mut response_headers = HeaderMap::new();
    response_headers.insert("content-type", "application/json".parse().unwrap());
    let text = if has_model {
        "mock transcript (whisper-1)"
    } else {
        "mock transcript"
    };
    (response_headers, Json(json!({ "text": text })))
}

fn mock_base() -> &'static str {
    static BASE: OnceLock<String> = OnceLock::new();
    BASE.get_or_init(|| {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("mock runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind mock server");
                let addr = listener.local_addr().expect("mock addr");
                ready_tx.send(addr).expect("signal ready");
                let app = Router::new()
                    .route("/v1/audio/speech", post(speak))
                    .route("/v1/audio/transcriptions", post(transcribe));
                axum::serve(listener, app).await.expect("serve mock");
            });
        });
        let addr = ready_rx.recv().expect("mock ready");
        format!("http://{addr}/v1")
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_route_requires_authentication() {
    let fixture = fixture();
    let app = app(&fixture);
    for (method, uri) in [
        (Method::GET, "/api/voice/settings"),
        (Method::POST, "/api/tts/synthesize"),
        (Method::POST, "/api/stt/transcribe"),
    ] {
        let (status, _) = call_json(&app, None, method, uri, Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let (status, _) = call_json(
        &app,
        None,
        Method::PUT,
        "/api/voice/settings",
        Some(json!({"ttsProvider": "openai"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn settings_roundtrip_over_http() {
    let fixture = fixture();
    let app = app(&fixture);

    let (status, payload) = call_json(&app, Some(USER_TOKEN), Method::GET, "/api/voice/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ttsCatalog"].as_array().unwrap().len(), 7);
    assert_eq!(payload["sttCatalog"].as_array().unwrap().len(), 7);
    assert_eq!(payload["settings"]["ttsProvider"], "browser-native");

    let (status, updated) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::PUT,
        "/api/voice/settings",
        Some(json!({
            "ttsProvider": "openai",
            "sttProvider": "deepgram",
            "ttsProviderUpdate": {
                "provider": "openai",
                "model": "tts-1-hd",
                "voiceId": "nova",
                "apiKey": "sk-http-secret-1234",
            },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["settings"]["ttsProvider"], "openai");
    assert_eq!(updated["settings"]["sttProvider"], "deepgram");
    assert_eq!(updated["settings"]["ttsProviders"]["openai"]["apiKeyHint"], "••••1234");
    assert!(!updated.to_string().contains("sk-http-secret-1234"));
    // STT shares the OpenAI TTS key slot for openai only; deepgram is separate.
    assert_eq!(updated["settings"]["sttProviders"]["deepgram"]["configured"], false);
}

#[tokio::test]
async fn synthesize_proxies_to_a_normalized_router_url() {
    let fixture = fixture();
    let app = app(&fixture);
    let base = mock_base();

    let (status, bytes, content_type) = send(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/tts/synthesize",
        Some(json!({
            "provider": "custom-openai",
            "text": "hello world",
            "baseUrl": format!("{base}/"),
            "apiKey": "sk-router-test",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "synthesis should succeed");
    assert_eq!(bytes.as_ref(), &[9u8, 8, 7, 6]);
    assert_eq!(content_type.as_deref(), Some("audio/mpeg"));
}

#[tokio::test]
async fn transcribe_proxies_multipart_and_extracts_text() {
    let fixture = fixture();
    let app = app(&fixture);
    let base = mock_base();
    let audio = base64_encode(b"fake-audio");

    let (status, value) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/stt/transcribe",
        Some(json!({
            "provider": "custom-openai",
            "audio": audio,
            "mimeType": "audio/webm",
            "baseUrl": base,
            "model": "whisper-1",
            "apiKey": "sk-router-test",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["status"], "ok");
    assert_eq!(value["providerId"], "custom-openai");
    assert_eq!(value["text"], "mock transcript (whisper-1)");
}

#[tokio::test]
async fn live_voice_runs_on_the_chosen_keyed_providers_not_the_browser() {
    let fixture = fixture();
    let app = app(&fixture);
    let preflight = || call_json(&app, Some(USER_TOKEN), Method::GET, "/api/live-voice/preflight", None);

    // Nothing set up: not ready, and the message says the browser voice won't do.
    let (status, body) = preflight().await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ready"], false);
    assert!(body["message"].as_str().unwrap().contains("browser's built-in voice"), "{body}");

    // The browser's own voices never count for live voice.
    let (status, _) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::PUT,
        "/api/voice/settings",
        Some(json!({"ttsProvider": "browser-native", "sttProvider": "browser-native"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preflight().await.1["ready"], false);

    // OpenAI speaks and Deepgram listens: live voice uses exactly those.
    let (status, _) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::PUT,
        "/api/voice/settings",
        Some(json!({
            "ttsProvider": "openai",
            "ttsProviderUpdate": {"provider": "openai", "apiKey": "sk-openai-test", "voiceId": "nova"},
            "sttProvider": "deepgram",
            "sttProviderUpdate": {"provider": "deepgram", "apiKey": "dg-test"},
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = preflight().await;
    assert_eq!(body["ready"], true, "{body}");
    assert_eq!(body["tts"]["provider"], "openai");
    assert_eq!(body["tts"]["voiceId"], "nova");
    assert_eq!(body["stt"]["provider"], "deepgram");
    assert!(!body.to_string().contains("sk-openai-test"), "keys never leave the vault");

    let (_, settings) = call_json(&app, Some(USER_TOKEN), Method::GET, "/api/voice/settings", None).await;
    let live = &settings["settings"]["liveVoice"];
    assert_eq!(live["configured"], true, "{live}");
    assert_eq!(live["ttsProvider"], "openai");
    assert_eq!(live["sttProvider"], "deepgram");
    assert_eq!(live["ttsName"], "OpenAI Speech");
}

#[tokio::test]
async fn live_voice_still_works_with_only_an_elevenlabs_key() {
    let fixture = fixture();
    let app = app(&fixture);
    let (status, _) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::PUT,
        "/api/voice/settings",
        Some(json!({
            "ttsProvider": "browser-native",
            "sttProvider": "browser-native",
            "ttsProviderUpdate": {"provider": "elevenlabs", "apiKey": "el-test"},
            "sttProviderUpdate": {"provider": "elevenlabs", "apiKey": "el-test"},
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = call_json(&app, Some(USER_TOKEN), Method::GET, "/api/live-voice/preflight", None).await;
    assert_eq!(body["ready"], true, "{body}");
    assert_eq!(body["tts"]["provider"], "elevenlabs");
    assert_eq!(body["stt"]["provider"], "elevenlabs");
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    BASE64.encode(bytes)
}
