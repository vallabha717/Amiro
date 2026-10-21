//! Supervisor API authorisation and input checks, against a fake Docker
//! engine on a unix socket (so no real container is ever created here).

mod common;

use std::sync::{Arc, Mutex};

use axum::http::Method;
use axum::routing::{any, get};
use axum::{Json, Router};
use common::{agent, call, Call, MASTER, TOKEN};
use sandboxd::docker::Docker;
use sandboxd::server::{router, Supervisor};
use sandboxd::spec::SandboxConfig;
use serde_json::{json, Value};

const A: &str = "0123456789abcdef0123456789abcdef";
const B: &str = "fedcba9876543210fedcba9876543210";

/// Every path the fake engine was asked for.
type Seen = Arc<Mutex<Vec<String>>>;

async fn fake_docker() -> (std::path::PathBuf, Seen) {
    let dir = std::env::temp_dir().join(format!("amiro-sandboxd-fake-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("docker.sock");
    let seen: Seen = Arc::default();
    let log = seen.clone();
    let app = Router::new()
        .route("/_ping", get(|| async { "OK" }))
        .fallback(any(move |req: axum::extract::Request| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(format!("{} {}", req.method(), req.uri()));
                (axum::http::StatusCode::NOT_FOUND, Json(json!({"message": "No such container"})))
            }
        }));
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (socket, seen)
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

async fn app() -> (Router, Seen) {
    let (socket, seen) = fake_docker().await;
    let cfg = SandboxConfig::new(1000, 1000, "/home/owner/.amiro/agents");
    let sup = Supervisor::new(cfg, Docker::new(socket), TOKEN.into(), MASTER.into()).unwrap();
    (router(Arc::new(sup)), seen)
}

#[tokio::test]
async fn health_needs_no_auth_and_reveals_nothing_else() {
    let (app, _) = app().await;
    let (status, body) = call(&app, Call { method: Method::GET, path: "/health".into(), token: None, as_agent: None, body: None }).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({"ok": true, "docker": true}));
}

#[tokio::test]
async fn agent_routes_need_the_token_and_that_agents_credential() {
    let (app, seen) = app().await;
    let status_path = format!("/v1/agents/{A}/status");

    let (status, _) = call(&app, Call { method: Method::GET, path: status_path.clone(), token: None, as_agent: Some(A), body: None }).await;
    assert_eq!(status, 401, "no supervisor token");

    let (status, _) = call(&app, Call { method: Method::GET, path: status_path.clone(), token: Some("wrong-token-wrong-token-wrong"), as_agent: Some(A), body: None }).await;
    assert_eq!(status, 401, "wrong supervisor token");

    let (status, _) = call(&app, Call { method: Method::GET, path: status_path.clone(), token: Some(TOKEN), as_agent: None, body: None }).await;
    assert_eq!(status, 403, "no agent credential");

    let (status, body) = call(&app, Call { method: Method::GET, path: status_path.clone(), token: Some(TOKEN), as_agent: Some(B), body: None }).await;
    assert_eq!(status, 403, "agent B's credential on agent A's route");
    assert_eq!(body["error"], "credential does not match this agent");

    assert!(seen.lock().unwrap().is_empty(), "Docker must not be touched before auth passes");

    let (status, body) = agent(&app, Method::GET, A, "status", None).await;
    assert_eq!(status, 200);
    assert_eq!(body["state"], "missing");
}

#[tokio::test]
async fn bad_ids_and_paths_are_refused_before_docker() {
    let (app, seen) = app().await;
    let (status, _) = call(&app, Call { method: Method::GET, path: "/v1/agents/main/status".into(), token: Some(TOKEN), as_agent: Some("main"), body: None }).await;
    assert_eq!(status, 400);

    for path in ["/etc/passwd", "../other/notes.md", "a/../../b", "~/x"] {
        let (status, body) = agent(&app, Method::POST, A, "files/read", Some(json!({"path": path}))).await;
        assert_eq!(status, 400, "{path}: {body}");
        let (status, _) = agent(&app, Method::POST, A, "files/write", Some(json!({"path": path, "content": "x"}))).await;
        assert_eq!(status, 400, "{path}");
    }
    let (status, _) = agent(&app, Method::POST, A, "exec", Some(json!({"command": "  "}))).await;
    assert_eq!(status, 400);
    let big = "x".repeat(sandboxd::server::WRITE_CAP + 1);
    let (status, _) = agent(&app, Method::POST, A, "files/write", Some(json!({"path": "big.txt", "content": big}))).await;
    assert_eq!(status, 400);
    assert!(seen.lock().unwrap().is_empty(), "nothing reached Docker: {:?}", seen.lock().unwrap());
}

#[tokio::test]
async fn a_missing_image_is_reported_plainly() {
    let (app, _) = app().await;
    // The fake engine answers create with 404 "No such container"; a real
    // engine says "No such image". Either way ensure fails, and never creates
    // anything on the host.
    let (status, body) = agent(&app, Method::POST, A, "ensure", Some(Value::Null)).await;
    assert!(status >= 400, "{body}");
    assert!(body["error"].is_string());
}

#[test]
fn supervisor_refuses_short_or_equal_secrets() {
    let cfg = SandboxConfig::new(1000, 1000, "/x");
    assert!(Supervisor::new(cfg.clone(), Docker::new("/nonexistent"), "short".into(), MASTER.into()).is_err());
    assert!(Supervisor::new(cfg.clone(), Docker::new("/nonexistent"), TOKEN.into(), "short".into()).is_err());
    assert!(Supervisor::new(cfg, Docker::new("/nonexistent"), MASTER.into(), MASTER.into()).is_err());
}
