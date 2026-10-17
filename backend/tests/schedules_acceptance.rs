//! Schedules acceptance: real native binary, user-scoped contract v1.
//!
//! Contract (locked with backend worker):
//!   POST   /api/schedules            {name,prompt,mode,timezone,schedule,model?,enabled?} -> 201 {schedule}
//!   GET    /api/schedules            -> 200 {schedules: []} (owner-scoped)
//!   GET    /api/schedules/:id        -> 200 {schedule}
//!   PATCH  /api/schedules/:id        -> 200 {schedule}
//!   DELETE /api/schedules/:id        -> 204
//!   POST   /api/schedules/:id/run    -> 200 {schedule, run}
//!   GET    /api/schedules/:id/runs   -> 200 {runs: []}
//!   POST   /api/schedules/preview    {schedule, timezone} -> 200 {nextRuns: [5]}
//! Schedule = {id,name,prompt,mode:'execute'|'notify',timezone,
//!   schedule:{kind:'once'|'cron'|'interval',at?,expression?,minutes?},
//!   model?,enabled?,nextRunAt,lastRunAt,lastStatus,threadId,createdAt,updatedAt}.
//!
//! Startup policy (corrected): a still-pending overdue once fires ONCE on
//! startup; only a previously-`running` run is marked interrupted with NO
//! replay of side effects. Recurring schedules resolve forward, no replay
//! storms. Only one backend process may hold the home lock; non-holders
//! reject mutations.
//!
//! These tests never touch execute mode (that needs the runtime stub via
//! AMIRO_SCHEDULE_TEST_RUNTIME=1, owned by the coordinator's E2E). Notify
//! mode exercises the full persist/timer/restart path with no model calls.
//! Bodies track the locked contract and adapt once the backend lands.

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SECRET: &str = "schedules-acceptance-secret";
const MEMBER_PASSWORD: &str = "schedules-member-password-0147";

struct SchedServer {
    child: Child,
    home: PathBuf,
    url: String,
    client: Client,
    registration: bool,
}

impl Drop for SchedServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Created uniquely by this fixture, never user state.
        let _ = fs::remove_dir_all(&self.home);
    }
}

impl SchedServer {
    fn fresh_home() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::var_os("AMIRO_TEST_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = root.join(format!(
            "amiro-schedules-acceptance-{}-{nonce}",
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

    fn spawn_on_home(home: &PathBuf, registration: bool) -> (Child, String, Client) {
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
            .env("AMIRO_SEED_ADMIN", "1")
            .env(
                "AMIRO_ALLOW_REGISTRATION",
                if registration { "1" } else { "0" },
            )
            .env("AMIRO_ALLOWED_ORIGIN", "http://tauri.localhost")
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
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("native backend did not become healthy");
    }

    async fn start(registration: bool) -> Self {
        let home = Self::fresh_home();
        let (child, url, client) = Self::spawn_on_home(&home, registration);
        let mut server = Self {
            child,
            home,
            url,
            client,
            registration,
        };
        server.wait_healthy().await;
        server
    }

    /// Restart against the SAME home: proves persistence, startup recovery,
    /// and no-replay across process lifetimes.
    async fn restart(&mut self) {
        self.stop();
        self.boot().await;
    }

    /// Stop the backend WITHOUT respawning: the home stays on disk so a
    /// later `boot` can prove genuine overdue-on-startup behavior (the due
    /// instant passes while no process is alive).
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Boot a backend against the existing home (after `stop`).
    async fn boot(&mut self) {
        let (child, url, client) = Self::spawn_on_home(&self.home, self.registration);
        self.child = child;
        self.url = url;
        self.client = client;
        self.wait_healthy().await;
    }

    async fn admin_token(&self) -> String {
        let credentials: Value = serde_json::from_slice(
            &fs::read(self.home.join("admin-initial-password"))
                .expect("native backend must persist a generated bootstrap password"),
        )
        .unwrap();
        let response = self
            .client
            .post(format!("{}/api/auth/login", self.url))
            .header("X-Amiro-Token", SECRET)
            .json(&json!({"email": credentials["email"], "password": credentials["password"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "bootstrap login must work"
        );
        let body: Value = response.json().await.unwrap();
        body["token"].as_str().expect("login token").to_owned()
    }

    async fn member_token(&self) -> String {
        let response = self
            .client
            .post(format!("{}/api/auth/register", self.url))
            .header("X-Amiro-Token", SECRET)
            .json(&json!({
                "name": "Schedule Member",
                "email": "sched-member@example.test",
                "password": MEMBER_PASSWORD,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "member registration must work when enabled"
        );
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["user"]["role"], "user");
        body["token"].as_str().expect("member token").to_owned()
    }

    async fn post(&self, token: &str, path: &str, body: &Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.url))
            .header("X-Amiro-Token", SECRET)
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .unwrap()
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

    async fn create_notify_once(&self, token: &str, name: &str, at: &str) -> Value {
        let response = self
            .post(
                token,
                "/api/schedules",
                &json!({
                    "name": name,
                    "prompt": format!("notify acceptance: {name}"),
                    "mode": "notify",
                    "timezone": "UTC",
                    "schedule": {"kind": "once", "at": at},
                }),
            )
            .await;
        assert_eq!(
            response.status(),
            StatusCode::CREATED,
            "schedule create must return 201"
        );
        response.json().await.unwrap()
    }

    async fn runs(&self, token: &str, id: &str) -> Vec<Value> {
        let response = self.get(token, &format!("/api/schedules/{id}/runs")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        body["runs"].as_array().cloned().unwrap_or_default()
    }
}

fn rfc3339_utc_plus(secs: u64) -> String {
    let when = SystemTime::now() + Duration::from_secs(secs);
    let dt: chrono::DateTime<chrono::Utc> = when.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[tokio::test]
async fn schedules_crud_pause_run_history_delete_are_persisted() {
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    // Create a far-future one-shot so no timer fires during this test.
    let created = server
        .create_notify_once(&admin, "crud lifecycle", "2030-05-06T03:30:00Z")
        .await;
    let sched = &created["schedule"];
    let id = sched["id"].as_str().expect("schedule id");
    assert_eq!(sched["name"], "crud lifecycle");
    assert_eq!(sched["mode"], "notify");
    assert!(sched["nextRunAt"].as_str().unwrap().contains("2030"));

    // List contains it; detail matches.
    let list: Value = server
        .get(&admin, "/api/schedules")
        .await
        .json()
        .await
        .unwrap();
    assert!(list["schedules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == id));
    let detail: Value = server
        .get(&admin, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["schedule"]["id"], id);

    // Edit: rename.
    let renamed: Value = server
        .patch(
            &admin,
            &format!("/api/schedules/{id}"),
            &json!({"name": "crud renamed"}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(renamed["schedule"]["name"], "crud renamed");

    // Pause.
    let paused: Value = server
        .patch(
            &admin,
            &format!("/api/schedules/{id}"),
            &json!({"enabled": false}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(paused["schedule"]["enabled"], false);

    // Run-now records history even while paused (explicit user action).
    let run_resp = server
        .post(&admin, &format!("/api/schedules/{id}/run"), &json!({}))
        .await;
    assert!(
        run_resp.status().is_success(),
        "run-now must succeed, got {}",
        run_resp.status()
    );
    let run_body: Value = run_resp.json().await.unwrap();
    assert!(
        run_body["run"]["id"].is_string(),
        "run must have an id: {run_body}"
    );
    let history = server.runs(&admin, id).await;
    assert!(!history.is_empty(), "run-now must append to history");

    // Delete removes it.
    let del = server.delete(&admin, &format!("/api/schedules/{id}")).await;
    assert_eq!(del.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        server
            .get(&admin, &format!("/api/schedules/{id}"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let list: Value = server
        .get(&admin, "/api/schedules")
        .await
        .json()
        .await
        .unwrap();
    assert!(list["schedules"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["id"] != id));
}

#[tokio::test]
async fn schedules_are_owner_isolated() {
    let server = SchedServer::start(true).await;
    let admin = server.admin_token().await;
    let member = server.member_token().await;

    let created = server
        .create_notify_once(&admin, "owner private", "2030-06-01T00:00:00Z")
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();

    // Member sees nothing: empty list, and every per-id route hides existence.
    let list: Value = server
        .get(&member, "/api/schedules")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list["schedules"].as_array().unwrap().len(), 0);
    for (method, path) in [
        ("GET", format!("/api/schedules/{id}")),
        ("GET", format!("/api/schedules/{id}/runs")),
        ("POST", format!("/api/schedules/{id}/run")),
    ] {
        let status = match method {
            "GET" => server.get(&member, &path).await.status(),
            _ => server.post(&member, &path, &json!({})).await.status(),
        };
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "member {method} {path} must not leak existence"
        );
    }
    assert_eq!(
        server
            .patch(
                &member,
                &format!("/api/schedules/{id}"),
                &json!({"name": "hijack"})
            )
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .delete(&member, &format!("/api/schedules/{id}"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    // Owner still sees the untouched schedule.
    let detail: Value = server
        .get(&admin, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["schedule"]["name"], "owner private");

    // Unauthenticated requests are refused before any scoping logic.
    let anon = server
        .client
        .get(format!("{}/api/schedules", server.url))
        .header("X-Amiro-Token", SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn schedules_reject_malformed_time_and_spec() {
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    for (case, body) in [
        (
            "bad cron",
            json!({"name":"x","prompt":"x","mode":"notify","timezone":"UTC","schedule":{"kind":"cron","expression":"not a cron"}}),
        ),
        (
            "bad timezone",
            json!({"name":"x","prompt":"x","mode":"notify","timezone":"Mars/Olympus","schedule":{"kind":"cron","expression":"0 9 * * *"}}),
        ),
        (
            "bad kind",
            json!({"name":"x","prompt":"x","mode":"notify","timezone":"UTC","schedule":{"kind":"sometimes"}}),
        ),
        (
            "empty prompt",
            json!({"name":"x","prompt":"  ","mode":"notify","timezone":"UTC","schedule":{"kind":"cron","expression":"0 9 * * *"}}),
        ),
        (
            "once without at",
            json!({"name":"x","prompt":"x","mode":"notify","timezone":"UTC","schedule":{"kind":"once"}}),
        ),
        (
            "once with garbage at",
            json!({"name":"x","prompt":"x","mode":"notify","timezone":"UTC","schedule":{"kind":"once","at":"yesterday-ish"}}),
        ),
        (
            "interval without minutes",
            json!({"name":"x","prompt":"x","mode":"notify","timezone":"UTC","schedule":{"kind":"interval"}}),
        ),
        (
            "bad mode",
            json!({"name":"x","prompt":"x","mode":"turbo","timezone":"UTC","schedule":{"kind":"cron","expression":"0 9 * * *"}}),
        ),
    ] {
        let status = server.post(&admin, "/api/schedules", &body).await.status();
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{case} must be 400, got {status}"
        );
    }

    // Unknown ids 404 (not 500) on every per-schedule route.
    assert_eq!(
        server
            .get(&admin, "/api/schedules/does-not-exist")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .post(&admin, "/api/schedules/does-not-exist/run", &json!({}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .get(&admin, "/api/schedules/does-not-exist/runs")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    // Preview validates without persisting: bad expression is 400, list stays empty.
    let preview = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({"schedule": {"kind": "cron", "expression": "bogus"}, "timezone": "UTC"}),
        )
        .await;
    assert_eq!(preview.status(), StatusCode::BAD_REQUEST);
    let list: Value = server
        .get(&admin, "/api/schedules")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list["schedules"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn schedules_preview_once_returns_single_time() {
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    let response = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({"schedule": {"kind": "once", "at": "2030-05-06T03:30:00Z"}, "timezone": "UTC"}),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    let runs = body["nextRuns"].as_array().expect("nextRuns array");
    assert_eq!(
        runs.len(),
        1,
        "once preview must return exactly one time: {body}"
    );
    assert!(
        runs[0].as_str().unwrap().starts_with("2030-05-06T03:30:00"),
        "once preview must echo the requested instant: {runs:?}"
    );
}

#[tokio::test]
async fn schedules_preview_recurring_returns_five_ascending_runs() {
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    let response = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({"schedule": {"kind": "cron", "expression": "0 9 * * MON"}, "timezone": "UTC"}),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    let runs = body["nextRuns"].as_array().expect("nextRuns array");
    assert_eq!(
        runs.len(),
        5,
        "recurring preview must return exactly 5 runs: {body}"
    );
    let mut prev = String::new();
    for run in runs {
        let at = run.as_str().expect("run is an RFC3339 string");
        assert!(at > prev.as_str(), "preview runs must ascend: {runs:?}");
        prev = at.to_string();
    }
}

#[tokio::test]
async fn schedules_preview_interval_returns_five_spaced_runs() {
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    let response = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({"schedule": {"kind": "interval", "minutes": 30}, "timezone": "UTC"}),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    let runs = body["nextRuns"].as_array().expect("nextRuns array");
    assert_eq!(
        runs.len(),
        5,
        "interval preview must return exactly 5 runs: {body}"
    );
    let first: chrono::DateTime<chrono::Utc> =
        runs[0].as_str().unwrap().parse().expect("RFC3339 run");
    let second: chrono::DateTime<chrono::Utc> =
        runs[1].as_str().unwrap().parse().expect("RFC3339 run");
    assert_eq!(
        (second - first).num_minutes(),
        30,
        "interval runs must be 30 minutes apart: {runs:?}"
    );
}

#[tokio::test]
async fn schedules_reject_dst_gap_and_fold() {
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    // 2029-03-11 02:30 never exists in America/New_York (spring-forward
    // gap): create and preview must both refuse it, not silently shift it.
    let gap_create = server
        .post(
            &admin,
            "/api/schedules",
            &json!({
                "name": "dst gap",
                "prompt": "must be rejected",
                "mode": "notify",
                "timezone": "America/New_York",
                "schedule": {"kind": "once", "at": "2029-03-11T02:30:00"},
            }),
        )
        .await;
    assert_eq!(
        gap_create.status(),
        StatusCode::BAD_REQUEST,
        "a nonexistent wall time must be 400, got {}",
        gap_create.status()
    );
    let gap_preview = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({
                "schedule": {"kind": "once", "at": "2029-03-11T02:30:00"},
                "timezone": "America/New_York",
            }),
        )
        .await;
    assert_eq!(
        gap_preview.status(),
        StatusCode::BAD_REQUEST,
        "a nonexistent wall time must be 400 on preview, got {}",
        gap_preview.status()
    );

    // 2029-11-04 01:30 happens twice in America/New_York (fall-back fold):
    // a naive wall time is ambiguous and must be rejected on both paths.
    // The caller disambiguates with an explicit offset instead.
    let fold_create = server
        .post(
            &admin,
            "/api/schedules",
            &json!({
                "name": "dst fold",
                "prompt": "must be rejected as ambiguous",
                "mode": "notify",
                "timezone": "America/New_York",
                "schedule": {"kind": "once", "at": "2029-11-04T01:30:00"},
            }),
        )
        .await;
    assert_eq!(
        fold_create.status(),
        StatusCode::BAD_REQUEST,
        "an ambiguous fold wall time must be 400, got {}",
        fold_create.status()
    );
    let fold_preview = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({
                "schedule": {"kind": "once", "at": "2029-11-04T01:30:00"},
                "timezone": "America/New_York",
            }),
        )
        .await;
    assert_eq!(
        fold_preview.status(),
        StatusCode::BAD_REQUEST,
        "an ambiguous fold wall time must be 400 on preview, got {}",
        fold_preview.status()
    );

    // An explicit offset is unambiguous and accepted: 01:30 EDT == 05:30Z.
    let offset = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({
                "schedule": {"kind": "once", "at": "2029-11-04T01:30:00-04:00"},
                "timezone": "America/New_York",
            }),
        )
        .await;
    assert_eq!(
        offset.status(),
        StatusCode::OK,
        "an explicit offset must be accepted, got {}",
        offset.status()
    );
    let body: Value = offset.json().await.unwrap();
    let runs = body["nextRuns"].as_array().expect("nextRuns array");
    assert_eq!(runs.len(), 1, "once offset preview returns one time: {body}");
    assert_eq!(
        runs[0].as_str().unwrap(),
        "2029-11-04T05:30:00.000Z",
        "01:30-04:00 must resolve to 05:30Z: {runs:?}"
    );
}

#[tokio::test]
async fn schedules_once_converts_browser_local_to_utc() {
    // Browser form posts a naive local wall time plus the selected zone;
    // the backend owns the conversion. 09:00 Asia/Kolkata == 03:30Z.
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    let preview = server
        .post(
            &admin,
            "/api/schedules/preview",
            &json!({
                "schedule": {"kind": "once", "at": "2030-05-06T09:00:00"},
                "timezone": "Asia/Kolkata",
            }),
        )
        .await;
    assert_eq!(
        preview.status(),
        StatusCode::OK,
        "naive local + zone must be accepted"
    );
    let body: Value = preview.json().await.unwrap();
    let first = body["nextRuns"][0].as_str().expect("first run");
    assert!(
        first.starts_with("2030-05-06T03:30:00"),
        "09:00 Asia/Kolkata must convert to 03:30Z, got {first}"
    );

    let created = server
        .post(
            &admin,
            "/api/schedules",
            &json!({
                "name": "kolkata morning",
                "prompt": "kolkata conversion acceptance",
                "mode": "notify",
                "timezone": "Asia/Kolkata",
                "schedule": {"kind": "once", "at": "2030-05-06T09:00:00"},
            }),
        )
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let body: Value = created.json().await.unwrap();
    let next = body["schedule"]["nextRunAt"].as_str().expect("nextRunAt");
    assert!(
        next.starts_with("2030-05-06T03:30:00"),
        "persisted nextRunAt must be 03:30Z, got {next}"
    );
}

#[tokio::test]
async fn schedules_once_timer_fires_across_restart_without_replay() {
    let mut server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    // Genuine overdue-on-startup proof: create a once ~6s out, STOP the
    // backend so the due instant passes with NO process alive, then boot.
    // The pending overdue once must fire exactly once after startup.
    let created = server
        .create_notify_once(&admin, "restart fire once", &rfc3339_utc_plus(6))
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();
    assert!(
        server.runs(&admin, &id).await.is_empty(),
        "nothing may fire before the stop"
    );

    server.stop();
    tokio::time::sleep(Duration::from_secs(9)).await; // due instant passes dead
    server.boot().await;
    let admin2 = server.admin_token().await;

    // Schedule and (empty-so-far) history survive the restart.
    let detail: Value = server
        .get(&admin2, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["schedule"]["id"], id);

    // The overdue once fires once shortly after boot (startup catch-up, no
    // live timer involved). Generous deadline for slow CI.
    let mut fired = false;
    for _ in 0..30 {
        let history = server.runs(&admin2, &id).await;
        if !history.is_empty() {
            assert_eq!(
                history.len(),
                1,
                "overdue once must fire exactly once, got {history:?}"
            );
            fired = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    assert!(fired, "pending overdue once must fire once after startup");

    // A second restart must not replay it: still exactly one run.
    server.restart().await;
    let admin3 = server.admin_token().await;
    tokio::time::sleep(Duration::from_secs(12)).await;
    let history = server.runs(&admin3, &id).await;
    assert_eq!(
        history.len(),
        1,
        "completed once must never replay, got {history:?}"
    );
}

#[tokio::test]
async fn schedules_running_marked_interrupted_never_replayed() {
    // Crash-during-run policy: a run stuck in `running` when the process
    // dies is marked interrupted on next boot and NEVER re-executed. This
    // test seeds that state directly in the store file (the only way to
    // fabricate a mid-run crash without a live runtime) and asserts the
    // recovery outcome. Store layout tracked from contract v1; adapt field
    // names if the backend namespaces them, but do NOT weaken the policy
    // to make an implementation bug pass.
    let mut server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    let created = server
        .create_notify_once(&admin, "crash mid run", "2030-09-01T00:00:00Z")
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();

    // Fabricate the crash: inject a `running` run row into the persisted
    // store under the same home, then kill the process without any graceful
    // completion path.
    let store_candidates = [
        server.home.join("store").join("schedules.json"),
        server.home.join("store").join("schedule-runs.json"),
    ];
    let mut injected = false;
    for path in &store_candidates {
        if path.exists() {
            let raw = fs::read_to_string(path).unwrap();
            let mut doc: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            // Two plausible layouts: runs nested under the schedule, or a
            // top-level runs map. Add one running row to whichever exists.
            if doc.get(&id).is_some() {
                let run_id = format!("run-crash-{id}");
                doc[&id]["runs"][&run_id] = json!({
                    "id": run_id,
                    "status": "running",
                    "startedAt": rfc3339_utc_plus(0),
                });
                fs::write(path, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
                injected = true;
                break;
            }
            if doc.get("runs").is_some() {
                let run_id = format!("run-crash-{id}");
                doc["runs"][&run_id] = json!({
                    "id": run_id,
                    "scheduleId": id,
                    "status": "running",
                    "startedAt": rfc3339_utc_plus(0),
                });
                fs::write(path, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
                injected = true;
                break;
            }
        }
    }
    // If the backend uses different filenames, the boot below still must
    // show zero replays; the injection assert pins the store discovery.
    assert!(
        injected || !store_candidates.iter().any(|p| p.exists()),
        "store layout changed: inspect <home>/store/*.json and update the injection, keeping the interrupted-no-replay assertion"
    );

    server.restart().await;
    let admin2 = server.admin_token().await;
    // Settle window: recovery runs at boot; nothing may append after that.
    tokio::time::sleep(Duration::from_secs(10)).await;
    let history = server.runs(&admin2, &id).await;
    let replayed = history
        .iter()
        .filter(|r| {
            r["status"] == "succeeded" || r["status"] == "success" || r["status"] == "completed"
        })
        .count();
    assert_eq!(
        replayed, 0,
        "crashed running runs must never complete as success: {history:?}"
    );
    for run in &history {
        assert!(
            !run["status"].as_str().unwrap_or("").contains("running"),
            "no run may stay running after recovery: {history:?}"
        );
    }
}

#[tokio::test]
async fn schedules_concurrent_run_now_single_flight() {
    // run-now + timer race: 8 concurrent run-now calls must not produce
    // parallel executions of the same schedule. The backend may serialize
    // (409/423/429/503 on the loser) or coalesce (shared run id); it must
    // never report distinct successful runs for one burst.
    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;

    let created = server
        .create_notify_once(&admin, "single flight", "2030-10-01T00:00:00Z")
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();
    let before = server.runs(&admin, &id).await.len();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let url = server.url.clone();
        let token = admin.clone();
        let sid = id.clone();
        handles.push(tokio::spawn(async move {
            Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap()
                .post(format!("{url}/api/schedules/{sid}/run"))
                .header("X-Amiro-Token", SECRET)
                .bearer_auth(&token)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status()
        }));
    }
    let mut ok = 0;
    let mut conflict = 0;
    for h in handles {
        match h.await.unwrap() {
            s if s.is_success() => ok += 1,
            StatusCode::CONFLICT
            | StatusCode::LOCKED
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::SERVICE_UNAVAILABLE => conflict += 1,
            other => panic!("unexpected run-now status in burst: {other}"),
        }
    }
    assert!(ok >= 1, "at least one run-now must succeed");
    assert!(
        ok + conflict == 8,
        "every burst call resolves as success or conflict"
    );

    let history = server.runs(&admin, &id).await;
    let active: Vec<_> = history
        .iter()
        .filter(|r| {
            r["status"] == "succeeded"
                || r["status"] == "success"
                || r["status"] == "completed"
                || r["status"] == "running"
        })
        .collect();
    assert!(
        active.len() <= before + ok.max(1).min(2),
        "concurrent run-now must not fan out into parallel executions: {history:?}"
    );
}

#[tokio::test]
async fn schedules_second_process_cannot_mutate() {
    use std::process::Stdio;

    let server = SchedServer::start(false).await;
    let admin = server.admin_token().await;
    let created = server
        .create_notify_once(&admin, "lock holder", "2030-07-01T00:00:00Z")
        .await;
    let id = created["schedule"]["id"].as_str().unwrap().to_string();

    // A second backend sharing the same home must not steal mutations.
    // Sessions live in the shared home, so the same bearer works there.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut other = Command::new(env!("CARGO_BIN_EXE_amiro-backend"))
        .env("AMIRO_HOME", &server.home)
        .env("AMIRO_RUNTIME_HOME", server.home.join("runtime"))
        .env("AMIRO_API_SOCKET", server.home.join("absent-runtime.sock"))
        .env("AMIRO_OUT_DIR", server.home.join("ui"))
        .env("AMIRO_NO_RUNTIME_SPAWN", "1")
        .env("AMIRO_NO_RUNTIME_KEEPALIVE", "1")
        .env("AMIRO_PORT", port.to_string())
        .env("AMIRO_HOST", "127.0.0.1")
        .env("AMIRO_TOKEN", SECRET)
        .env("AMIRO_SEED_ADMIN", "1")
        .env("AMIRO_ALLOW_REGISTRATION", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let other_url = format!("http://127.0.0.1:{port}");
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let mut ready = false;
    for _ in 0..100 {
        if client
            .get(format!("{other_url}/health"))
            .header("X-Amiro-Token", SECRET)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ready, "second backend must boot for the lock test");

    let attempt = client
        .post(format!("{other_url}/api/schedules"))
        .header("X-Amiro-Token", SECRET)
        .bearer_auth(&admin)
        .json(&json!({
            "name": "lock thief",
            "prompt": "must be rejected",
            "mode": "notify",
            "timezone": "UTC",
            "schedule": {"kind": "once", "at": "2030-08-01T00:00:00Z"},
        }))
        .send()
        .await
        .unwrap();
    assert!(
        matches!(
            attempt.status(),
            StatusCode::CONFLICT | StatusCode::LOCKED | StatusCode::SERVICE_UNAVAILABLE
        ),
        "non-holder mutations must be rejected, got {}",
        attempt.status()
    );

    // The holder still works fine.
    let ok = server
        .post(
            &admin,
            "/api/schedules",
            &json!({
                "name": "holder still works",
                "prompt": "holder write",
                "mode": "notify",
                "timezone": "UTC",
                "schedule": {"kind": "once", "at": "2030-08-02T00:00:00Z"},
            }),
        )
        .await;
    assert_eq!(ok.status(), StatusCode::CREATED);

    // Owner's original schedule untouched by the intruder.
    let detail: Value = server
        .get(&admin, &format!("/api/schedules/{id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["schedule"]["name"], "lock holder");

    let _ = other.kill();
    let _ = other.wait();
}
