//! Live check of the native runtime bridge against a real Amiro runtime.
//!
//! Opt-in: the test returns immediately unless `AMIRO_TEST_API_SOCKET` points
//! at a running harness API socket. It never spawns or replaces a runtime, so it
//! cannot disturb the developer's own sessions.
//!
//! What it proves: the backend's own bridge functions complete the protocol v1
//! handshake, create a session pinned to a chosen directory, read its (empty)
//! history through `AttachSession`+`GetHistory`, rename it, and archive it --
//! all against the real engine rather than a stub.

use backend::runtime;
use backend::state::AppState;

fn temp_workspace() -> std::path::PathBuf {
    let root = std::env::var_os("AMIRO_TEST_TEMP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = root.join(format!(
        "amiro-runtime-live-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn native_bridge_creates_reads_renames_and_archives_a_real_session() {
    let Ok(socket) = std::env::var("AMIRO_TEST_API_SOCKET") else {
        eprintln!("skipping live runtime check: AMIRO_TEST_API_SOCKET is not set");
        return;
    };

    let home = temp_workspace();
    std::env::set_var("AMIRO_HOME", &home);
    std::env::set_var("AMIRO_RUNTIME_HOME", &home);
    std::env::set_var("AMIRO_API_SOCKET", &socket);
    std::env::set_var("AMIRO_NO_RUNTIME_SPAWN", "1");
    let state = AppState::from_env();

    let workspace = temp_workspace();
    let session = runtime::create_session(&state, &workspace.to_string_lossy(), false)
        .await
        .expect("create_session must reach the real runtime");
    assert!(
        !session.session_id.is_empty(),
        "runtime must return a session id"
    );
    assert!(session.created);
    if let Some(applied) = session.working_dir.as_deref() {
        assert_eq!(
            applied.trim_end_matches('/'),
            workspace.to_string_lossy().trim_end_matches('/'),
            "session must run in the requested directory"
        );
    }

    let history = runtime::get_history(&state, &session.session_id)
        .await
        .expect("get_history must reach the real runtime");
    assert!(history.is_empty(), "a fresh session has no history");

    runtime::rename_session(&state, &session.session_id, "native bridge check")
        .await
        .expect("rename_session must succeed");

    runtime::archive_session(&state, &session.session_id)
        .await
        .expect("archive_session must succeed");

    let _ = std::fs::remove_dir_all(&workspace);
    let _ = std::fs::remove_dir_all(&home);
}
