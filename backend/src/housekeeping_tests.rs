use super::*;
use std::sync::Arc;

fn temp_state() -> (AppState, PathBuf) {
    let root = std::env::temp_dir().join(format!("amiro-housekeeping-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = home.join("workspace");
    let runtime_home = root.join("runtime");
    for dir in [&home.join("store"), &workspace, &runtime_home] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let state = AppState {
        home,
        runtime_home,
        runtime_socket: root.join("runtime.sock"),
        workspace,
        runtime_bin: root.join("amiro"),
        token: "test-token".to_string(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    (state, root)
}

fn ago(hours: i64) -> String {
    (Utc::now() - chrono::Duration::hours(hours))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn expect_ok<T>(result: Result<T, ApiError>) -> T {
    match result {
        Ok(value) => value,
        Err(err) => panic!("expected Ok, got {} {}", err.0.as_u16(), err.1),
    }
}

/// A log file last written `hours` ago.
fn old_log(path: &Path, hours: u64) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "x".repeat(1024)).unwrap();
    let when = std::time::SystemTime::now() - Duration::from_secs(hours * 3600);
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[test]
fn settings_take_days_hours_and_a_time_and_need_something_to_clean() {
    let base = Settings::default();
    assert_eq!(base.older_than_hours, 48);
    assert!(!base.enabled, "off until the owner sets it up");

    let week = base
        .apply_patch(&json!({"olderThanDays": 7, "enabled": true, "time": "02:30"}))
        .unwrap();
    assert_eq!(
        (week.older_than_hours, week.enabled, week.time.as_str()),
        (168, true, "02:30")
    );
    let snake = base
        .apply_patch(&json!({"older_than_hours": 36, "schedule_runs": false, "log_files": false}))
        .unwrap();
    assert_eq!(
        (snake.older_than_hours, snake.schedule_runs, snake.log_files),
        (36, false, false)
    );

    assert!(base.apply_patch(&json!({"time": "25:00"})).is_err());
    assert!(base.apply_patch(&json!({"olderThanHours": 0})).is_err());
    assert!(base.apply_patch(&json!({"olderThanDays": 400})).is_err());
    assert!(base
        .apply_patch(&json!({"chats": false, "scheduleRuns": false, "logFiles": false}))
        .is_err());
}

#[test]
fn age_and_summary_read_plainly() {
    assert_eq!(age_text(48), "2 days");
    assert_eq!(age_text(168), "1 week");
    assert_eq!(age_text(24), "1 day");
    assert_eq!(age_text(36), "36 hours");
    let settings = Settings {
        archived: true,
        ..Settings::default()
    };
    assert_eq!(
        summary(&settings),
        "Daily at 3:00 AM · chats (archived too), run logs and log files untouched for 2 days"
    );
}

#[test]
fn next_run_is_the_next_local_time_after_the_last_one() {
    let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
    // 02:00 IST on 3 Nov is 20:30 UTC on 2 Nov.
    let before = "2026-11-02T20:00:00Z".parse::<DateTime<Utc>>().unwrap();
    assert_eq!(
        next_run_after(before, "02:00", kolkata)
            .unwrap()
            .to_rfc3339(),
        "2026-11-02T20:30:00+00:00"
    );
    let after = "2026-11-02T21:00:00Z".parse::<DateTime<Utc>>().unwrap();
    assert_eq!(
        next_run_after(after, "02:00", kolkata)
            .unwrap()
            .to_rfc3339(),
        "2026-11-03T20:30:00+00:00"
    );
}

#[test]
fn turning_it_on_waits_for_the_next_time_instead_of_running_at_once() {
    let settings = Settings {
        enabled: true,
        ..Settings::default()
    };
    let doc = json!({"enabledAt": now_iso()});
    let due = next_due(&doc, &settings, chrono_tz::UTC).unwrap();
    assert!(due > Utc::now());
    assert!(
        next_due(&doc, &Settings::default(), chrono_tz::UTC).is_none(),
        "off has no next run"
    );
}

#[tokio::test]
async fn preview_lists_then_cleanup_deletes_only_what_is_old_and_covered() {
    let (state, root) = temp_state();
    std::fs::write(
        state.home.join("threads.json"),
        json!({
            "old": {"title": "Old chat", "userId": "u1", "lastMessageAt": ago(72)},
            "fresh": {"title": "Fresh chat", "userId": "u1", "lastMessageAt": ago(2)},
            "made-long-ago": {"title": "Never used", "userId": "u1", "createdAt": ago(100)},
            "old-archived": {"title": "Archived", "userId": "u1", "archived": true, "lastMessageAt": ago(72)},
            "channel": {"title": "Amiro", "userId": "u1", "channel": true, "lastMessageAt": ago(500)},
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        crate::schedules::runs_path(&state),
        json!({
            "r-old": {"status": "ok", "scheduledAt": ago(80), "finishedAt": ago(79)},
            "r-new": {"status": "ok", "scheduledAt": ago(3), "finishedAt": ago(3)},
            "r-running": {"status": "running", "scheduledAt": ago(90)},
        })
        .to_string(),
    )
    .unwrap();
    old_log(&state.home.join("logs/amiro-2026-10-01.log"), 100);
    old_log(&state.runtime_home.join("logs/sub/amiro.log.1"), 100);
    old_log(&state.workspace.join("data/logs/cleanup.log"), 100);
    old_log(&state.home.join("logs/today.log"), 1);
    old_log(&state.home.join("logs/notes.txt"), 100);

    let settings = Settings::default();
    let preview = expect_ok(clean(&state, &settings, true).await);
    assert_eq!(preview["dryRun"], true);
    assert_eq!(preview["chats"], 2, "{preview}");
    assert_eq!(preview["scheduleRuns"], 1);
    assert_eq!(preview["logFiles"], 3);
    assert!(preview["text"]
        .as_str()
        .unwrap()
        .starts_with("Would delete 2 chats, 1 schedule run log and 3 log files"));
    assert!(
        state.home.join("logs/amiro-2026-10-01.log").exists(),
        "a preview deletes nothing"
    );
    let threads: Value =
        serde_json::from_str(&std::fs::read_to_string(state.home.join("threads.json")).unwrap())
            .unwrap();
    assert_eq!(threads.as_object().unwrap().len(), 5);

    let report = expect_ok(clean(&state, &settings, false).await);
    assert_eq!(
        (
            report["chats"].as_u64(),
            report["scheduleRuns"].as_u64(),
            report["logFiles"].as_u64()
        ),
        (Some(2), Some(1), Some(3))
    );
    let threads: Value =
        serde_json::from_str(&std::fs::read_to_string(state.home.join("threads.json")).unwrap())
            .unwrap();
    let mut left: Vec<&str> = threads
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    left.sort();
    assert_eq!(left, ["channel", "fresh", "old-archived"]);
    let runs: Value = serde_json::from_str(
        &std::fs::read_to_string(crate::schedules::runs_path(&state)).unwrap(),
    )
    .unwrap();
    let mut left: Vec<&str> = runs
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    left.sort();
    assert_eq!(left, ["r-new", "r-running"]);
    assert!(!state.home.join("logs/amiro-2026-10-01.log").exists());
    assert!(!state.runtime_home.join("logs/sub/amiro.log.1").exists());
    assert!(
        state.home.join("logs/today.log").exists(),
        "recent logs stay"
    );
    assert!(state.home.join("logs/notes.txt").exists(), "only log files");

    // Archived chats go only when asked.
    let with_archived = Settings {
        archived: true,
        ..settings
    };
    let report = expect_ok(clean(&state, &with_archived, false).await);
    assert_eq!(report["chats"], 1);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn run_now_records_the_last_run_and_a_preview_does_not() {
    let (state, root) = temp_state();
    expect_ok(save_settings(&state, &json!({"olderThanDays": 2, "enabled": true})).await);
    let preview = expect_ok(run_now(&state, &json!({}), true).await);
    assert_eq!(preview["dryRun"], true);
    assert!(expect_ok(view(&state).await)["lastRunAt"].is_null());

    expect_ok(run_now(&state, &json!({"logFiles": false}), false).await);
    let view = expect_ok(view(&state).await);
    assert!(view["lastRunAt"].is_string());
    assert_eq!(
        view["settings"]["logFiles"], true,
        "a per-run override does not change the settings"
    );
    let task = system_task(&state).await;
    assert_eq!(task["id"], "cleanup");
    assert_eq!(task["enabled"], true);
    assert_eq!(task["lastStatus"], "nothing");
    let _ = std::fs::remove_dir_all(root);
}
