//! Integration tests for team agents' computers: the tool switches
//! (`/api/agents/{id}/computer`), the isolation statement, and running a tool
//! through the sandbox supervisor with the agent's own credential.
//!
//! The supervisor is a fake on loopback that checks the token and the
//! per-agent credential, so nothing here needs Docker. The real boundary is
//! measured by `backend/sandboxd/tests/live_docker.rs`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::Path as UrlPath;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use backend::state::AppState;
use sandboxd::credential::agent_credential;
use serde_json::{json, Value};
use tower::ServiceExt;

const OWNER_TOKEN: &str = "tok-computer-owner";
const OWNER_ID: &str = "owner-computer";
const MEMBER_TOKEN: &str = "tok-computer-member";
const MEMBER_ID: &str = "member-computer";
const SUPERVISOR_TOKEN: &str = "fixture-supervisor-token-0123456789abcdef";
const MASTER: &str = "fixture-master-secret-fedcba9876543210ffff";

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
    let root = std::env::temp_dir().join(format!("amiro-computer-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    std::fs::create_dir_all(root.join("workspace")).unwrap();
    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": OWNER_ID, "name": "Owner", "email": "owner@example.test", "role": "admin", "createdAt": now_iso()},
            {"id": MEMBER_ID, "name": "Member", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            OWNER_TOKEN: {"userId": OWNER_ID, "createdAt": now_iso()},
            MEMBER_TOKEN: {"userId": MEMBER_ID, "createdAt": now_iso()},
        }}),
    );
    let state = AppState {
        home,
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("amiro-api.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("amiro-runtime"),
        token: "fixture-sidecar-secret".to_string(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    Fixture { state, root }
}

/// Point this fixture's backend at a supervisor (written the way
/// `scripts/sandbox.sh up` writes it).
fn configure_sandbox(fx: &Fixture, url: &str) {
    let file = fx.state.home.join("sandbox").join("supervisor.env");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        file,
        format!("# test\nAMIRO_SANDBOX_URL={url}\nAMIRO_SANDBOX_TOKEN={SUPERVISOR_TOKEN}\nAMIRO_SANDBOX_MASTER={MASTER}\n"),
    )
    .unwrap();
}

fn app(fx: &Fixture) -> Router {
    backend::routes::router().with_state(fx.state.clone())
}

async fn call(app: &Router, token: Option<&str>, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => builder.header("content-length", "0").body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024).await.unwrap();
    let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, value)
}

async fn create_agent(app: &Router, name: &str) -> String {
    let (status, agent) = call(app, Some(OWNER_TOKEN), Method::POST, "/api/agents", Some(json!({"name": name}))).await;
    assert_eq!(status, StatusCode::CREATED, "{agent}");
    agent["id"].as_str().unwrap().to_string()
}

/// Requests the fake supervisor accepted, as `"<action> <agent id>"`.
type Log = Arc<Mutex<Vec<String>>>;

/// A loopback fake of `amiro-sandboxd` that enforces the same auth: the
/// supervisor token, and the credential derived for the agent in the path.
async fn fake_supervisor() -> (String, Log) {
    let log: Log = Arc::default();
    let authorized = |headers: &HeaderMap, id: &str| {
        headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {SUPERVISOR_TOKEN}"))
            && headers.get("x-amiro-agent-credential").and_then(|v| v.to_str().ok())
                == Some(agent_credential(MASTER, id).as_str())
    };
    let reply = move |log: Log, action: &'static str| {
        move |UrlPath(id): UrlPath<String>, headers: HeaderMap, body: Option<axum::Json<Value>>| {
            let log = log.clone();
            async move {
                if !authorized(&headers, &id) {
                    return (StatusCode::FORBIDDEN, axum::Json(json!({"error": "credential does not match this agent"})));
                }
                log.lock().unwrap().push(format!("{action} {id}"));
                let body = body.map(|b| b.0).unwrap_or(Value::Null);
                let out = match action {
                    "status" => json!({"state": "running", "network": "bridge", "runtime": "runc"}),
                    "selfcheck" => json!({"uid": 1000, "capEff": "0000000000000000", "noCapabilities": true, "dockerSocket": false, "homeMounts": ["/home/agent"]}),
                    "exec" => json!({"exitCode": 0, "stdout": format!("ran: {}\n", body["command"].as_str().unwrap_or("")), "stderr": "", "truncated": false, "timedOut": false}),
                    "terminal-create" => json!({"session_id": "remote-term-1", "id": "remote-term-1", "agent_id": id}),
                    "terminal-input" | "terminal-resize" | "terminal-destroy" => json!({"ok": true}),
                    "write" => json!({"bytes": body["content"].as_str().map(str::len).unwrap_or(0)}),
                    "read" => json!({"content": "hello from the container", "truncated": false}),
                    _ => json!({"entries": [{"name": "notes", "kind": "folder", "size": 0}, {"name": "a.md", "kind": "file", "size": 3}], "truncated": false}),
                };
                (StatusCode::OK, axum::Json(out))
            }
        }
    };
    let app = Router::new()
        .route("/health", get(|| async { axum::Json(json!({"ok": true, "docker": true})) }))
        .route("/v1/agents/{id}/status", get(reply(log.clone(), "status")))
        .route("/v1/agents/{id}/selfcheck", get(reply(log.clone(), "selfcheck")))
        .route("/v1/agents/{id}/exec", post(reply(log.clone(), "exec")))
        .route("/v1/agents/{id}/files/write", post(reply(log.clone(), "write")))
        .route("/v1/agents/{id}/files/read", post(reply(log.clone(), "read")))
        .route("/v1/agents/{id}/files/list", post(reply(log.clone(), "list")))
        .route("/v1/agents/{id}/terminal/sessions", post(reply(log.clone(), "terminal-create")))
        .route("/v1/agents/{id}/terminal/sessions/remote-term-1", axum::routing::delete(reply(log.clone(), "terminal-destroy")))
        .route("/v1/agents/{id}/terminal/sessions/remote-term-1/input", post(reply(log.clone(), "terminal-input")))
        .route("/v1/agents/{id}/terminal/sessions/remote-term-1/resize", post(reply(log.clone(), "terminal-resize")));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, log)
}

/// A loopback address nothing listens on.
async fn dead_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    url
}

#[tokio::test]
async fn tools_default_off_and_only_the_owner_switches_them() {
    let fx = fixture();
    let app = app(&fx);
    let id = create_agent(&app, "Scout").await;
    let uri = format!("/api/agents/{id}/computer");

    let (status, computer) = call(&app, Some(MEMBER_TOKEN), Method::GET, &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(computer["tools"], json!({"shell": false, "files": false, "browser": false}));
    assert_eq!(computer["isolation"], "none");
    assert_eq!(computer["configured"], false);

    let (status, _) = call(&app, None, Method::GET, &uri, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, None, Method::PATCH, &uri, Some(json!({"tools": {"shell": true}}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"shell": true}}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, computer) = call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"shell": true}}))).await;
    assert_eq!(status, StatusCode::OK, "{computer}");
    assert_eq!(computer["tools"], json!({"shell": true, "files": false, "browser": false}));
    // No supervisor configured: tools are on but cannot run anywhere.
    assert_eq!(computer["isolation"], "unavailable");

    let (_, again) = call(&app, Some(OWNER_TOKEN), Method::GET, &uri, None).await;
    assert_eq!(again["tools"]["shell"], true, "the switch is stored");
    let registry: Value = serde_json::from_slice(&std::fs::read(fx.state.home.join("store/agents.json")).unwrap()).unwrap();
    assert_eq!(registry["agents"][0]["tools"]["shell"], true);
}

#[tokio::test]
async fn bad_switches_and_the_main_agent_are_refused() {
    let fx = fixture();
    let app = app(&fx);
    let id = create_agent(&app, "Scout").await;
    let uri = format!("/api/agents/{id}/computer");
    for body in [
        json!({"tools": {"browser": true}}),
        json!({"tools": {"sudo": true}}),
        json!({"tools": {"shell": "yes"}}),
        json!({}),
    ] {
        let (status, error) = call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body} → {error}");
    }
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents/main/computer", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::PATCH, "/api/agents/main/computer", Some(json!({"tools": {"shell": true}}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let unknown = "0".repeat(32);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::GET, &format!("/api/agents/{unknown}/computer"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents/..%2F..%2Fetc/computer", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn with_the_supervisor_up_tools_run_in_the_container_with_the_agents_own_credential() {
    let fx = fixture();
    let app = app(&fx);
    let (url, log) = fake_supervisor().await;
    configure_sandbox(&fx, &url);
    let scout = create_agent(&app, "Scout").await;
    let other = create_agent(&app, "Other").await;
    let uri = format!("/api/agents/{scout}/computer");

    let (_, computer) = call(&app, Some(OWNER_TOKEN), Method::GET, &uri, None).await;
    assert_eq!(computer["configured"], true);
    assert_eq!(computer["available"], true);
    assert_eq!(computer["isolation"], "none", "available, but every tool is off");

    let (_, computer) = call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"shell": true, "files": true}}))).await;
    assert_eq!(computer["isolation"], "container", "{computer}");
    assert_eq!(computer["state"], "running");
    let text = computer.to_string();
    assert!(!text.contains(SUPERVISOR_TOKEN) && !text.contains(MASTER), "no secret in a response");

    let (status, check) = call(&app, Some(OWNER_TOKEN), Method::POST, &format!("{uri}/check"), None).await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["capEff"], "0000000000000000");
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::POST, &format!("{uri}/check"), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let out = backend::sandbox::run_tool(&fx.state, &scout, "agent_shell", &json!({"command": "id -u"})).await.unwrap();
    assert_eq!(out, "exit code: 0\nran: id -u\n");
    let out = backend::sandbox::run_tool(&fx.state, &scout, "agent_write_file", &json!({"path": "notes/a.md", "content": "abc"})).await.unwrap();
    assert_eq!(out, "Wrote 3 bytes to notes/a.md.");
    let out = backend::sandbox::run_tool(&fx.state, &scout, "agent_list_files", &json!({})).await.unwrap();
    assert_eq!(out, "notes/\na.md (3 bytes)");
    let err = backend::sandbox::run_tool(&fx.state, &scout, "agent_read_file", &json!({"path": "../other/x"})).await.unwrap_err();
    assert!(err.contains(".."), "{err}");

    // The other agent's switches are still off: its call is refused before
    // any request leaves the backend.
    let err = backend::sandbox::run_tool(&fx.state, &other, "agent_shell", &json!({"command": "id"})).await.unwrap_err();
    assert!(err.contains("switched shell off"), "{err}");

    // Every accepted request carried the credential for the agent it named.
    let seen = log.lock().unwrap().clone();
    assert!(seen.iter().all(|entry| entry.ends_with(&scout)), "{seen:?}");
    assert!(seen.contains(&format!("exec {scout}")));
}

#[tokio::test]
async fn a_tool_never_falls_back_to_the_host_when_the_supervisor_is_down() {
    let fx = fixture();
    let app = app(&fx);
    configure_sandbox(&fx, &dead_url().await);
    let id = create_agent(&app, "Scout").await;
    let uri = format!("/api/agents/{id}/computer");
    let (_, computer) = call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"shell": true, "files": true}}))).await;
    assert_eq!(computer["configured"], true);
    assert_eq!(computer["available"], false);
    assert_eq!(computer["isolation"], "unavailable");

    let sentinel = fx.root.join("host-sentinel");
    let command = format!("touch {}", sentinel.display());
    let err = backend::sandbox::run_tool(&fx.state, &id, "agent_shell", &json!({"command": command})).await.unwrap_err();
    assert_eq!(err, backend::sandbox::UNAVAILABLE);
    assert!(!sentinel.exists(), "the command must not have run on the host");
    let err = backend::sandbox::run_tool(&fx.state, &id, "agent_write_file", &json!({"path": "x.md", "content": "x"})).await.unwrap_err();
    assert_eq!(err, backend::sandbox::UNAVAILABLE);
    assert!(!fx.state.home.join("agents").join(&id).join("x.md").exists());

    let (status, error) = call(&app, Some(OWNER_TOKEN), Method::POST, &format!("{uri}/check"), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{error}");
}

#[tokio::test]
async fn a_team_agents_chat_offers_only_its_switched_on_tools() {
    let fx = fixture();
    let app = app(&fx);
    let id = create_agent(&app, "Scout").await;
    let toolset = backend::sandbox::AgentToolset::for_agent(&fx.state, &id).await.unwrap().unwrap();
    assert!(toolset.definitions.is_empty(), "every tool starts off");
    let uri = format!("/api/agents/{id}/computer");
    call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"files": true}}))).await;
    let toolset = backend::sandbox::AgentToolset::for_agent(&fx.state, &id).await.unwrap().unwrap();
    let names: Vec<_> = toolset.definitions.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["agent_read_file", "agent_write_file", "agent_list_files"]);
    assert!(!toolset.handles("agent_shell") && !toolset.handles("bash"));
    assert!(backend::sandbox::AgentToolset::for_agent(&fx.state, "main").await.unwrap().is_none());
}

#[tokio::test]
async fn only_the_agents_own_remote_connectors_are_offered() {
    let fx = fixture();
    let app = app(&fx);
    let id = create_agent(&app, "Scout").await;
    let config = json!({"mcpServers": {
        "github": {"url": "https://github.example/mcp"},
        "files": {"command": "npx", "args": ["server-filesystem", "/"]}
    }});
    // The main runtime's connectors carry the owner's credentials: never
    // offered to a team agent.
    seed(&fx.state.runtime_home.join("mcp.json"), &config);
    let toolset = backend::sandbox::AgentToolset::for_agent(&fx.state, &id).await.unwrap().unwrap();
    assert!(toolset.mcp_servers.is_empty(), "{:?}", toolset.mcp_servers);

    // The agent's own runtime (agents-private/<id>/runtime) with a local
    // server in it: no MCP at all, since mcp_call could reach it.
    let mut scoped = fx.state.clone();
    scoped.runtime_home = fx.state.home.join("agents-private").join(&id).join("runtime");
    seed(&scoped.runtime_home.join("mcp.json"), &config);
    let toolset = backend::sandbox::AgentToolset::for_agent(&scoped, &id).await.unwrap().unwrap();
    assert!(toolset.mcp_servers.is_empty(), "{:?}", toolset.mcp_servers);

    // Remote servers only: they are offered.
    seed(&scoped.runtime_home.join("mcp.json"), &json!({"mcpServers": {"github": {"url": "https://github.example/mcp"}}}));
    let toolset = backend::sandbox::AgentToolset::for_agent(&scoped, &id).await.unwrap().unwrap();
    assert_eq!(toolset.mcp_servers, vec!["github".to_string()]);
}

#[tokio::test]
async fn terminal_sessions_support_main_host_pty_and_enforce_team_agent_sandbox_policy() {
    let fx = fixture();
    let app = app(&fx);
    let (url, log) = fake_supervisor().await;
    configure_sandbox(&fx, &url);
    let scout = create_agent(&app, "Scout").await;

    // Non-admin is forbidden from opening debug terminal sessions.
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::POST, "/api/terminal/sessions", Some(json!({"agentId": "main"}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Main agent ("main") with the sandbox up: the shared shell in Amiro's
    // desktop container (the same one as the terminal on its TV).
    let (status, main_sess) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/terminal/sessions", Some(json!({"agentId": "main", "cols": 100, "rows": 30}))).await;
    assert_eq!(status, StatusCode::CREATED, "{main_sess}");
    assert_eq!(main_sess["agent_id"], "main");
    assert_eq!(main_sess["isolation"], "container");
    let main_sid = main_sess["session_id"].as_str().unwrap().to_string();
    assert!(log.lock().unwrap().contains(&"terminal-create main".to_string()));

    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, &format!("/api/terminal/sessions/{main_sid}/resize"), Some(json!({"cols": 120, "rows": 40}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, &format!("/api/terminal/sessions/{main_sid}/input"), Some(json!({"data": "echo hello\n"}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, &format!("/api/terminal/sessions/{main_sid}"), None).await;
    assert_eq!(status, StatusCode::OK);

    // Team agent with shell tool OFF is refused before reaching supervisor.
    let (status, err) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/terminal/sessions", Some(json!({"agentId": scout}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert!(err["error"].as_str().unwrap_or("").contains("Shell access is disabled"));

    // Turn shell ON for Scout -> terminal session delegates to supervisor with Scout's credential.
    let uri = format!("/api/agents/{scout}/computer");
    call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"shell": true}}))).await;

    let (status, team_sess) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/terminal/sessions", Some(json!({"agentId": scout, "cols": 90, "rows": 28}))).await;
    assert_eq!(status, StatusCode::CREATED, "{team_sess}");
    assert_eq!(team_sess["agent_id"], scout);
    assert_eq!(team_sess["isolation"], "container");
    assert_eq!(team_sess["cwd"], "/home/agent");
    let team_sid = team_sess["session_id"].as_str().unwrap().to_string();

    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, &format!("/api/terminal/sessions/{team_sid}/input"), Some(json!({"data": "pwd\n"}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, &format!("/api/terminal/sessions/{team_sid}/resize"), Some(json!({"cols": 110, "rows": 32}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, &format!("/api/terminal/sessions/{team_sid}"), None).await;
    assert_eq!(status, StatusCode::OK);

    let seen = log.lock().unwrap().clone();
    assert!(seen.contains(&format!("terminal-create {scout}")), "{seen:?}");
    assert!(seen.contains(&format!("terminal-input {scout}")), "{seen:?}");
    assert!(seen.contains(&format!("terminal-resize {scout}")), "{seen:?}");
    assert!(seen.contains(&format!("terminal-destroy {scout}")), "{seen:?}");
}

#[tokio::test]
async fn main_terminal_is_a_host_pty_when_there_is_no_sandbox() {
    let fx = fixture();
    let app = app(&fx);
    let (status, sess) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/terminal/sessions", Some(json!({"agentId": "main", "cols": 100, "rows": 30}))).await;
    assert_eq!(status, StatusCode::CREATED, "{sess}");
    assert_eq!(sess["isolation"], "host");
    let sid = sess["session_id"].as_str().unwrap().to_string();
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, &format!("/api/terminal/sessions/{sid}"), None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn agent_browser_supports_main_and_isolated_team_agents() {
    let fx = fixture();
    let app = app(&fx);
    let (url, log) = fake_supervisor().await;
    configure_sandbox(&fx, &url);
    let scout = create_agent(&app, "Scout").await;

    // Main agent navigate to about:blank produces a viewport screenshot and saves state
    let (status, nav) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/debug/browser/navigate", Some(json!({"agentId": "main", "url": "about:blank"}))).await;
    assert_eq!(status, StatusCode::OK, "{nav}");
    assert_eq!(nav["isolation"], "host");
    assert_eq!(nav["page"]["title"], "Blank Page");
    assert!(nav["page"]["screenshot"].as_str().unwrap_or("").starts_with("data:image/svg+xml;base64,"));

    // Scout with shell/browser OFF is refused before reaching supervisor
    let (status, err) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/debug/browser/navigate", Some(json!({"agentId": scout, "url": "https://example.com"}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");

    // Enable shell for Scout -> browser navigation executes inside Scout's container via supervisor
    let uri = format!("/api/agents/{scout}/computer");
    call(&app, Some(OWNER_TOKEN), Method::PATCH, &uri, Some(json!({"tools": {"shell": true}}))).await;

    let (status, team_nav) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/debug/browser/navigate", Some(json!({"agentId": scout, "url": "https://example.com"}))).await;
    assert_eq!(status, StatusCode::OK, "{team_nav}");
    assert_eq!(team_nav["isolation"], "container");
    assert!(team_nav["page"]["screenshot"].as_str().unwrap_or("").starts_with("data:image/svg+xml;base64,"));

    // Scout's browser state is isolated from main's
    let (_, main_state) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/debug/browser", None).await;
    assert_eq!(main_state["page"]["url"], "about:blank");

    let seen = log.lock().unwrap().clone();
    assert!(seen.contains(&format!("exec {scout}")), "{seen:?}");
}
