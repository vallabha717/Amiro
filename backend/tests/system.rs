//! `GET /api/system` backs the General page (version, CPU, memory, disk).

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

fn app() -> (axum::Router, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("amiro-system-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    std::fs::write(
        home.join("users.json"),
        json!({"users": [{"id": "u1", "name": "Owner", "role": "admin", "createdAt": now}]}).to_string(),
    )
    .unwrap();
    std::fs::write(
        home.join("sessions.json"),
        json!({"sessions": {"tok": {"userId": "u1", "createdAt": now}}}).to_string(),
    )
    .unwrap();
    let state = AppState {
        home,
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("s.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("rt"),
        token: "sidecar".into(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    (router().with_state(state), root)
}

async fn get(app: &axum::Router, auth: bool) -> (StatusCode, Value) {
    let mut req = Request::builder().uri("/api/system");
    if auth {
        req = req.header("authorization", "Bearer tok");
    }
    let res = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn system_requires_auth_and_reports_version_and_resources() {
    let (app, root) = app();
    assert_eq!(get(&app, false).await.0, StatusCode::UNAUTHORIZED);

    let (status, body) = get(&app, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["version"], json!(env!("CARGO_PKG_VERSION")));
    assert!(body["cpu"]["cores"].as_u64().unwrap_or(0) >= 1);
    if cfg!(target_os = "linux") {
        let mem = &body["memory"];
        assert!(mem["totalMb"].as_f64().unwrap() > 0.0);
        assert!(mem["usedMb"].as_f64().unwrap() <= mem["totalMb"].as_f64().unwrap());
        assert!(body["disk"]["totalMb"].as_f64().unwrap() > 0.0);
        let cpu = body["cpu"]["percent"].as_f64().unwrap();
        assert!((0.0..=100.0).contains(&cpu));
    }
    let _ = std::fs::remove_dir_all(root);
}
