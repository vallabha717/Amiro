//! Focused scheduler durability regressions (claim/roll-forward/recovery).
//!
//! These complement `schedules_acceptance.rs` (which owns the broad contract)
//! and pin the specific crash/partial-write invariants that the durability
//! review called out:
//!
//! 1. Run now works on a PAUSED schedule (contract: explicit action), actually
//!    executes instead of returning a "skipped" placeholder, and a one-shot is
//!    consumed by that manual claim so it never fires again (no replay).
//! 2. Startup recovery PRESERVES a still-future interval `nextRunAt` instead of
//!    shifting every recurring schedule forward on every boot.
//! 3. A one-shot with a terminal run row plus a still-due `nextRunAt` (the
//!    crash-between-the-two-claim-writes shape) is never replayed.
//! 4. Delete is refused with 409 while a run row is `running`, and deleting a
//!    schedule keeps its run history on disk instead of silently wiping it.
//!
//! Only notify mode and far-future timers are used, so no model/runtime is
//! required and the tests never race the execution path.

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SECRET: &str = "schedules-durability-secret";
const OWNER_EMAIL: &str = "owner@amiro.test";
const OWNER_PASSWORD: &str = "durability-owner-password-1";

struct DurabilityServer {
    child: Child,
    home: PathBuf,
    url: String,
    client: Client,
}

impl Drop for DurabilityServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

impl DurabilityServer {
    fn fresh_home() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::var_os("AMIRO_TEST_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = root.join(format!(
            "amiro-schedules-durability-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(home.join("runtime")).unwrap();
        let ui = home.join("ui");
        fs::create_dir_all(&ui).unwrap();
        fs::write(
            ui.join("index.html"),
            "<html><head><title>Amiro</title></head><body>amiro-shell</body></html>",
        )
        .unwrap();
        home
    }

    fn spawn_on(home: &Path) -> (Child, String, Client) {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let child = Command::new(env!("CARGO_BIN_EXE_amiro-backend"))
            .env("AMIRO_HOME", home)
            .env("AMIRO_RUNTIME_HOME", home.join("runtime"))
            .env("AMIRO_API_SOCKET", home.join("absent-runtime.sock"))
            .env("AMIRO_OUT_DIR", home.join("ui"))
            .env("AMIRO_NO_RUNTIME_SPAWN", "1")
            .env("AMIRO_NO_RUNTIME_KEEPALIVE", "1")
            .env("AMIRO_PORT", port.to_string())
            .env("AMIRO_HOST", "127.0.0.1")
            .env("AMIRO_TOKEN", SECRET)
            .env("AMIRO_OWNER_EMAIL", OWNER_EMAIL)
            .env("AMIRO_OWNER_PASSWORD", OWNER_PASSWORD)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        (child, format!("http://127.0.0.1:{port}"), client)
    }

    async fn start() -> Self {
        let home = Self::fresh_home();
        let (child, url, client) = Self::spawn_on(&home);
        let mut server = Self {
            child,
            home,
            url,
            client,
        };
        server.wait_healthy().await;
        server
    }

    async fn wait_healthy(&mut self) {
        for _ in 0..100 {
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("native backend exited before readiness: {status}");
            }
            if self
                .client
                .get(format!("{}/health", self.url))
                .header("X-Amiro-Token", SECRET)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                // The ticker is spawned right after bind and only becomes
                // ready after recovery; give that lease a moment so the first
                // mutation is not rejected as "scheduler is starting".
                tokio::time::sleep(Duration::from_millis(300)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("native backend did not become healthy");
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    async fn restart(&mut self) {
        self.stop();
        let (child, url, client) = Self::spawn_on(&self.home);
        self.child = child;
        self.url = url;
        self.client = client;
        self.wait_healthy().await;
    }

    async fn admin_token(&self) -> String {
        let response = self
            .client
            .post(format!("{}/api/auth/login", self.url))
            .header("X-Amiro-Token", SECRET)
            .json(&json!({"email": OWNER_EMAIL, "password": OWNER_PASSWORD}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        body["token"].as_str().expect("login token").to_owned()
    }

    async fn get(&self, token: &str, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.url))
            .header("X-Amiro-Token", SECRET)
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }

    async fn post(&self, token: &str, path: &str) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.url))
            .header("X-Amiro-Token", SECRET)
            .bearer_auth(token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
    }

    async fn patch(&self, token: &str, path: &str, body: &Value) -> reqwest::Response {
        self.client
            .patch(format!("{}{path}", self.url))
            .header("X-Amiro-Token", SECRET)
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .unwrap()
    }

    async fn delete(&self, token: &str, path: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.url))
            .header("X-Amiro-Token", SECRET)
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }

    async fn create_notify(
        &self,
        token: &str,
        name: &str,
        schedule: Value,
    ) -> Value {
        let response = self
            .client
            .post(format!("{}/api/schedules", self.url))
            .header("X-Amiro-Token", SECRET)
            .bearer_auth(token)
            .json(&json!({
                "name": name,
                "prompt": format!("durability: {name}"),
                "mode": "notify",
                "timezone": "UTC",
                "schedule": schedule,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        response.json().await.unwrap()
    }

    async fn runs(&self, token: &str, id: &str) -> Vec<Value> {
        let response = self.get(token, &format!("/api/schedules/{id}/runs")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        body["runs"].as_array().cloned().unwrap_or_default()
    }

    fn store_path(&self, name: &str) -> PathBuf {
        self.home.join("store").join(name)
    }

    fn read_store(&self, name: &str) -> Value {
        let raw = fs::read_to_string(self.store_path(name)).unwrap_or_else(|_| "{}".into());
        serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
    }

    fn write_store(&self, name: &str, doc: &Value) {
        fs::create_dir_all(self.store_path(name).parent().unwrap()).unwrap();
        fs::write(
            self.store_path(name),
            serde_json::to_vec_pretty(doc).unwrap(),
        )
        .unwrap();
    }
}

fn rfc3339_utc_plus(secs: i64) -> String {
    let now = SystemTime::now();
    let when = if secs >= 0 {
        now + Duration::from_secs(secs as u64)
    } else {
        now - Duration::from_secs((-secs) as u64)
    };
    let dt: chrono::DateTime<chrono::Utc> = when.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Run now is an explicit action: it must execute (not "skip") on a paused
/// schedule, append history, and consume a one-shot so the timer can never
/// replay it later.
#[tokio::test]
async fn paused_run_now_executes_and_consumes_a_one_shot() {
    let mut server = DurabilityServer::start().await;
    let admin = server.admin_token().await;

    let created = server
        .create_notify(
            &admin,
            "paused manual run",
            json!({"kind": "once", "at": rfc3339_utc_plus(9)}),
        )
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();

    let paused = server
        .patch(
            &admin,
            &format!("/api/schedules/{id}"),
            &json!({"enabled": false}),
        )
        .await;
    assert_eq!(paused.status(), StatusCode::OK);

    let run = server
        .post(&admin, &format!("/api/schedules/{id}/run"))
        .await;
    assert_eq!(
        run.status(),
        StatusCode::OK,
        "run now must work while paused"
    );
    let body: Value = run.json().await.unwrap();
    assert_ne!(
        body["run"]["status"],
        "skipped",
        "a manual run must execute, not be skipped by the paused snapshot: {body}"
    );
    assert_eq!(body["run"]["status"], "ok", "notify must execute: {body}");

    let history = server.runs(&admin, &id).await;
    assert_eq!(history.len(), 1, "manual run must append history: {history:?}");

    // The manual claim dropped the one-shot fire marker while leaving the
    // owner's pause untouched.
    let detail: Value = server
        .get(&admin, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["schedule"]["enabled"], false);
    assert!(
        detail["schedule"].get("nextRunAt").is_none(),
        "a manual one-shot run must consume nextRunAt: {detail}"
    );

    // Past the original due instant and across a restart: still exactly one
    // run. No timer fire, no replay.
    server.restart().await;
    let admin2 = server.admin_token().await;
    tokio::time::sleep(Duration::from_secs(12)).await;
    let history = server.runs(&admin2, &id).await;
    assert_eq!(
        history.len(),
        1,
        "a manually claimed one-shot must never fire or replay: {history:?}"
    );
}

/// Recovery must not retime a healthy recurring schedule whose next firing is
/// still in the future; a boot is not a fire.
#[tokio::test]
async fn recovery_preserves_a_future_interval_next_run() {
    let mut server = DurabilityServer::start().await;
    let admin = server.admin_token().await;

    let created = server
        .create_notify(&admin, "future interval", json!({"kind": "interval", "minutes": 60}))
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();
    let before = created["schedule"]["nextRunAt"]
        .as_str()
        .expect("interval must have a nextRunAt")
        .to_string();

    server.restart().await;
    let admin2 = server.admin_token().await;
    let detail: Value = server
        .get(&admin2, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        detail["schedule"]["nextRunAt"].as_str(),
        Some(before.as_str()),
        "startup recovery must preserve a future interval time: {detail}"
    );
}

/// The crash-between-the-two-claim-writes shape: a durable terminal run row
/// plus a still-due nextRunAt. Recovery must clear the marker so the one-shot
/// is never fired a second time.
#[tokio::test]
async fn terminal_run_blocks_one_shot_replay_after_partial_write() {
    let mut server = DurabilityServer::start().await;
    let admin = server.admin_token().await;

    let created = server
        .create_notify(
            &admin,
            "partial claim",
            json!({"kind": "once", "at": rfc3339_utc_plus(3600)}),
        )
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();
    server.stop();

    // Simulate the crash window: the run row is durable and already closed,
    // while the schedule still shows the original due instant.
    let mut schedules = server.read_store("schedules.json");
    assert!(schedules.get(&id).is_some(), "schedule must be persisted");
    schedules[id.as_str()]["nextRunAt"] = json!(rfc3339_utc_plus(-60));
    schedules[id.as_str()]["enabled"] = json!(true);
    server.write_store("schedules.json", &schedules);

    let mut runs = server.read_store("schedule-runs.json");
    let run_id = format!("run-terminal-{id}");
    runs[run_id.as_str()] = json!({
        "id": run_id,
        "scheduleId": id,
        "userId": schedules[id.as_str()]["userId"].clone(),
        "scheduledAt": rfc3339_utc_plus(-60),
        "startedAt": rfc3339_utc_plus(-60),
        "finishedAt": rfc3339_utc_plus(-59),
        "status": "ok",
    });
    server.write_store("schedule-runs.json", &runs);

    let (child, url, client) = DurabilityServer::spawn_on(&server.home);
    server.child = child;
    server.url = url;
    server.client = client;
    server.wait_healthy().await;
    let admin2 = server.admin_token().await;

    // The ticker runs immediately after recovery, so a couple of seconds is
    // enough to prove nothing fired.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let history = server.runs(&admin2, &id).await;
    assert_eq!(
        history.len(),
        1,
        "a claimed one-shot must not replay after a partial write: {history:?}"
    );
    assert_eq!(history[0]["status"], "ok");
    let detail: Value = server
        .get(&admin2, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert!(
        detail["schedule"].get("nextRunAt").is_none(),
        "recovery must clear the consumed fire marker: {detail}"
    );
}

/// Deleting while a run row is still `running` is refused (409) so no
/// background execute is orphaned; once idle, delete succeeds and keeps the
/// run history on disk.
#[tokio::test]
async fn delete_rejects_inflight_and_keeps_run_history() {
    let server = DurabilityServer::start().await;
    let admin = server.admin_token().await;

    let created = server
        .create_notify(
            &admin,
            "delete durability",
            json!({"kind": "once", "at": rfc3339_utc_plus(3600)}),
        )
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();
    let run = server
        .post(&admin, &format!("/api/schedules/{id}/run"))
        .await;
    assert_eq!(run.status(), StatusCode::OK);

    // Fabricate an in-flight claim (what a background execute looks like).
    let mut runs = server.read_store("schedule-runs.json");
    let live_id = format!("run-live-{id}");
    runs[live_id.as_str()] = json!({
        "id": live_id,
        "scheduleId": id,
        "userId": created["schedule"]["userId"].clone(),
        "scheduledAt": rfc3339_utc_plus(0),
        "startedAt": rfc3339_utc_plus(0),
        "status": "running",
    });
    server.write_store("schedule-runs.json", &runs);

    let denied = server
        .delete(&admin, &format!("/api/schedules/{id}"))
        .await;
    assert_eq!(
        denied.status(),
        StatusCode::CONFLICT,
        "delete must be refused while a run is in flight"
    );
    assert_eq!(
        server
            .get(&admin, &format!("/api/schedules/{id}"))
            .await
            .status(),
        StatusCode::OK,
        "a refused delete must not remove the schedule"
    );

    // Clear the fabricated claim, then delete for real.
    runs.as_object_mut().unwrap().remove(&live_id);
    server.write_store("schedule-runs.json", &runs);
    let deleted = server
        .delete(&admin, &format!("/api/schedules/{id}"))
        .await;
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

    let schedules = server.read_store("schedules.json");
    assert!(
        schedules.get(&id).is_none(),
        "delete must remove the schedule row"
    );
    let runs = server.read_store("schedule-runs.json");
    let kept = runs
        .as_object()
        .map(|map| {
            map.values()
                .filter(|r| r.get("scheduleId").and_then(|v| v.as_str()) == Some(&id))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(
        kept, 1,
        "delete must keep the run history instead of silently wiping it: {runs}"
    );
}
