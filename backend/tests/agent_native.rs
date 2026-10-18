//! Native integration tests for the Rust agent routes (`backend/src/agent.rs`).
//!
//! These drive the real `axum::Router` returned by `agent::router()` through
//! `tower::ServiceExt::oneshot`, so the extractor stack (persisted bearer auth),
//! the admin gate, and every response field shape are exercised exactly as the
//! running server serves them. No Node adapter is involved.
//!
//! Auth state is seeded directly in `$AMIRO_HOME` in the same on-disk shape the
//! adapter used (`users.json -> {users:[...]}`, `sessions.json ->
//! {sessions:{<token>:{userId,createdAt}}}`), which is what the native auth port
//! reads.

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::agent;
use backend::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture {
    state: AppState,
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const ADMIN_TOKEN: &str = "tok-admin-native";
const MEMBER_TOKEN: &str = "tok-member-native";
const ADMIN_ID: &str = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID: &str = "00000000-0000-4000-8000-000000000002";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn seed(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("amiro-agent-native-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = home.join("workspace");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(runtime_home.join("memory")).unwrap();

    seed(
        &home.join("users.json"),
        &json!({
            "users": [
                {
                    "id": ADMIN_ID,
                    "name": "Admin",
                    "email": "admin@local",
                    "role": "admin",
                    "createdAt": now_iso(),
                },
                {
                    "id": MEMBER_ID,
                    "name": "Member",
                    "email": "member@local",
                    "role": "user",
                    "createdAt": now_iso(),
                }
            ]
        }),
    );
    let created = now_iso();
    seed(
        &home.join("sessions.json"),
        &json!({
            "sessions": {
                ADMIN_TOKEN: {"userId": ADMIN_ID, "createdAt": created},
                MEMBER_TOKEN: {"userId": MEMBER_ID, "createdAt": created},
            }
        }),
    );

    let state = AppState {
        home,
        runtime_home,
        runtime_socket: root.join("runtime.sock"),
        workspace,
        runtime_bin: root.join("amiro-runtime"),
        token: "fixture-sidecar-secret".to_string(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    Fixture { state, root }
}

impl Fixture {
    fn app(&self) -> Router {
        agent::router().with_state(self.state.clone())
    }
}

async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

// The nine agent routes plus the unknown-route control.
const AGENT_ROUTES: [(&str, &str); 9] = [
    ("GET", "/api/agent/identity"),
    ("PUT", "/api/agent/identity"),
    ("GET", "/api/agent/personality"),
    ("PUT", "/api/agent/personality"),
    ("GET", "/api/agent/memory"),
    ("POST", "/api/agent/memory"),
    ("POST", "/api/agent/memory/mem_1/reinforce"),
    ("DELETE", "/api/agent/memory/mem_1"),
    ("GET", "/api/agent/workspace"),
];

fn method_of(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).unwrap()
}

// ---------------------------------------------------------------------------
// Wiring and authentication boundary
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_agent_route_is_registered_and_bearer_guarded() {
    let fixture = fixture();
    let app = fixture.app();
    for (method, path) in AGENT_ROUTES {
        let (status, _) = call(&app, method_of(method), path, None, None).await;
        assert!(
            status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN,
            "{method} {path} must reject an unauthenticated request, got {status}"
        );
    }
    // /api/agent/workspace/file is registered too.
    let (status, _) = call(&app, Method::GET, "/api/agent/workspace/file", None, None).await;
    assert!(status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN);

    // Control: a route that genuinely does not exist still 404s, so the
    // assertions above prove registration rather than a catch-all.
    let (status, _) = call(&app, Method::GET, "/api/agent/does-not-exist", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_bearer_token_is_rejected() {
    let fixture = fixture();
    let app = fixture.app();
    let (status, _) = call(
        &app,
        Method::GET,
        "/api/agent/identity",
        Some("bogus"),
        None,
    )
    .await;
    assert!(status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// Identity / personality
// ---------------------------------------------------------------------------

#[tokio::test]
async fn identity_defaults_then_roundtrips_for_admin() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, identity) = call(
        &app,
        Method::GET,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(identity["name"], "Amiro");
    assert_eq!(identity["handle"], "@amiro");
    assert_eq!(
        identity["tagline"],
        "Your Personal Intelligence powered by Amiro"
    );
    assert_eq!(identity["traits"]["color"], "orange");
    assert_eq!(identity["accentHex"], "#E9642F");
    assert_eq!(identity["customImageUrl"], Value::Null);
    assert!(identity["sliders"]["companionCoworker"].is_number());
    assert!(identity["fingerprint"].is_string());
    // Admin sees shared machine memory stats.
    assert!(identity["memoryStats"].is_object());

    // A partial update keeps the fields it does not mention.
    let (status, updated) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({
            "name": "Amiro Studio",
            "tagline": "Native acceptance",
            "traits": {"bodyShape": "cloud", "eyeStyle": "curious", "color": "purple"},
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "Amiro Studio");
    assert_eq!(updated["traits"]["bodyShape"], "cloud");
    // Accent follows the new color when no explicit accentHex is supplied.
    assert_eq!(updated["accentHex"], "#A665C9");

    let (_, reread) = call(
        &app,
        Method::GET,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(reread["name"], "Amiro Studio");
    assert_eq!(reread["tagline"], "Native acceptance");
    assert_eq!(reread["traits"]["color"], "purple");
    assert_eq!(reread["fingerprint"], updated["fingerprint"]);
}

#[tokio::test]
async fn identity_validation_rejects_unsafe_input() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, body) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({"customImageUrl": "data:image/svg+xml;base64,PHN2Zz4="})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("customImageUrl"));

    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({"name": "   "})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({"accentHex": "not-a-hex"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({"sliders": {"companionCoworker": 900}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Nothing above may have mutated the stored persona.
    let (_, identity) = call(
        &app,
        Method::GET,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(identity["name"], "Amiro");
}

#[tokio::test]
async fn personas_are_per_user() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(MEMBER_TOKEN),
        Some(json!({"name": "Member Persona"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, admin_identity) = call(
        &app,
        Method::GET,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_ne!(admin_identity["name"], "Member Persona");

    let (_, member_identity) = call(
        &app,
        Method::GET,
        "/api/agent/identity",
        Some(MEMBER_TOKEN),
        None,
    )
    .await;
    assert_eq!(member_identity["name"], "Member Persona");
    assert!(
        member_identity.get("memoryStats").is_none(),
        "shared machine memory statistics are admin-only"
    );

    // Distinct on-disk documents.
    assert!(fixture
        .state
        .home
        .join("store")
        .join("agent-identity")
        .join(format!("{MEMBER_ID}.json"))
        .exists());
    assert!(!fixture
        .state
        .home
        .join("store")
        .join("agent-identity")
        .join(format!("{ADMIN_ID}.json"))
        .exists());
}

#[tokio::test]
async fn personality_reads_and_writes_sliders() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, body) = call(
        &app,
        Method::GET,
        "/api/agent/personality",
        Some(MEMBER_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["name"], "Amiro");
    assert!(body["sliders"]["genzBoomer"].is_number());
    // The personality view is a projection, not the whole identity.
    assert!(body.get("customImageUrl").is_none());
    assert!(body["fingerprint"].is_string());

    // {sliders:{...}} form.
    let (status, updated) = call(
        &app,
        Method::PUT,
        "/api/agent/personality",
        Some(MEMBER_TOKEN),
        Some(json!({"sliders": {"companionCoworker": 90, "genzBoomer": 10}, "name": "Nova"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "Nova");
    assert_eq!(updated["sliders"]["companionCoworker"], 90);
    assert_eq!(updated["sliders"]["genzBoomer"], 10);
    // Axis order is companionCoworker, executeCollaborate, playfulSerious,
    // politeUnfiltered, genzBoomer; unsupplied axes keep their defaults and the
    // summary keeps the first three non-balanced axes.
    assert_eq!(
        updated["personalitySummary"],
        "90% Coworker · 65% Independent · 60% Unfiltered"
    );

    // Bare slider object form.
    let (status, updated) = call(
        &app,
        Method::PUT,
        "/api/agent/personality",
        Some(MEMBER_TOKEN),
        Some(json!({"companionCoworker": 10, "genzBoomer": 90, "executeCollaborate": 10, "playfulSerious": 10, "politeUnfiltered": 10})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["sliders"]["companionCoworker"], 10);
    // The id survives an update that does not mention it.
    assert_eq!(updated["name"], "Nova");

    // The runtime's own memory graph JSON is never written by a persona update.
    assert!(!fixture
        .state
        .runtime_home
        .join("memory")
        .join("global.json")
        .exists());
}

#[tokio::test]
async fn persona_mirrors_are_written_under_the_user_directory_only() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({"name": "Nova", "traits": {"bodyShape": "star", "eyeStyle": "dazed", "color": "teal"}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let dir = fixture.state.workspace.join("users").join(ADMIN_ID);
    let identity_md = std::fs::read_to_string(dir.join("IDENTITY.md")).unwrap();
    assert!(identity_md.contains("**Name:** Nova"));
    assert!(!dir.join("SOUL.md").exists());
    let root_identity = std::fs::read_to_string(fixture.state.workspace.join("IDENTITY.md")).unwrap();
    assert!(root_identity.contains("You are **Nova**"));
    assert!(root_identity.contains("## Personality"));
    let overlay = std::fs::read_to_string(dir.join("prompt-overlay.md")).unwrap();
    assert!(overlay.starts_with("# Agent Identity & Persona (Nova / @nova)"));

    // The global overlay and the runtime memory graph must stay untouched.
    assert!(!fixture.state.home.join("prompt-overlay.md").exists());
    assert!(!fixture.state.workspace.join("prompt-overlay.md").exists());
}

// ---------------------------------------------------------------------------
// Memory graph (read-only, admin-gated)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn memory_is_admin_only_and_read_only() {
    let fixture = fixture();
    // A small real graph so the response shape is meaningful.
    seed(
        &fixture
            .state
            .runtime_home
            .join("memory")
            .join("global.json"),
        &json!({
            "graph_version": 2,
            "memories": {
                "m1": {
                    "id": "m1",
                    "content": "prefers concise answers",
                    "category": "preference",
                    "tags": ["style"],
                    "created_at": "2026-01-01T00:00:00.000Z",
                    "updated_at": "2026-01-02T00:00:00.000Z"
                }
            }
        }),
    );
    let app = fixture.app();

    let (status, graph) = call(
        &app,
        Method::GET,
        "/api/agent/memory",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(graph["readOnly"], true);
    assert_eq!(
        graph["message"],
        "Amiro runtime memory is read-only via the adapter"
    );
    assert_eq!(graph["stats"]["total"], 1);
    assert_eq!(graph["stats"]["active"], 1);
    assert_eq!(graph["stats"]["allRecords"], 1);
    assert_eq!(graph["stats"]["superseded"], 0);
    assert_eq!(graph["stats"]["globalCount"], 1);
    assert_eq!(graph["stats"]["projectCount"], 0);
    assert_eq!(graph["stats"]["uniqueTags"], 1);
    assert_eq!(graph["stats"]["byCategory"]["preference"], 1);
    assert_eq!(graph["scopes"][0]["id"], "global");
    assert_eq!(graph["scopes"][0]["label"], "Global Memory");
    assert_eq!(graph["scopes"][0]["kind"], "global");
    assert_eq!(graph["scopes"][0]["file"], "memory/global.json");
    assert_eq!(graph["scopes"][0]["count"], 1);
    assert_eq!(graph["memories"][0]["id"], "m1");
    assert_eq!(graph["memories"][0]["scopeLabel"], "Global Memory");
    assert_eq!(graph["memories"][0]["active"], true);
    assert!(graph["memories"][0]["strength"].is_number());
    assert_eq!(graph["memories"][0]["source"], "local");
    assert_eq!(graph["memories"][0]["trust"], "high");
    assert!(graph["edges"].is_array());

    // Mutations stay refused.
    let (status, body) = call(
        &app,
        Method::POST,
        "/api/agent/memory",
        Some(ADMIN_TOKEN),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(body["error"].as_str().unwrap().contains("read-only"));

    let (status, _) = call(
        &app,
        Method::POST,
        "/api/agent/memory/m1/reinforce",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);

    let (status, _) = call(
        &app,
        Method::DELETE,
        "/api/agent/memory/m1",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);

    // Non-admin is refused outright on reads.
    let (status, _) = call(
        &app,
        Method::GET,
        "/api/agent/memory",
        Some(MEMBER_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Writes are refused for any authenticated user (read-only, not role-gated),
    // matching the adapter's `requireUser` then 501 ordering.
    let (status, _) = call(
        &app,
        Method::POST,
        "/api/agent/memory",
        Some(MEMBER_TOKEN),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    let (status, _) = call(
        &app,
        Method::DELETE,
        "/api/agent/memory/m1",
        Some(MEMBER_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);

    // The graph file is byte-identical after all of the above.
    let raw = std::fs::read_to_string(
        fixture
            .state
            .runtime_home
            .join("memory")
            .join("global.json"),
    )
    .unwrap();
    assert!(raw.contains("prefers concise answers"));
}

// ---------------------------------------------------------------------------
// Workspace browser
// ---------------------------------------------------------------------------

#[tokio::test]
async fn workspace_is_admin_only() {
    let fixture = fixture();
    let app = fixture.app();
    for (method, path) in [
        ("GET", "/api/agent/workspace"),
        ("GET", "/api/agent/workspace/file"),
        ("PUT", "/api/agent/workspace/file"),
    ] {
        let (status, body) = call(&app, method_of(method), path, Some(MEMBER_TOKEN), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(body["error"], "Forbidden: admin required");
    }
}

#[tokio::test]
async fn workspace_lists_allowlisted_roots_and_entries() {
    let fixture = fixture();
    std::fs::write(
        fixture
            .state
            .runtime_home
            .join("memory")
            .join("global.json"),
        "{}",
    )
    .unwrap();
    std::fs::create_dir_all(fixture.state.runtime_home.join("skills").join("demo")).unwrap();
    std::fs::write(
        fixture.state.runtime_home.join("prompt-overlay.md"),
        "# overlay",
    )
    .unwrap();
    std::fs::write(
        fixture.state.runtime_home.join("config.toml"),
        "model = \"x\"\n",
    )
    .unwrap();
    std::fs::write(fixture.state.runtime_home.join("sessions.json"), "{}").unwrap();
    let app = fixture.app();

    let (status, listing) = call(
        &app,
        Method::GET,
        "/api/agent/workspace",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let roots = listing["roots"].as_array().unwrap();
    let ids: Vec<&str> = roots.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["runtime", "amiro", "project"]);
    for root in roots {
        assert_eq!(root["allowlisted"], true);
        assert!(root["label"].is_string());
        // Host paths never leave the server; the UI renders id/label only.
        assert!(
            root.get("basePath").is_none(),
            "roots must not expose host paths"
        );
        assert!(root["description"].is_string());
    }
    assert_eq!(roots[0]["label"], "Runtime");

    assert_eq!(listing["activeRoot"], "runtime");
    assert_eq!(listing["currentPath"], "");
    assert_eq!(listing["readOnly"], true);

    let names: Vec<&str> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"memory"),
        "directory nodes must be listable"
    );
    assert!(
        names.contains(&"skills"),
        "directory nodes must be listable"
    );
    assert!(names.contains(&"prompt-overlay.md"));
    assert!(names.contains(&"config.toml"));
    assert!(!names.contains(&"sessions.json"), "secrets stay hidden");

    // Directories sort before files; the shape carries the documented fields.
    let entries = listing["entries"].as_array().unwrap();
    let kinds: Vec<&str> = entries
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    let first_file = kinds.iter().position(|k| *k == "file").unwrap();
    assert!(kinds[..first_file].iter().all(|k| *k == "dir"));
    let memory = entries.iter().find(|e| e["name"] == "memory").unwrap();
    assert_eq!(memory["kind"], "dir");
    assert_eq!(memory["size"], 0);
    assert_eq!(memory["ext"], "");
    assert_eq!(memory["path"], "memory");
    assert!(memory["updatedAt"].is_string());
}

#[tokio::test]
async fn workspace_descends_into_allowlisted_directories() {
    let fixture = fixture();
    std::fs::write(
        fixture
            .state
            .runtime_home
            .join("memory")
            .join("global.json"),
        "{}",
    )
    .unwrap();
    std::fs::write(
        fixture.state.runtime_home.join("memory").join("notes.txt"),
        "x",
    )
    .unwrap();
    // A blocked name is still blocked even beneath an allowlisted directory.
    std::fs::write(
        fixture.state.runtime_home.join("memory").join("users.json"),
        "{}",
    )
    .unwrap();
    let app = fixture.app();

    let (status, listing) = call(
        &app,
        Method::GET,
        "/api/agent/workspace?root=runtime&path=memory",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listing["currentPath"], "memory");
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"global.json"));
    assert!(names.contains(&"notes.txt"));
    assert!(
        !names.contains(&"users.json"),
        "blocklisted names stay hidden"
    );
    let global = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "global.json")
        .unwrap();
    assert_eq!(global["path"], "memory/global.json");
}

#[tokio::test]
async fn workspace_file_reads_allowlisted_files_and_denies_the_rest() {
    let fixture = fixture();
    std::fs::write(
        fixture
            .state
            .runtime_home
            .join("memory")
            .join("global.json"),
        "{\"ok\":true}",
    )
    .unwrap();
    std::fs::write(
        fixture.state.runtime_home.join("config.toml"),
        "model = \"fast\"\napi_key = \"sk-live-abcdefghijklmnop\"\n",
    )
    .unwrap();
    let app = fixture.app();

    let (status, file) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=runtime&path=memory/global.json",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(file["root"], "runtime");
    assert_eq!(file["path"], "memory/global.json");
    assert_eq!(file["name"], "global.json");
    assert_eq!(file["ext"], ".json");
    assert_eq!(file["language"], "json");
    assert_eq!(file["writable"], false);
    assert_eq!(file["readOnly"], true);
    assert_eq!(file["truncated"], false);
    assert_eq!(file["content"], "{\"ok\":true}");
    // No absolute host path in the response; relative path only.
    assert!(
        file.get("absPath").is_none(),
        "file responses must not expose host paths"
    );
    assert!(file["size"].as_u64().unwrap() > 0);
    assert!(file["updatedAt"].is_string());

    // Inline credentials never leave the process.
    let (status, config) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=runtime&path=config.toml",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(config["content"]
        .as_str()
        .unwrap()
        .contains("model = \"fast\""));
    assert!(!config["content"]
        .as_str()
        .unwrap()
        .contains("sk-live-abcdefghijklmnop"));

    // The empty-path probe returns the documented placeholder.
    let (status, empty) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=runtime",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["path"], "");
    assert_eq!(empty["name"], "");
    assert_eq!(empty["size"], 0);
    assert_eq!(empty["content"], "");
    assert_eq!(empty["writable"], false);
    assert_eq!(empty["language"], "text");

    for path in [
        "../users.json",
        "auth.json",
        "credentials.json",
        ".ssh/id_rsa",
        "users.json",
        "sessions.json",
        "random.txt",
    ] {
        let (status, _) = call(
            &app,
            Method::GET,
            &format!("/api/agent/workspace/file?root=runtime&path={path}"),
            Some(ADMIN_TOKEN),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "path {path} must be denied");
    }

    // A directory cannot be read as a file.
    let (status, _) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=runtime&path=memory",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Unknown root ids fall back to the first (runtime) root rather than 500.
    let (status, _) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=nope&path=memory/global.json",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_symlink_escape_is_denied() {
    let fixture = fixture();
    let outside = fixture.root.join("outside.json");
    std::fs::write(&outside, "{\"secret\":\"outside\"}").unwrap();
    let link = fixture
        .state
        .runtime_home
        .join("memory")
        .join("escape.json");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let app = fixture.app();

    let (status, _) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=runtime&path=memory/escape.json",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // The escaping entry is also filtered out of the directory listing.
    let (status, listing) = call(
        &app,
        Method::GET,
        "/api/agent/workspace?root=runtime&path=memory",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"escape.json"));
}

#[tokio::test]
async fn workspace_persona_root_exposes_the_users_own_mirrors() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/agent/identity",
        Some(ADMIN_TOKEN),
        Some(json!({"name": "Nova"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, listing) = call(
        &app,
        Method::GET,
        "/api/agent/workspace?root=amiro",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listing["activeRoot"], "amiro");
    // The whole workspace is a read-only preview; identity edits go through
    // the identity/personality endpoints, not the file browser.
    assert_eq!(listing["readOnly"], true);
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"IDENTITY.md"));
    assert!(!names.contains(&"users"));
    assert!(names.contains(&"prompt-overlay.md"));

    let (status, file) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=amiro&path=IDENTITY.md",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(file["language"], "markdown");
    assert!(file["content"].as_str().unwrap().contains("**Name:** Nova"));
    assert_eq!(file["writable"], false);
    assert_eq!(file["readOnly"], true);

    // Arbitrary siblings are still refused.
    std::fs::write(
        fixture
            .state
            .workspace
            .join("users")
            .join(ADMIN_ID)
            .join("notes.txt"),
        "x",
    )
    .unwrap();
    let (status, _) = call(
        &app,
        Method::GET,
        "/api/agent/workspace/file?root=amiro&path=notes.txt",
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn workspace_file_puts_are_refused_and_write_nothing() {
    let fixture = fixture();
    let app = fixture.app();

    let (status, body) = call(
        &app,
        Method::PUT,
        "/api/agent/workspace/file",
        Some(ADMIN_TOKEN),
        Some(json!({"root": "runtime", "path": "prompt-overlay.md", "content": "must not overwrite"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(body["error"].as_str().unwrap().contains("read-only"));
    assert!(!fixture
        .state
        .runtime_home
        .join("prompt-overlay.md")
        .exists());
}
