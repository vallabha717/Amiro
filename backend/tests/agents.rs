//! Integration tests for the agent team (`/api/agents`) and how team agents'
//! threads behave in the shared thread and chat routes.
//!
//! The real router is driven through `tower::ServiceExt::oneshot`. No runtime
//! is started: every path here settles before a turn would begin.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const OWNER_TOKEN: &str = "tok-agents-owner";
const OWNER_ID: &str = "owner-agents";
const MEMBER_TOKEN: &str = "tok-agents-member";
const MEMBER_ID: &str = "member-agents";

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
    let root = std::env::temp_dir().join(format!("amiro-agents-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();
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
    backend::routes::router()
        .merge(backend::threads::router())
        .merge(backend::chat::router())
        .merge(backend::agent::router())
        .with_state(fixture.state.clone())
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

fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

async fn create_scout(app: &Router) -> Value {
    let (status, agent) = call(
        app,
        Some(OWNER_TOKEN),
        Method::POST,
        "/api/agents",
        Some(json!({
            "name": "Scout",
            "role": "Research assistant",
            "instructions": "Find sources and cite them.",
            "traits": {"bodyShape": "sprout", "eyeStyle": "curious", "color": "teal"}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{agent}");
    agent
}

#[tokio::test]
async fn team_agent_create_makes_workspace_identity_and_channel() {
    let fx = fixture();
    let app = app(&fx);
    let agent = create_scout(&app).await;
    let id = agent["id"].as_str().unwrap();

    assert_eq!(agent["isMain"], false);
    assert_eq!(agent["accentHex"], "#0E9B8B");
    let dir = fx.state.home.join("agents").join(id);
    assert_eq!(agent["workspaceDir"], json!(dir.to_string_lossy()));
    let identity = std::fs::read_to_string(dir.join("IDENTITY.md")).unwrap();
    assert!(identity.contains("**Name:** Scout"));
    assert!(identity.contains("Find sources and cite them."));
    assert!(dir.join("SOUL.md").is_file() && dir.join("NOW.md").is_file());
    assert!(!dir.join("BOOTSTRAP.md").exists());
    // The team folder is outside the main agent's workspace.
    assert!(!dir.starts_with(&fx.state.workspace));

    let channel = agent["channelThreadId"].as_str().unwrap();
    let threads = read(&fx.state.home.join("threads.json"));
    assert_eq!(threads[channel]["agentId"], json!(id));
    assert_eq!(threads[channel]["channel"], true);
    assert_eq!(threads[channel]["userId"], OWNER_ID);
    assert_eq!(threads[channel]["title"], "Scout");
}

#[tokio::test]
async fn team_list_puts_main_first_and_keeps_channels_stable() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;

    let (status, body) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents", None).await;
    assert_eq!(status, StatusCode::OK);
    let agents = body["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2);
    assert_eq!(agents[0]["id"], "main");
    assert_eq!(agents[0]["isMain"], true);
    assert_eq!(agents[1]["id"], scout["id"]);
    assert_eq!(agents[1]["channelThreadId"], scout["channelThreadId"]);

    // Reading again returns the same channels, not new ones.
    let (_, again) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents", None).await;
    assert_eq!(again["agents"][0]["channelThreadId"], agents[0]["channelThreadId"]);
    assert_eq!(again["agents"][1]["channelThreadId"], agents[1]["channelThreadId"]);

    // Another user gets their own channel with the same agent.
    let (_, member) = call(&app, Some(MEMBER_TOKEN), Method::GET, "/api/agents", None).await;
    assert_ne!(member["agents"][1]["channelThreadId"], agents[1]["channelThreadId"]);
}

#[tokio::test]
async fn team_routes_require_auth_and_owner_for_changes() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call(&app, None, Method::GET, "/api/agents", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::POST, "/api/agents", Some(json!({"name": "X"}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/agents", Some(json!({"name": "  "}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let scout = create_scout(&app).await;
    let uri = format!("/api/agents/{}", scout["id"].as_str().unwrap());
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::PATCH, &uri, Some(json!({"name": "Y"}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::DELETE, &uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn team_main_agent_is_edited_elsewhere_and_ids_cannot_traverse() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::PATCH, "/api/agents/main", Some(json!({"name": "Y"}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, "/api/agents/main", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    for bad in ["..%2F..%2Fetc", "nope", "ABCDEF0123456789ABCDEF0123456789"] {
        let (status, _) = call(&app, Some(OWNER_TOKEN), Method::GET, &format!("/api/agents/{bad}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
}

#[tokio::test]
async fn team_agent_edit_rewrites_identity() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let (status, updated) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::PATCH,
        &format!("/api/agents/{id}"),
        Some(json!({"role": "Writer", "instructions": "Write short drafts."})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "Scout");
    assert_eq!(updated["role"], "Writer");
    let identity = std::fs::read_to_string(fx.state.home.join("agents").join(id).join("IDENTITY.md")).unwrap();
    assert!(identity.contains("**Tagline:** Writer"));
    assert!(identity.contains("Write short drafts.") && !identity.contains("Find sources"));
}

#[tokio::test]
async fn team_channel_cannot_be_deleted_and_sidebar_hides_team_threads() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let scout_id = scout["id"].as_str().unwrap().to_string();
    let (_, team) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents", None).await;
    let main_channel = team["agents"][0]["channelThreadId"].as_str().unwrap().to_string();
    let scout_channel = scout["channelThreadId"].as_str().unwrap().to_string();

    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, &format!("/api/thread/{scout_channel}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, "/api/thread", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let threads = read(&fx.state.home.join("threads.json"));
    assert!(threads.get(&scout_channel).is_some() && threads.get(&main_channel).is_some());

    let (status, list) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/thread", None).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&main_channel.as_str()));
    assert!(!ids.contains(&scout_channel.as_str()));
    let main_item = list.as_array().unwrap().iter().find(|t| t["id"] == json!(main_channel)).unwrap();
    assert_eq!(main_item["channel"], true);
    assert_eq!(main_item["agentId"], "main");

    let (status, own) = call(&app, Some(OWNER_TOKEN), Method::GET, &format!("/api/agents/{scout_id}/threads"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(own["threads"][0]["id"], json!(scout_channel));
    assert_eq!(own["threads"][0]["channel"], true);
}

#[tokio::test]
async fn team_agent_delete_archives_its_folder_and_threads() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let dir = fx.state.home.join("agents").join(id);
    std::fs::write(dir.join("notes.md"), "keep me").unwrap();

    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::DELETE, &format!("/api/agents/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!dir.exists());
    let archived: Vec<_> = std::fs::read_dir(fx.state.home.join("agents-archive")).unwrap().flatten().collect();
    assert_eq!(archived.len(), 1);
    assert!(archived[0].path().join("notes.md").is_file());
    let threads = read(&fx.state.home.join("threads.json"));
    assert!(threads.get(scout["channelThreadId"].as_str().unwrap()).is_none());
    // Its private runtime and key vault are removed, not archived.
    assert!(!fx.state.home.join("agents-private").join(id).exists());
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::GET, &format!("/api/agents/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn team_agent_files_list_skips_hidden_and_secrets() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let dir = fx.state.home.join("agents").join(id);
    std::fs::create_dir_all(dir.join("reports")).unwrap();
    std::fs::write(dir.join("reports/weekly.md"), "hi").unwrap();
    std::fs::write(dir.join(".hidden"), "x").unwrap();
    std::fs::write(dir.join("prod.env"), "SECRET=1").unwrap();

    let (status, body) = call(&app, Some(MEMBER_TOKEN), Method::GET, &format!("/api/agents/{id}/files"), None).await;
    assert_eq!(status, StatusCode::OK);
    let paths: Vec<&str> = body["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"IDENTITY.md"));
    assert!(paths.contains(&"reports/weekly.md"));
    assert!(!paths.iter().any(|p| p.contains("hidden") || p.ends_with(".env")));
}

async fn call_as_agent(app: &Router, agent: &str, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {OWNER_TOKEN}"))
        .header("x-amiro-agent", agent);
    let request = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            builder.body(Body::from(serde_json::to_vec(&value).unwrap())).unwrap()
        }
        None => builder.header("content-length", "0").body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024).await.unwrap();
    let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, value)
}

/// The main runtime's provider setup: settings, an API key, a subscription sign-in.
fn seed_main_brain(fx: &Fixture) {
    let runtime = &fx.state.runtime_home;
    std::fs::create_dir_all(runtime.join("config/jcode")).unwrap();
    std::fs::write(runtime.join("config.toml"), "[provider]\ndefault = \"opencode-go\"\n").unwrap();
    std::fs::write(runtime.join("config/jcode/opencode-go.env"), "OPENCODE_GO_API_KEY=test-key\n").unwrap();
    std::fs::write(runtime.join("auth.json"), "{\"anthropic_accounts\":[]}").unwrap();
    std::fs::write(runtime.join("mcp.json"), "{\"servers\":{\"main-only\":{}}}").unwrap();
}

#[tokio::test]
async fn team_agent_gets_its_own_runtime_with_copied_api_key_providers() {
    let fx = fixture();
    seed_main_brain(&fx);
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let private = fx.state.home.join("agents-private").join(id).join("runtime");

    assert!(private.join("config.toml").is_file());
    let key = private.join("config/jcode/opencode-go.env");
    assert_eq!(std::fs::read_to_string(&key).unwrap(), "OPENCODE_GO_API_KEY=test-key\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&key).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Subscription sign-ins and connectors are the agent's own, never copied.
    assert!(!private.join("auth.json").exists());
    assert!(!private.join("mcp.json").exists());
    // Its private data is outside its workspace.
    assert!(!private.starts_with(fx.state.home.join("agents")));
}

#[tokio::test]
async fn team_agent_with_empty_brain_starts_without_providers() {
    let fx = fixture();
    seed_main_brain(&fx);
    let app = app(&fx);
    let (status, agent) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::POST,
        "/api/agents",
        Some(json!({"name": "Blank", "brain": "empty"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let private = fx.state.home.join("agents-private").join(agent["id"].as_str().unwrap()).join("runtime");
    assert!(!private.join("config.toml").exists());
}

#[tokio::test]
async fn team_agent_keys_live_in_its_own_vault() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();

    let (status, body) = call_as_agent(
        &app,
        id,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service": "scout-notes", "field": "token", "value": "scout-secret-value"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (_, scout_list) = call_as_agent(&app, id, Method::GET, "/api/credentials", None).await;
    let (_, main_list) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/credentials", None).await;
    let services = |list: &Value| -> Vec<String> {
        list["items"].as_array().unwrap().iter().map(|i| i["service"].as_str().unwrap_or("").to_string()).collect()
    };
    assert!(services(&scout_list).contains(&"scout-notes".to_string()));
    assert!(!services(&main_list).contains(&"scout-notes".to_string()));
    // The value is encrypted in the agent's private vault, never in plain text.
    let vault = fx.state.home.join("agents-private").join(id);
    assert!(vault.exists());
    let raw: String = walk(&vault).into_iter().map(|p| String::from_utf8_lossy(&std::fs::read(p).unwrap()).to_string()).collect();
    assert!(!raw.contains("scout-secret-value"));
    assert!(!scout_list.to_string().contains("scout-secret-value"));
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
    out
}

#[tokio::test]
async fn team_agent_connectors_are_its_own_and_remote_only() {
    let fx = fixture();
    seed_main_brain(&fx);
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let agent_mcp = fx.state.home.join("agents-private").join(id).join("runtime/mcp.json");

    let (status, body) = call_as_agent(
        &app,
        id,
        Method::POST,
        "/api/connectors/custom",
        Some(json!({"name": "local-tool", "transport": "stdio", "command": "npx", "args": ["-y", "pkg"]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap_or("").contains("remote (URL) connectors"));
    assert!(!agent_mcp.exists() || !std::fs::read_to_string(&agent_mcp).unwrap().contains("local-tool"));

    let (status, body) = call_as_agent(
        &app,
        id,
        Method::POST,
        "/api/connectors/custom",
        Some(json!({"name": "scout-web", "transport": "http", "url": "https://mcp.example.test/mcp"})),
    )
    .await;
    assert!(status.is_success(), "{status} {body}");
    let written = std::fs::read_to_string(&agent_mcp).unwrap();
    assert!(written.contains("scout-web"));
    // The main agent's connectors are untouched and never copied in.
    assert!(!written.contains("main-only"));
    let main = std::fs::read_to_string(fx.state.runtime_home.join("mcp.json")).unwrap();
    assert!(!main.contains("scout-web"));
}

#[tokio::test]
async fn team_agent_space_personality_edits_only_that_agent() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();

    let (status, identity) = call_as_agent(&app, id, Method::GET, "/api/agent/identity", None).await;
    assert_eq!(status, StatusCode::OK, "{identity}");
    assert_eq!(identity["name"], "Scout");
    assert_eq!(identity["tagline"], "Research assistant");

    let (status, body) = call_as_agent(
        &app,
        id,
        Method::PUT,
        "/api/agent/identity",
        Some(json!({"name": "Scouty", "traits": {"bodyShape": "cloud", "eyeStyle": "curious", "color": "pink"}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The main agent's identity is untouched.
    let (_, main) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agent/identity", None).await;
    assert_ne!(main["name"], "Scouty");
    // Team shows the new name and look.
    let (_, team) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents", None).await;
    let listed = team["agents"].as_array().unwrap().iter().find(|a| a["id"] == json!(id)).unwrap().clone();
    assert_eq!(listed["name"], "Scouty");
    assert_eq!(listed["traits"]["color"], "pink");
    // Its IDENTITY.md has the new name and keeps its instructions.
    let md = std::fs::read_to_string(fx.state.home.join("agents").join(id).join("IDENTITY.md")).unwrap();
    assert!(md.contains("**Name:** Scouty"));
    assert!(md.contains("Find sources and cite them."));
    assert!(!fx.state.workspace.join("IDENTITY.md").exists()
        || !std::fs::read_to_string(fx.state.workspace.join("IDENTITY.md")).unwrap().contains("Scouty"));
}

#[tokio::test]
async fn team_agent_space_lists_only_its_own_chats() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let (_, team) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agents", None).await;
    let main_channel = team["agents"][0]["channelThreadId"].as_str().unwrap().to_string();
    let scout_channel = scout["channelThreadId"].as_str().unwrap().to_string();

    let (status, scoped) = call_as_agent(&app, id, Method::GET, "/api/thread", None).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = scoped.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&scout_channel.as_str()));
    assert!(!ids.contains(&main_channel.as_str()));
}

#[tokio::test]
async fn team_agent_space_has_its_own_schedules() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    // Schedule changes need this instance to own the scheduler.
    let scheduler = backend::schedules::spawn_scheduler(fx.state.clone());
    for _ in 0..100 {
        if backend::schedules::mutation_allowed(&fx.state) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(backend::schedules::mutation_allowed(&fx.state), "scheduler never became ready");
    let at = (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let body = json!({
        "name": "Scout digest", "prompt": "Summarise new sources.", "mode": "notify",
        "timezone": "UTC", "schedule": {"kind": "once", "at": at},
    });
    let (status, created) = call_as_agent(&app, id, Method::POST, "/api/schedules", Some(body)).await;
    assert!(status.is_success(), "{status} {created}");

    let names = |list: &Value| -> Vec<String> {
        let rows = list.get("schedules").unwrap_or(list);
        rows.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap_or("").to_string()).collect()
    };
    let (_, scoped) = call_as_agent(&app, id, Method::GET, "/api/schedules", None).await;
    let (_, main) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/schedules", None).await;
    assert!(names(&scoped).contains(&"Scout digest".to_string()), "{scoped}");
    assert!(!names(&main).contains(&"Scout digest".to_string()), "{main}");
    scheduler.abort();
}

#[tokio::test]
async fn team_scoped_request_for_unknown_agent_is_rejected() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call_as_agent(&app, "0123456789abcdef0123456789abcdef", Method::GET, "/api/credentials", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call_as_agent(&app, "../../etc", Method::GET, "/api/credentials", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call_as_agent(&app, "main", Method::GET, "/api/credentials", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn team_chat_with_unknown_agent_is_rejected_before_a_turn() {
    let fx = fixture();
    let app = app(&fx);
    let (status, body) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::POST,
        "/api/chat",
        Some(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "agentId": "0123456789abcdef0123456789abcdef",
            "message": {"role": "user", "parts": [{"type": "text", "text": "hi"}]}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn agent_prompt_shows_identity_and_soul_without_notes() {
    let fx = fixture();
    let app = app(&fx);

    let (status, _) = call(&app, None, Method::GET, "/api/agent/prompt", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::GET, "/api/agent/prompt", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A fresh owner gets the files written on first read.
    let (status, body) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/agent/prompt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let files = body["files"].as_array().unwrap();
    let names: Vec<&str> = files.iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["IDENTITY.md", "SOUL.md"]);
    assert!(files[0]["content"].as_str().unwrap().contains("**Name:** Amiro"));
    let soul = files[1]["content"].as_str().unwrap();
    assert!(soul.contains("# SOUL.md"));
    assert!(soul.lines().all(|line| !line.starts_with("_ ")), "notes are stripped");

    // A team agent's prompt is its own.
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();
    let (status, body) = call_as_agent(&app, id, Method::GET, "/api/agent/prompt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let identity = body["files"][0]["content"].as_str().unwrap();
    assert!(identity.contains("**Name:** Scout"));
    assert!(identity.contains("Find sources and cite them."));
}

#[tokio::test]
async fn team_agent_search_providers_are_its_own() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;
    let id = scout["id"].as_str().unwrap();

    let (status, main) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::POST,
        "/api/search/providers",
        Some(json!({"name": "DuckDuckGo", "provider": "duckduckgo", "apiKey": ""})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{main}");
    let uri = format!("/api/search/providers/{}/activate", main["id"].as_str().unwrap());
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, &uri, None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, own) = call_as_agent(
        &app,
        id,
        Method::POST,
        "/api/search/providers",
        Some(json!({"name": "Bing Search", "provider": "bing", "apiKey": ""})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{own}");
    let uri = format!("/api/search/providers/{}/activate", own["id"].as_str().unwrap());
    let (status, _) = call_as_agent(&app, id, Method::POST, &uri, None).await;
    assert_eq!(status, StatusCode::OK);

    let active = |list: &Value| {
        list.as_array()
            .unwrap()
            .iter()
            .filter(|p| p["isActive"] == true)
            .map(|p| p["provider"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let (_, main_list) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/search/providers", None).await;
    let (_, scout_list) = call_as_agent(&app, id, Method::GET, "/api/search/providers", None).await;
    assert_eq!(active(&main_list), ["duckduckgo"], "{main_list}");
    assert_eq!(active(&scout_list), ["bing"], "{scout_list}");
    // The team agent's store lives in its private folder, not its workspace.
    let private = fx.state.home.join("agents-private").join(id).join("store/search-providers.json");
    assert!(private.is_file());
}
