//! The composer's `/` commands and `@` file search, against the real router.
//! No runtime runs here, so commands are checked up to the point where they
//! would reach it (validation, the conversation-has-not-started rule) and the
//! file search exercises the walk a new chat uses.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

fn app() -> (axum::Router, std::path::PathBuf, AppState) {
    let root = std::env::temp_dir().join(format!("amiro-composer-{}", uuid::Uuid::new_v4()));
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
    let workspace = root.join("workspace");
    for dir in ["src/components", "docs", "node_modules/x", ".git"] {
        std::fs::create_dir_all(workspace.join(dir)).unwrap();
    }
    for file in [
        "README.md",
        "src/components/readme-card.tsx",
        "docs/setup.md",
        "node_modules/x/readme.md",
        ".git/config",
    ] {
        std::fs::write(workspace.join(file), "x").unwrap();
    }
    let state = AppState {
        home,
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("s.sock"),
        workspace,
        runtime_bin: root.join("rt"),
        token: "sidecar".into(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    (router().with_state(state.clone()), root, state)
}

async fn request(app: &axum::Router, method: &str, uri: &str, body: Option<Value>, auth: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if auth {
        builder = builder.header("authorization", "Bearer tok");
    }
    let req = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn composer_routes_require_auth() {
    let (app, root, _) = app();
    let (status, _) = request(&app, "GET", "/api/composer/files?q=readme", None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = request(&app, "POST", "/api/composer/command", Some(json!({"command": "compact"})), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn unknown_commands_are_refused_and_conversation_commands_need_a_conversation() {
    let (app, root, _) = app();
    let (status, body) = request(&app, "POST", "/api/composer/command", Some(json!({"command": "/logout"})), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("not a command"), "{body}");

    for command in ["/compact", "context", "/info"] {
        let (status, body) = request(
            &app,
            "POST",
            "/api/composer/command",
            Some(json!({"command": command, "threadId": "not-started"})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{command}");
        assert!(body["error"].as_str().unwrap().contains("Send a message first"), "{body}");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn at_lists_workspace_files_and_folders_best_match_first_without_build_folders() {
    let (app, root, _) = app();
    let (status, body) = request(&app, "GET", "/api/composer/files?q=readme", None, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["source"], json!("walk"));
    assert_eq!(
        body["entries"],
        json!([
            {"path": "README.md", "kind": "file"},
            {"path": "src/components/readme-card.tsx", "kind": "file"},
        ])
    );

    // Folders are offered too, before files at the same rank.
    let (_, body) = request(&app, "GET", "/api/composer/files?q=comp", None, true).await;
    assert_eq!(body["entries"][0], json!({"path": "src/components", "kind": "folder"}));

    let (_, body) = request(&app, "GET", "/api/composer/files?q=&limit=1", None, true).await;
    assert_eq!(body["entries"].as_array().unwrap().len(), 1);

    let (_, body) = request(&app, "GET", "/api/composer/files?q=config", None, true).await;
    assert_eq!(body["entries"], json!([]), ".git must never be listed");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn at_refuses_folders_outside_the_allowed_roots() {
    let (app, root, _) = app();
    let (status, _) = request(&app, "GET", "/api/composer/files?q=x&projectDirectory=relative/path", None, true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = request(&app, "GET", "/api/composer/files?q=x&projectDirectory=/etc", None, true).await;
    assert!(status == StatusCode::FORBIDDEN || status == StatusCode::BAD_REQUEST, "{status}");
    let _ = std::fs::remove_dir_all(root);
}
