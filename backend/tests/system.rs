//! `GET /api/system` tests (version, deployment, CPU, memory, disk).

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
        json!({"users": [{"id": "u1", "name": "Owner", "role": "admin", "createdAt": now}]})
            .to_string(),
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
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn env_guard(name: &str, value: &str) -> Option<(String, Option<String>)> {
    let previous = std::env::var(name).ok();
    std::env::set_var(name, value);
    Some((name.to_string(), previous))
}

fn env_restore(guarded: Option<(String, Option<String>)>) {
    let Some((name, previous)) = guarded else {
        return;
    };
    match previous {
        Some(value) => std::env::set_var(&name, value),
        None => std::env::remove_var(&name),
    }
}

#[tokio::test]
async fn system_reports_deployment_for_local_vm_and_desktop_modes() {
    let (app, root) = app();

    // Tests in one process mutate the environment serially.
    let _lock = DEPLOYMENT_ENV_LOCK.lock().await;

    // Default: a local (loopback) server install.
    let host_guard = env_guard("AMIRO_HOST", "127.0.0.1");
    let port_guard = env_guard("AMIRO_PORT", "8123");
    let desktop_guard = env_guard("AMIRO_DESKTOP", "0");
    let (_, body) = get(&app, true).await;
    let deployment = &body["deployment"];
    assert_eq!(deployment["mode"], json!("local-server"));
    assert_eq!(deployment["bindHost"], json!("127.0.0.1"));
    assert_eq!(deployment["port"], json!(8123));
    let urls = deployment["accessUrls"].as_array().unwrap();
    assert!(urls.iter().any(|u| u == &json!("http://localhost:8123")));
    assert_eq!(deployment["desktopBundled"], json!(false));
    env_restore(desktop_guard);

    // VM install: AMIRO_HOST=0.0.0.0 flips the mode and adds LAN URLs.
    let host_guard2 = env_guard("AMIRO_HOST", "0.0.0.0");
    let (_, body) = get(&app, true).await;
    let deployment = &body["deployment"];
    assert_eq!(deployment["mode"], json!("vm-remote"));
    assert_eq!(deployment["bindHost"], json!("0.0.0.0"));
    let urls = deployment["accessUrls"].as_array().unwrap();
    assert!(urls.iter().any(|u| u == &json!("http://localhost:8123")));
    for url in urls {
        assert!(url.as_str().unwrap().starts_with("http://"));
    }
    env_restore(host_guard2);

    // Desktop: AMIRO_DESKTOP=1 wins over a remote bind (the Tauri shell always
    // binds loopback; the flag is explicit and unambiguous).
    let host_guard3 = env_guard("AMIRO_HOST", "127.0.0.1");
    let desktop_guard2 = env_guard("AMIRO_DESKTOP", "1");
    let (_, body) = get(&app, true).await;
    assert_eq!(body["deployment"]["mode"], json!("desktop"));
    env_restore(desktop_guard2);
    env_restore(host_guard3);

    env_restore(port_guard);
    env_restore(host_guard);
    let _ = std::fs::remove_dir_all(root);
}

static DEPLOYMENT_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
