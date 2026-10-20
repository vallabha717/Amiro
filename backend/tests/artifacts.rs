//! Artifacts: file documents the user/agent generate, saved under
//! `workspace/artifacts/<user>/<id>/<file>` with metadata in
//! `store/artifacts.json`.

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;

const USER_TOKEN: &str = "tok-artifacts-user";
const USER_ID: &str = "user-artifacts";

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

fn seed(path: &std::path::Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("amiro-artifacts-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();
    std::fs::create_dir_all(root.join("workspace")).unwrap();

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
) -> (StatusCode, bytes::Bytes) {
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
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    (status, bytes)
}

async fn call_json(
    app: &Router,
    token: Option<&str>,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (status, bytes) = send(app, token, method, uri, body).await;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

/// A minimal but header-valid dummy PDF (one page, "hello artifacts").
fn dummy_pdf() -> Vec<u8> {
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 180 Td (hello artifacts) Tj ET\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF".to_vec()
}

/// A minimal dummy docx payload: a real .docx is a zip; for the store-roundtrip
/// the opaque bytes only need the ZIP magic so viewers sniff it as OOXML.
fn dummy_docx() -> Vec<u8> {
    let mut out = b"PK\x03\x04".to_vec();
    out.extend_from_slice(b"dummy-docx-payload-hello-artifacts");
    out
}

#[tokio::test]
async fn artifacts_require_auth() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call_json(&app, None, Method::GET, "/api/artifacts", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call_json(
        &app,
        None,
        Method::POST,
        "/api/artifacts",
        Some(json!({"filename": "x.md", "contentText": "hi"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_list_get_download_update_delete_markdown() {
    let fx = fixture();
    let app = app(&fx);

    let (status, created) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/artifacts",
        Some(json!({
            "title": "Hello doc",
            "filename": "hello.md",
            "contentText": "# Hello\n\nFrom the agent.",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["kind"], json!("markdown"));

    // Saved as a real workspace file, not just JSON metadata.
    let rel = created["workspacePath"].as_str().unwrap().to_string();
    assert!(rel.starts_with("artifacts/"));
    let abs = fx.state.workspace.join(&rel);
    assert!(abs.is_file(), "workspace file missing: {}", abs.display());

    let (status, list) = call_json(&app, Some(USER_TOKEN), Method::GET, "/api/artifacts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);

    let (status, one) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        &format!("/api/artifacts/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(one["contentText"], json!("# Hello\n\nFrom the agent."));

    let (status, bytes) = send(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        &format!("/api/artifacts/{id}/download"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&bytes[..], b"# Hello\n\nFrom the agent.");

    let (status, updated) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::PUT,
        &format!("/api/artifacts/{id}"),
        Some(json!({"title": "Hello doc v2"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["title"], json!("Hello doc v2"));

    let (status, _) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::DELETE,
        &format!("/api/artifacts/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!abs.is_file(), "workspace file should be removed");
}

#[tokio::test]
async fn dummy_pdf_and_docx_roundtrip() {
    use base64::Engine;
    let fx = fixture();
    let app = app(&fx);

    let pdf_b64 = base64::engine::general_purpose::STANDARD.encode(dummy_pdf());
    let (status, pdf) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/artifacts",
        Some(json!({
            "title": "Dummy PDF",
            "filename": "dummy.pdf",
            "contentBase64": pdf_b64,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pdf}");
    assert_eq!(pdf["kind"], json!("pdf"));
    assert_eq!(pdf["mime"], json!("application/pdf"));
    let pdf_id = pdf["id"].as_str().unwrap().to_string();
    let pdf_rel = pdf["workspacePath"].as_str().unwrap().to_string();
    assert!(fx.state.workspace.join(&pdf_rel).is_file());
    // Binary artifacts do not inline text into the JSON detail.
    let (status, pdf_get) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        &format!("/api/artifacts/{pdf_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(pdf_get.get("contentText").is_none());

    let (status, bytes) = send(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        &format!("/api/artifacts/{pdf_id}/download"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&bytes[..], &dummy_pdf()[..]);

    let docx_b64 = base64::engine::general_purpose::STANDARD.encode(dummy_docx());
    let (status, docx) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/artifacts",
        Some(json!({
            "title": "Dummy Word doc",
            "filename": "dummy.docx",
            "contentBase64": docx_b64,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{docx}");
    assert_eq!(docx["kind"], json!("docx"));
    let docx_id = docx["id"].as_str().unwrap().to_string();
    let (status, bytes) = send(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        &format!("/api/artifacts/{docx_id}/download"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&bytes[..2], b"PK");
    assert_eq!(&bytes[..], &dummy_docx()[..]);
}

#[tokio::test]
async fn rejects_bad_input_and_missing_ids() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/artifacts",
        Some(json!({"filename": "x.md"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call_json(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        "/api/artifacts/does-not-exist",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
