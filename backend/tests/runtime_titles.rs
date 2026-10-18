use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use backend::{
    state::{write_json, AppState},
    threads,
};
use serde_json::json;
use std::sync::Arc;
use tower::ServiceExt;

fn fixture() -> AppState {
    let root = std::env::temp_dir().join(format!("amiro-title-{}", uuid::Uuid::new_v4()));
    AppState {
        home: root.join("home"),
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("api.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("missing-runtime"),
        token: "fixture".into(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    }
}

#[tokio::test]
async fn runtime_titles_preserve_ownership_session_mapping_and_manual_renames() {
    let state = fixture();
    threads::upsert_entry(
        &state,
        "thread",
        json!({"userId":"owner","sessionId":"session","title":"New Chat"}),
    )
    .await
    .unwrap();
    assert_eq!(
        threads::sync_runtime_title(&state, "thread", "owner", "session", "Runtime title")
            .await
            .unwrap()
            .as_deref(),
        Some("Runtime title")
    );
    assert_eq!(
        threads::get_entry(&state, "thread").await.unwrap().unwrap()["titleSource"],
        "runtime"
    );
    for (id, uid, sid, title) in [
        ("missing", "owner", "session", "Late"),
        ("thread", "other", "session", "Wrong"),
        ("thread", "owner", "previous", "Wrong"),
        ("thread", "owner", "session", " "),
    ] {
        assert!(threads::sync_runtime_title(&state, id, uid, sid, title)
            .await
            .unwrap()
            .is_none());
    }
    threads::upsert_entry(
        &state,
        "thread",
        json!({"title":"My name","titleSource":"manual"}),
    )
    .await
    .unwrap();
    assert!(
        threads::sync_runtime_title(&state, "thread", "owner", "session", "Overwrite")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        threads::get_entry(&state, "thread").await.unwrap().unwrap()["title"],
        "My name"
    );
    assert!(threads::get_entry(&state, "missing")
        .await
        .unwrap()
        .is_none());
    std::fs::remove_dir_all(state.home.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn title_endpoint_does_not_create_threads_or_require_cosmetic_inference() {
    let state = fixture();
    let now = backend::state::now_iso();
    write_json(
        &state.home.join("users.json"),
        &json!({"users":[{"id":"owner","role":"user"}]}),
    )
    .await
    .unwrap();
    write_json(
        &state.home.join("sessions.json"),
        &json!({"sessions":{"token":{"userId":"owner","createdAt":now}}}),
    )
    .await
    .unwrap();
    threads::upsert_entry(&state,"manual",json!({"userId":"owner","sessionId":"session","title":"Manual name","titleSource":"manual"})).await.unwrap();
    threads::upsert_entry(
        &state,
        "other",
        json!({"userId":"other","sessionId":"session","title":"Private"}),
    )
    .await
    .unwrap();
    let app = backend::chat::router().with_state(state.clone());
    for (id, status) in [
        ("missing", StatusCode::NOT_FOUND),
        ("other", StatusCode::NOT_FOUND),
        ("manual", StatusCode::OK),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/chat/title")
                    .header("authorization", "Bearer token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"threadId":id,"message":"Ignore supplied text"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        if status == StatusCode::OK {
            let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(text.contains("Manual name"));
            assert!(!text.contains("title-unavailable"));
        }
    }
    assert!(threads::get_entry(&state, "missing")
        .await
        .unwrap()
        .is_none());
    std::fs::remove_dir_all(state.home.parent().unwrap()).unwrap();
}
