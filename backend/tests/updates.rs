//! Self-update API tests: `/api/system/update`, `/update/job`,
//! `/update/settings`, and the job that survives a restart.
//!
//! GitHub is a local stub (`AMIRO_UPDATE_API_BASE`) and the updater is a
//! throwaway script (`AMIRO_UPDATE_COMMAND`), so nothing is downloaded or
//! installed. Tests share process-wide env vars, so they run one at a time.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use axum::Json;
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const CURRENT: &str = env!("CARGO_PKG_VERSION");

struct Fixture {
    app: axum::Router,
    state: AppState,
    root: std::path::PathBuf,
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("amiro-updates-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    std::fs::create_dir_all(home.join("store")).unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    std::fs::write(
        home.join("users.json"),
        json!({"users": [
            {"id": "u1", "name": "Owner", "role": "admin", "createdAt": now},
            {"id": "u2", "name": "Guest", "role": "user", "createdAt": now}
        ]})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        home.join("sessions.json"),
        json!({"sessions": {
            "tok": {"userId": "u1", "createdAt": now},
            "guest": {"userId": "u2", "createdAt": now}
        }})
        .to_string(),
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
    Fixture {
        app: router().with_state(state.clone()),
        state,
        root,
    }
}

/// A stand-in for `api.github.com` that reports `tag` as the latest release.
async fn github_stub(tag: &'static str) -> String {
    let app = axum::Router::new().route(
        "/repos/{owner}/{name}/releases/latest",
        get(move || async move {
            Json(json!({
                "tag_name": tag,
                "html_url": format!("https://github.com/vallabha717/Amiro/releases/tag/{tag}"),
                "published_at": "2026-10-25T13:30:00Z",
                "body": "## What's new\n\n- Self-update for every build",
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

/// An executable `amiro` stand-in that prints a line and exits with `code`.
fn updater_script(root: &std::path::Path, code: i32) -> std::path::PathBuf {
    let path = root.join("amiro");
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(
        &path,
        format!("#!/bin/sh\necho \"\\033[32mupdating\\033[0m to $2\"\necho \"args: $*\"\nexit {code}\n"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

async fn call(app: &axum::Router, method: &str, uri: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let req = match body {
        Some(b) => req
            .header("content-type", "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn set_env(pairs: &[(&str, Option<&str>)]) {
    for (k, v) in pairs {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
}

fn clear_env() {
    set_env(&[
        ("AMIRO_UPDATE_API_BASE", None),
        ("AMIRO_UPDATE_COMMAND", None),
        ("AMIRO_DESKTOP", None),
        ("AMIRO_SOURCE_DIR", None),
        ("AMIRO_SOURCE_UPDATE_COMMAND", None),
        ("AMIRO_RUNNING_COMMIT", None),
    ]);
}

/// Poll the job endpoint until it leaves `installing`.
async fn settled_job(app: &axum::Router) -> Value {
    for _ in 0..100 {
        let (_, body) = call(app, "GET", "/api/system/update/job", Some("tok"), None).await;
        if body["job"]["state"] != "installing" {
            return body["job"].clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("update job never settled");
}

#[tokio::test]
async fn status_reports_the_latest_release_notes_and_how_this_build_updates() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let base = github_stub("v99.0.0").await;
    set_env(&[("AMIRO_UPDATE_API_BASE", Some(&base)), ("AMIRO_UPDATE_COMMAND", None), ("AMIRO_DESKTOP", None)]);

    let (status, body) = call(&fx.app, "GET", "/api/system/update", Some("tok"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["current"], CURRENT);
    assert_eq!(body["latest"], "v99.0.0");
    assert_eq!(body["updateAvailable"], true);
    assert_eq!(body["checkFailed"], false);
    assert!(body["notes"].as_str().unwrap().contains("Self-update"));
    // A test binary has no `amiro` script beside it: a source build.
    assert_eq!(body["method"], "manual");
    assert_eq!(body["canSelfUpdate"], false);
    assert_eq!(body["settings"], json!({"autoCheck": true, "autoInstall": false}));
    assert_eq!(body["job"]["state"], "idle");

    set_env(&[("AMIRO_DESKTOP", Some("1"))]);
    let (_, body) = call(&fx.app, "GET", "/api/system/update?refresh=1", Some("tok"), None).await;
    assert_eq!(body["method"], "desktop");

    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn an_unreachable_github_is_reported_not_raised() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    // Nothing listens on port 9 (discard) on loopback.
    set_env(&[("AMIRO_UPDATE_API_BASE", Some("http://127.0.0.1:9")), ("AMIRO_UPDATE_COMMAND", None), ("AMIRO_DESKTOP", None)]);
    let (status, body) = call(&fx.app, "GET", "/api/system/update?refresh=1", Some("tok"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["checkFailed"], true);
    assert_eq!(body["updateAvailable"], false);
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn update_routes_need_the_owner() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    for (method, uri) in [
        ("GET", "/api/system/update"),
        ("POST", "/api/system/update"),
        ("GET", "/api/system/update/job"),
        ("PUT", "/api/system/update/settings"),
    ] {
        let body = (method != "GET").then(|| json!({}));
        let (status, _) = call(&fx.app, method, uri, None, body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri} without a session");
        let (status, _) = call(&fx.app, method, uri, Some("guest"), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} as a non-owner");
    }
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn settings_are_saved_and_validated() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let (status, body) = call(&fx.app, "PUT", "/api/system/update/settings", Some("tok"), Some(json!({"autoInstall": true}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"autoCheck": true, "autoInstall": true}));
    let (status, body) = call(&fx.app, "PUT", "/api/system/update/settings", Some("tok"), Some(json!({"autoCheck": false}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"autoCheck": false, "autoInstall": true}));
    let (status, _) = call(&fx.app, "PUT", "/api/system/update/settings", Some("tok"), Some(json!({"autoCheck": "yes"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let saved: Value = serde_json::from_slice(&std::fs::read(fx.state.home.join("store/update-settings.json")).unwrap()).unwrap();
    assert_eq!(saved, json!({"autoCheck": false, "autoInstall": true}));
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn builds_without_an_updater_refuse_to_self_update() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    set_env(&[("AMIRO_UPDATE_COMMAND", None), ("AMIRO_DESKTOP", None)]);
    let (status, body) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "v99.0.0"}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap_or_default().contains("install.sh") || body.to_string().contains("install.sh"));

    set_env(&[("AMIRO_DESKTOP", Some("1"))]);
    let (status, body) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "v99.0.0"}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.to_string().contains("desktop app updates itself"));
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn a_failing_updater_is_recorded_with_its_log() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let script = updater_script(&fx.root.join("bin"), 3);
    set_env(&[("AMIRO_UPDATE_COMMAND", Some(script.to_str().unwrap())), ("AMIRO_DESKTOP", None)]);

    let (status, _) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "nope/../../x"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": CURRENT}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "already on this version");

    let (status, body) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "99.0.0"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["started"], true);
    assert_eq!(body["version"], "v99.0.0");
    assert_eq!(body["job"]["state"], "installing");
    assert_eq!(body["job"]["trigger"], "manual");

    let job = settled_job(&fx.app).await;
    assert_eq!(job["state"], "failed");
    assert!(job["error"].as_str().unwrap().contains("exit code 3"));
    let log = job["log"].as_str().unwrap();
    assert!(log.contains("updating to v99.0.0"), "colour codes stripped: {log}");
    assert!(log.contains("args: update v99.0.0"), "argv is `update <version>`: {log}");
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn a_successful_updater_waits_for_the_restart() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let script = updater_script(&fx.root.join("bin"), 0);
    set_env(&[("AMIRO_UPDATE_COMMAND", Some(script.to_str().unwrap())), ("AMIRO_DESKTOP", None)]);
    let (status, _) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "v99.0.0"}))).await;
    assert_eq!(status, StatusCode::OK);
    let job = settled_job(&fx.app).await;
    assert_eq!(job["state"], "restarting");

    // A second update while one is pending is refused.
    let (status, _) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "v99.0.1"}))).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // The server came back on another version: the job failed, says so.
    backend::updates::reconcile_on_start(&fx.state).await;
    let (_, body) = call(&fx.app, "GET", "/api/system/update/job", Some("tok"), None).await;
    assert_eq!(body["job"]["state"], "failed");
    assert!(body["job"]["error"].as_str().unwrap().contains("instead of v99.0.0"));
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn a_restart_on_the_target_version_marks_the_job_succeeded() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    std::fs::write(
        fx.state.home.join("store/update-state.json"),
        json!({"state": "restarting", "from": "v1.0.0", "target": format!("v{CURRENT}"), "trigger": "auto"}).to_string(),
    )
    .unwrap();
    backend::updates::reconcile_on_start(&fx.state).await;
    let (_, body) = call(&fx.app, "GET", "/api/system/update/job", Some("tok"), None).await;
    assert_eq!(body["current"], CURRENT);
    assert_eq!(body["job"]["state"], "succeeded");
    assert!(body["job"]["finishedAt"].is_string());
    let _ = std::fs::remove_dir_all(&fx.root);
}

// ---------------------------------------------------------------------------
// Source checkouts: a real git checkout with a local `origin`, and a stand-in
// for `scripts/amiro-server.sh update` (AMIRO_SOURCE_UPDATE_COMMAND).
// ---------------------------------------------------------------------------

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=Amiro Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Source {
    checkout: std::path::PathBuf,
    /// The commit the checkout (and the "running" server) is on.
    old: String,
    /// The newer commit on origin/main.
    new: String,
}

/// `origin` (bare) has two commits on main; the checkout is one behind.
fn source_checkout(root: &std::path::Path) -> Source {
    let origin = root.join("origin.git");
    let work = root.join("work");
    let checkout = root.join("checkout");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "--bare", "-q", "-b", "main"]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), work.to_str().unwrap()]);
    std::fs::create_dir_all(work.join("scripts")).unwrap();
    std::fs::write(work.join("scripts/amiro-server.sh"), "#!/bin/sh\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-q", "-m", "feat: the running version"]);
    git(&work, &["push", "-q", "origin", "HEAD:main"]);
    let old = git(&work, &["rev-parse", "HEAD"]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), checkout.to_str().unwrap()]);
    std::fs::write(work.join("NEW.md"), "new\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-q", "-m", "fix(chat): keep agent UI where the agent called it"]);
    git(&work, &["push", "-q", "origin", "HEAD:main"]);
    let new = git(&work, &["rev-parse", "HEAD"]);
    Source { checkout, old, new }
}

fn use_source(fx: &Fixture, source: &Source, running: &str, script_code: i32) {
    let script = updater_script(&fx.root.join("source-bin"), script_code);
    set_env(&[
        ("AMIRO_UPDATE_COMMAND", None),
        ("AMIRO_DESKTOP", None),
        ("AMIRO_SOURCE_DIR", Some(source.checkout.to_str().unwrap())),
        ("AMIRO_SOURCE_UPDATE_COMMAND", Some(script.to_str().unwrap())),
        ("AMIRO_RUNNING_COMMIT", Some(running)),
    ]);
}

#[tokio::test]
async fn a_source_checkout_follows_its_branch_on_origin() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let base = github_stub("v99.0.0").await;
    let source = source_checkout(&fx.root);
    use_source(&fx, &source, &source.old, 0);
    set_env(&[("AMIRO_UPDATE_API_BASE", Some(&base))]);

    let (status, body) = call(&fx.app, "GET", "/api/system/update?refresh=1", Some("tok"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["method"], "source");
    assert_eq!(body["canSelfUpdate"], true);
    assert_eq!(body["updateAvailable"], true);
    let found = &body["source"];
    assert_eq!(found["branch"], "main");
    assert_eq!(found["behind"], 1);
    assert_eq!(found["running"], &source.old[..7]);
    assert_eq!(found["latest"], &source.new[..7]);
    assert_eq!(found["dirty"], false);
    assert_eq!(found["commits"][0]["subject"], "fix(chat): keep agent UI where the agent called it");

    // Running the newest commit: nothing to do, and Update is refused.
    use_source(&fx, &source, &source.new, 0);
    let (_, body) = call(&fx.app, "GET", "/api/system/update?refresh=1", Some("tok"), None).await;
    assert_eq!(body["updateAvailable"], false);
    assert_eq!(body["source"]["behind"], 0);
    let (status, body) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.to_string().contains("already on the latest main"), "{body}");
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn a_source_update_runs_the_script_and_records_a_failed_build() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let source = source_checkout(&fx.root);
    use_source(&fx, &source, &source.old, 4);

    let (status, _) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({"version": "--upload-pack=x"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "only commit ids reach git");

    let (status, body) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["job"]["kind"], "source");
    assert_eq!(body["job"]["branch"], "main");
    assert_eq!(body["job"]["from"], &source.old[..7]);
    assert_eq!(body["job"]["target"], &source.new[..7]);

    let job = settled_job(&fx.app).await;
    assert_eq!(job["state"], "failed");
    let error = job["error"].as_str().unwrap();
    assert!(error.contains("exit code 4") && error.contains(&source.old[..7]), "{error}");
    assert!(job["log"].as_str().unwrap().contains(&format!("args: update {}", source.new)));
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn a_source_checkout_with_local_changes_is_not_updated() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let source = source_checkout(&fx.root);
    use_source(&fx, &source, &source.old, 0);
    std::fs::write(source.checkout.join("scripts/amiro-server.sh"), "#!/bin/sh\n# edited\n").unwrap();

    let (_, body) = call(&fx.app, "GET", "/api/system/update?refresh=1", Some("tok"), None).await;
    assert_eq!(body["source"]["dirty"], true);
    let (status, body) = call(&fx.app, "POST", "/api/system/update", Some("tok"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.to_string().contains("uncommitted changes"), "{body}");
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}

#[tokio::test]
async fn a_source_update_succeeds_when_the_server_restarts_on_the_new_commit() {
    let _lock = ENV_LOCK.lock().await;
    let fx = fixture();
    let source = source_checkout(&fx.root);
    let pending = json!({"state": "restarting", "kind": "source", "from": &source.old[..7], "target": &source.new[..7], "trigger": "manual"});

    std::fs::write(fx.state.home.join("store/update-state.json"), pending.to_string()).unwrap();
    use_source(&fx, &source, &source.old, 0);
    backend::updates::reconcile_on_start(&fx.state).await;
    let (_, body) = call(&fx.app, "GET", "/api/system/update/job", Some("tok"), None).await;
    assert_eq!(body["job"]["state"], "failed");
    assert!(body["job"]["error"].as_str().unwrap().contains(&format!("restarted on {} instead of {}", &source.old[..7], &source.new[..7])));

    std::fs::write(fx.state.home.join("store/update-state.json"), pending.to_string()).unwrap();
    use_source(&fx, &source, &source.new, 0);
    backend::updates::reconcile_on_start(&fx.state).await;
    let (_, body) = call(&fx.app, "GET", "/api/system/update/job", Some("tok"), None).await;
    assert_eq!(body["job"]["state"], "succeeded");
    clear_env();
    let _ = std::fs::remove_dir_all(&fx.root);
}
