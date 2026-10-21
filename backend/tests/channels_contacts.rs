//! Integration tests for Channels and Contacts backend routes and agent MCP tools.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const ADMIN_TOKEN: &str = "tok-channels-admin";
const ADMIN_ID: &str = "user-channels-admin";
const NORMAL_TOKEN: &str = "tok-channels-normal";
const NORMAL_ID: &str = "user-channels-normal";

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
    let root = std::env::temp_dir().join(format!("amiro-channels-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();

    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": ADMIN_ID, "name": "Admin", "role": "admin", "createdAt": now_iso()},
            {"id": NORMAL_ID, "name": "Normal", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            ADMIN_TOKEN: {"userId": ADMIN_ID, "createdAt": now_iso()},
            NORMAL_TOKEN: {"userId": NORMAL_ID, "createdAt": now_iso()},
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
    router().with_state(fixture.state.clone())
}

async fn call_json(
    app: &Router,
    token: Option<&str>,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => builder
            .header("content-length", "0")
            .body(Body::empty())
            .unwrap(),
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

#[tokio::test]
async fn test_channels_available_and_readiness() {
    let f = fixture();
    let a = app(&f);

    // 1. Available channels list (unauthenticated rejected, user accepted)
    let (status, _) = call_json(&a, None, Method::GET, "/api/channels/available", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, val) = call_json(&a, Some(NORMAL_TOKEN), Method::GET, "/api/channels/available", None).await;
    assert_eq!(status, StatusCode::OK);
    let channels = val["channels"].as_array().expect("array of channels");
    assert!(channels.iter().any(|c| c["id"] == "slack"));
    assert!(channels.iter().any(|c| c["id"] == "telegram"));
    assert!(channels.iter().any(|c| c["id"] == "discord"));
    assert!(channels.iter().any(|c| c["id"] == "phone"));

    // 2. Readiness snapshot
    let (status, val) = call_json(&a, Some(NORMAL_TOKEN), Method::GET, "/api/channels/readiness", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(val["success"], true);
    let snapshots = val["snapshots"].as_array().expect("array of snapshots");
    assert!(snapshots.len() >= 4);
}

#[tokio::test]
async fn test_channel_admission_policy_and_overrides() {
    let f = fixture();
    let a = app(&f);

    // 1. Normal user cannot change policy (Admin only)
    let (status, _) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::PUT,
        "/api/channels/policy/telegram",
        Some(json!({ "policy": "guardian_only" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // 2. Admin can set policy
    let (status, val) = call_json(
        &a,
        Some(ADMIN_TOKEN),
        Method::PUT,
        "/api/channels/policy/telegram",
        Some(json!({ "policy": "trusted_contacts", "note": "Verified people only" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(val["policy"]["policy"], "trusted_contacts");

    // 3. Read back policies
    let (status, val) = call_json(&a, Some(NORMAL_TOKEN), Method::GET, "/api/channels/policy", None).await;
    assert_eq!(status, StatusCode::OK);
    let policies = val["policies"].as_array().unwrap();
    assert!(policies.iter().any(|p| p["channelType"] == "telegram" && p["policy"] == "trusted_contacts"));

    // 4. Permission overrides (e.g. Slack channel access tiers)
    let (status, val) = call_json(
        &a,
        Some(ADMIN_TOKEN),
        Method::PUT,
        "/api/channels/permissions/overrides",
        Some(json!({
            "selector": { "scope": "channel", "adapter": "slack", "channelExternalId": "C12345" },
            "contactType": "trusted_contact",
            "threshold": "low"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(val["cell"]["threshold"], "low");

    // 5. Resolve permission
    let (status, val) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::POST,
        "/api/channels/permissions/resolve",
        Some(json!({
            "adapter": "slack",
            "channelExternalId": "C12345"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(val["resolved"]["threshold"], "low");
}

#[tokio::test]
async fn test_contacts_crud_and_merge() {
    let f = fixture();
    let a = app(&f);

    // 1. Initial contacts has the guardian "You"
    let (status, val) = call_json(&a, Some(NORMAL_TOKEN), Method::GET, "/api/contacts", None).await;
    assert_eq!(status, StatusCode::OK);
    let contacts = val["contacts"].as_array().unwrap();
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0]["role"], "guardian");
    let guardian_id = contacts[0]["id"].as_str().unwrap().to_string();

    // 2. Create contact "Alice" with telegram channel
    let (status, val) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::POST,
        "/api/contacts",
        Some(json!({
            "displayName": "Alice",
            "notes": "Teammate in sales",
            "channels": [
                { "type": "telegram", "address": "@alice_sales", "isPrimary": true }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let alice_id = val["contact"]["id"].as_str().unwrap().to_string();
    assert_eq!(val["contact"]["displayName"], "Alice");
    assert_eq!(val["contact"]["channels"][0]["address"], "@alice_sales");

    // 3. Search contacts
    let (status, val) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::POST,
        "/api/contacts/search",
        Some(json!({ "query": "alice" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let matches = val.as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["id"], alice_id);

    // 4. Create second contact "Alice Work" with slack channel
    let (status, val) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::POST,
        "/api/contacts",
        Some(json!({
            "displayName": "Alice Work",
            "channels": [
                { "type": "slack", "address": "U98765432" }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let alice_work_id = val["contact"]["id"].as_str().unwrap().to_string();

    // 5. Merge "Alice Work" into "Alice"
    let (status, val) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::POST,
        "/api/contacts/merge",
        Some(json!({
            "keepId": alice_id,
            "mergeId": alice_work_id
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let survivor = &val["contact"];
    assert_eq!(survivor["id"], alice_id);
    let chs = survivor["channels"].as_array().unwrap();
    assert_eq!(chs.len(), 2);
    assert!(chs.iter().any(|c| c["type"] == "telegram"));
    assert!(chs.iter().any(|c| c["type"] == "slack"));

    // 6. Merged donor contact is gone
    let (status, _) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::GET,
        &format!("/api/contacts/{alice_work_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // 7. Verify channel
    let channel_id = chs[0]["id"].as_str().unwrap();
    let (status, _) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::POST,
        &format!("/api/contact-channels/{channel_id}/verify"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 8. Delete contact "Alice"
    let (status, _) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::DELETE,
        &format!("/api/contacts/{alice_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Guardian cannot be deleted
    let (status, _) = call_json(
        &a,
        Some(NORMAL_TOKEN),
        Method::DELETE,
        &format!("/api/contacts/{guardian_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
