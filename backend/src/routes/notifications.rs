//! Vellum-style notification backend: persistence, delivery policy, and the
//! real-time SSE fan-out the Web UI and Desktop clients subscribe to.
//!
//! Two state files, both owner-scoped by `userId` and serialized through
//! `AppState::store`:
//!   $AMIRO_HOME/store/notifications.json          -> { version, items: { uid: [..] } }
//!   $AMIRO_HOME/store/notification-settings.json  -> { uid: { ..settings.. } }
//!
//! Every create/upsert also publishes on an in-process `broadcast` channel so
//! connected clients receive `notification_intent` / `notifications_updated`
//! immediately, without polling. The same channel backs
//! `GET /api/notifications/stream`.
//!
//! The `silent` flag is resolved with Vellum's completion policy: a disabled
//! global toggle or a disabled category forces silence; otherwise an explicit
//! `allAlertsEnabled` lets everything through, and the remaining categories and
//! high/critical urgencies stay audible.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};

const KEEPALIVE: Duration = Duration::from_secs(15);

const CATEGORIES: [&str; 5] = [
    "chat_reply",
    "schedule_result",
    "heartbeat",
    "approval",
    "system",
];
const URGENCIES: [&str; 4] = ["low", "normal", "high", "critical"];
const STATUSES: [&str; 4] = ["new", "seen", "acted_on", "dismissed"];
const RECEIPT_CLASSES: [&str; 4] = [
    "client_os_posted",
    "web_notification",
    "desktop_native",
    "in_app_toast",
];

/// Push an already-built event onto the pipeline fan-out channel (owned by
/// `crate::notify::broadcaster`). A send with no subscribers is not an error
/// here (a client simply was not connected).
pub(crate) fn publish(event: Value) {
    crate::notify::broadcaster::publish(event);
}

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn notifications_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("notifications.json")
}

fn settings_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("notification-settings.json")
}

fn default_settings() -> Value {
    json!({
        "enabled": true,
        "allAlertsEnabled": true,
        "chatReplyAlerts": true,
        "scheduleAlerts": true,
        "heartbeatAlerts": true,
        "soundEnabled": true,
        "desktopBannerEnabled": true,
        "webPushEnabled": true,
        "quietHoursEnabled": false,
        "quietStart": "22:00",
        "quietEnd": "08:00",
    })
}

fn bool_setting(settings: &Value, key: &str, fallback: bool) -> bool {
    settings
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback)
}

fn category_enabled(settings: &Value, category: &str) -> bool {
    match category {
        "chat_reply" => bool_setting(settings, "chatReplyAlerts", true),
        "schedule_result" => bool_setting(settings, "scheduleAlerts", true),
        "heartbeat" => bool_setting(settings, "heartbeatAlerts", true),
        // approval and system have no dedicated toggle; they follow the global
        // switch and are considered enabled when notifications are on.
        _ => true,
    }
}

/// Resolve `silent` from settings, category, and urgency (Vellum's completion
/// policy). `true` means a client must not raise an OS/banner alert, though the
/// item still lands in the feed.
pub fn resolve_silent(settings: &Value, category: &str, urgency: &str) -> bool {
    if !bool_setting(settings, "enabled", true) {
        return true;
    }
    if !category_enabled(settings, category) {
        return true;
    }
    if bool_setting(settings, "allAlertsEnabled", true) {
        return false;
    }
    let audible_category = matches!(
        category,
        "chat_reply" | "schedule_result" | "heartbeat" | "approval"
    );
    let audible_urgency = matches!(urgency, "high" | "critical");
    !(audible_category || audible_urgency)
}

pub(crate) async fn load_settings_doc(state: &AppState) -> Result<Value, ApiError> {
    read_json(&settings_path(state), json!({})).await
}

pub(crate) fn settings_for(doc: &Value, uid: &str) -> Value {
    let mut settings = default_settings();
    if let Some(stored) = doc.get(uid) {
        if let Some(map) = stored.as_object() {
            let base = settings.as_object_mut().expect("object");
            for (key, value) in map {
                base.insert(key.clone(), value.clone());
            }
        }
    }
    settings
}

async fn unread_count_of(state: &AppState, uid: &str) -> Result<u64, ApiError> {
    let doc = read_json(
        &notifications_path(state),
        json!({ "version": 2, "items": {} }),
    )
    .await?;
    Ok(count_unread(items_for(&doc, uid)))
}

fn items_for(doc: &Value, uid: &str) -> Vec<Value> {
    doc.get("items")
        .and_then(|items| items.get(uid))
        .and_then(|items| items.as_array())
        .cloned()
        .unwrap_or_default()
}

fn count_unread(items: Vec<Value>) -> u64 {
    items
        .iter()
        .filter(|item| item.get("status").and_then(|s| s.as_str()) == Some("new"))
        .count() as u64
}

fn set_items(doc: &mut Value, uid: &str, items: Vec<Value>) {
    if !doc.is_object() {
        *doc = json!({ "version": 2, "items": {} });
    }
    let root = doc.as_object_mut().expect("object");
    root.insert("version".to_string(), json!(2));
    let entries = root.entry("items".to_string()).or_insert_with(|| json!({}));
    if !entries.is_object() {
        *entries = json!({});
    }
    entries
        .as_object_mut()
        .expect("items object")
        .insert(uid.to_string(), Value::Array(items));
}

fn created_updated_at(item: &Value) -> (String, String) {
    let created = item
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated = item
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (created, updated)
}

/// Find the index of an existing item by id (replacement is in place, matching
/// Vellum's home-feed-writer), or `None` for a fresh item.
fn index_of(items: &[Value], id: &str) -> Option<usize> {
    items
        .iter()
        .position(|item| item.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn default_actions(category: &str, thread_id: Option<&str>) -> Vec<Value> {
    if category == "chat_reply" || thread_id.is_some() {
        vec![json!({ "id": "view", "label": "View Conversation" })]
    } else {
        Vec::new()
    }
}

/// Build a normalized notification item from caller input. Validation rejects
/// unknown enums so a bad category can never be persisted.
pub(crate) fn build_item(
    uid: &str,
    body: &Value,
    settings: &Value,
    defaults: Option<(&str, &str, &str, &str)>,
) -> Result<Value, ApiError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let default_title = defaults.map(|d| d.0).unwrap_or("");
    let default_body = defaults.map(|d| d.1).unwrap_or("");
    let default_category = defaults.map(|d| d.2).unwrap_or("system");
    let default_urgency = defaults.map(|d| d.3).unwrap_or("normal");

    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(default_title)
        .to_string();
    let text = body
        .get("body")
        .or_else(|| body.get("summary"))
        .and_then(|v| v.as_str())
        .unwrap_or(default_body)
        .to_string();
    let category = body
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or(default_category)
        .to_string();
    if !CATEGORIES.contains(&category.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown notification category: {category}"),
        ));
    }
    let urgency = body
        .get("urgency")
        .and_then(|v| v.as_str())
        .unwrap_or(default_urgency)
        .to_string();
    if !URGENCIES.contains(&urgency.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown notification urgency: {urgency}"),
        ));
    }
    let status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("new")
        .to_string();
    if !STATUSES.contains(&status.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown notification status: {status}"),
        ));
    }

    let thread_id = body
        .get("threadId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let schedule_id = body
        .get("scheduleId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let source_event_name = body
        .get("sourceEventName")
        .and_then(|v| v.as_str())
        .unwrap_or("system.notification")
        .to_string();

    let actions = body
        .get("actions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_else(|| default_actions(&category, thread_id.as_deref()));

    let silent = body
        .get("silent")
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| resolve_silent(settings, &category, &urgency));

    let timestamp = now_iso();
    let created_at = body
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or(&timestamp)
        .to_string();

    // Compat (migration 05-migration): inbound payloads without a delivery id
    // get one generated, so old emitters keep working.
    let delivery_id = body
        .get("deliveryId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let mut item = Map::new();
    item.insert("id".into(), json!(id));
    item.insert("deliveryId".into(), json!(delivery_id));
    item.insert("userId".into(), json!(uid));
    item.insert("title".into(), json!(title));
    item.insert("body".into(), json!(text));
    item.insert("summary".into(), json!(text));
    item.insert("category".into(), json!(category));
    item.insert("urgency".into(), json!(urgency));
    item.insert("status".into(), json!(status));
    item.insert("silent".into(), json!(silent));
    item.insert("threadId".into(), json!(thread_id));
    item.insert("scheduleId".into(), json!(schedule_id));
    item.insert("sourceEventName".into(), json!(source_event_name));
    item.insert("actions".into(), Value::Array(actions));
    item.insert("createdAt".into(), json!(created_at));
    item.insert("updatedAt".into(), json!(timestamp));
    item.insert("ackedAt".into(), Value::Null);
    item.insert("deliveryReceipt".into(), Value::Null);
    Ok(Value::Object(item))
}

/// Persist an item for `uid`: replace in place when the id already exists,
/// otherwise insert at the front so the feed stays newest-first.
pub(crate) async fn persist_item(
    state: &AppState,
    uid: &str,
    item: Value,
) -> Result<u64, ApiError> {
    let _lock = state.store.lock().await;
    let path = notifications_path(state);
    let mut doc = read_json(&path, json!({ "version": 2, "items": {} })).await?;
    let mut items = items_for(&doc, uid);
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    match index_of(&items, &id) {
        Some(index) => items[index] = item,
        None => items.insert(0, item),
    }
    let unread = count_unread(items.clone());
    set_items(&mut doc, uid, items);
    write_json(&path, &doc).await?;
    Ok(unread)
}

/// Build the `notification_intent` SSE event (Phase 02 shape): the current
/// fields plus `deliveryId` and a `deepLinkTarget` so clients can route
/// clicks without guessing URLs from the item.
pub(crate) fn intent_event(user_id: &str, delivery_id: &str, item: &Value, unread: u64) -> Value {
    json!({
        "type": "notification_intent",
        "userId": user_id,
        "deliveryId": delivery_id,
        "deepLinkTarget": {
            "threadId": item.get("threadId").cloned().unwrap_or(Value::Null),
            "scheduleId": item.get("scheduleId").cloned().unwrap_or(Value::Null),
        },
        "notification": item,
        "unreadCount": unread,
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
struct ListQuery {
    #[serde(default, rename = "includeDismissed")]
    include_dismissed: Option<bool>,
    #[serde(default, rename = "unreadOnly")]
    unread_only: Option<bool>,
}

/// GET /api/notifications -- the caller's feed plus settings and unread count.
async fn list_notifications(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let doc = read_json(
        &notifications_path(&state),
        json!({ "version": 2, "items": {} }),
    )
    .await?;
    let settings_doc = load_settings_doc(&state).await?;
    let settings = settings_for(&settings_doc, &uid);

    let include_dismissed = query.include_dismissed.unwrap_or(false);
    let unread_only = query.unread_only.unwrap_or(false);

    let mut items: Vec<Value> = items_for(&doc, &uid)
        .into_iter()
        .filter(|item| {
            let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("new");
            if !include_dismissed && status == "dismissed" {
                return false;
            }
            if unread_only && status != "new" {
                return false;
            }
            true
        })
        .collect();

    let unread = items
        .iter()
        .filter(|item| item.get("status").and_then(|s| s.as_str()) == Some("new"))
        .count() as u64;

    let updated_at = items
        .iter()
        .map(|item| created_updated_at(item).1)
        .filter(|value| !value.is_empty())
        .max()
        .unwrap_or_else(now_iso);

    // Newest first by updatedAt where timestamps are present.
    items.sort_by(|a, b| created_updated_at(b).1.cmp(&created_updated_at(a).1));

    Ok(Json(json!({
        "version": 2,
        "items": items,
        "unreadCount": unread,
        "updatedAt": updated_at,
        "settings": settings,
    })))
}

/// POST /api/notifications -- create or upsert an item for the caller.
async fn create_notification(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let uid = user_id_of(&user);
    let settings_doc = load_settings_doc(&state).await?;
    let settings = settings_for(&settings_doc, &uid);
    let item = build_item(&uid, &body, &settings, None)?;
    let delivery_id = item
        .get("deliveryId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let unread = persist_item(&state, &uid, item.clone()).await?;
    publish(intent_event(&uid, &delivery_id, &item, unread));
    Ok((
        StatusCode::CREATED,
        Json(json!({ "item": item, "unreadCount": unread })),
    ))
}

/// POST /api/notifications/test -- a real end-to-end test notification.
async fn test_notification(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let uid = user_id_of(&user);
    let settings_doc = load_settings_doc(&state).await?;
    let settings = settings_for(&settings_doc, &uid);
    let input = json!({
        "title": "Amiro Test Notification",
        "body": "Notifications are working across Web UI and Desktop.",
        "category": "system",
        "urgency": "high",
        "sourceEventName": "system.test",
        "actions": [{"id": "dismiss", "label": "Dismiss"}],
    });
    let item = build_item(&uid, &input, &settings, None)?;
    let delivery_id = item
        .get("deliveryId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let unread = persist_item(&state, &uid, item.clone()).await?;
    publish(intent_event(&uid, &delivery_id, &item, unread));
    Ok((
        StatusCode::CREATED,
        Json(json!({ "item": item, "unreadCount": unread })),
    ))
}

async fn update_notification(
    state: &AppState,
    uid: &str,
    id: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    if let Some(status) = body.get("status").and_then(|v| v.as_str()) {
        if !STATUSES.contains(&status) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                format!("unknown notification status: {status}"),
            ));
        }
    }
    let _lock = state.store.lock().await;
    let path = notifications_path(state);
    let mut doc = read_json(&path, json!({ "version": 2, "items": {} })).await?;
    let mut items = items_for(&doc, uid);
    let index = index_of(&items, id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "notification not found".to_string()))?;
    {
        let item = items[index].as_object_mut().ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "stored notification is not an object".to_string(),
            )
        })?;
        if let Some(status) = body.get("status").and_then(|v| v.as_str()) {
            item.insert("status".into(), json!(status));
            if status != "new" && item.get("seenAt").is_none() {
                item.insert("seenAt".into(), json!(now_iso()));
            }
        }
        if let Some(title) = body.get("title").and_then(|v| v.as_str()) {
            item.insert("title".into(), json!(title));
        }
        if let Some(text) = body
            .get("body")
            .or_else(|| body.get("summary"))
            .and_then(|v| v.as_str())
        {
            item.insert("body".into(), json!(text));
            item.insert("summary".into(), json!(text));
        }
        item.insert("updatedAt".into(), json!(now_iso()));
    }
    let updated = items[index].clone();
    let unread = count_unread(items.clone());
    set_items(&mut doc, uid, items);
    write_json(&path, &doc).await?;
    Ok(json!({ "item": updated, "unreadCount": unread }))
}

/// PATCH/PUT /api/notifications/{id}
async fn patch_notification(
    Path(id): Path<String>,
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let result = update_notification(&state, &uid, &id, &body).await?;
    publish(json!({
        "type": "notifications_updated",
        "userId": uid,
        "unreadCount": result.get("unreadCount").cloned().unwrap_or(json!(0)),
        "notification": result.get("item").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(result))
}

/// POST /api/notifications/mark-all-read
async fn mark_all_read(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let _lock = state.store.lock().await;
    let path = notifications_path(&state);
    let mut doc = read_json(&path, json!({ "version": 2, "items": {} })).await?;
    let mut items = items_for(&doc, &uid);
    let mut updated = 0u64;
    for item in items.iter_mut() {
        if item.get("status").and_then(|s| s.as_str()) == Some("new") {
            if let Some(map) = item.as_object_mut() {
                map.insert("status".into(), json!("seen"));
                map.insert("seenAt".into(), json!(now_iso()));
                map.insert("updatedAt".into(), json!(now_iso()));
            }
            updated += 1;
        }
    }
    let unread = count_unread(items.clone());
    set_items(&mut doc, &uid, items);
    write_json(&path, &doc).await?;
    drop(_lock);

    publish(json!({
        "type": "notifications_updated",
        "userId": uid,
        "unreadCount": unread,
    }));
    Ok(Json(json!({ "updated": updated, "unreadCount": unread })))
}

/// POST /api/notifications/clear-all
async fn clear_all(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let _lock = state.store.lock().await;
    let path = notifications_path(&state);
    let mut doc = read_json(&path, json!({ "version": 2, "items": {} })).await?;
    let mut items = items_for(&doc, &uid);
    let mut cleared = 0u64;
    for item in items.iter_mut() {
        if item.get("status").and_then(|s| s.as_str()) != Some("dismissed") {
            if let Some(map) = item.as_object_mut() {
                map.insert("status".into(), json!("dismissed"));
                map.insert("updatedAt".into(), json!(now_iso()));
            }
            cleared += 1;
        }
    }
    let unread = count_unread(items.clone());
    set_items(&mut doc, &uid, items);
    write_json(&path, &doc).await?;
    drop(_lock);

    publish(json!({
        "type": "notifications_updated",
        "userId": uid,
        "unreadCount": unread,
    }));
    Ok(Json(json!({ "cleared": cleared, "unreadCount": unread })))
}

/// POST /api/notifications/{id}/ack -- Vellum-style client delivery receipt.
async fn ack_notification(
    Path(id): Path<String>,
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let delivered = body
        .get("delivered")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let receipt_class = body
        .get("receiptClass")
        .and_then(|v| v.as_str())
        .unwrap_or("client_os_posted")
        .to_string();
    if !RECEIPT_CLASSES.contains(&receipt_class.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown receiptClass: {receipt_class}"),
        ));
    }

    let _lock = state.store.lock().await;
    let path = notifications_path(&state);
    let mut doc = read_json(&path, json!({ "version": 2, "items": {} })).await?;
    let mut items = items_for(&doc, &uid);
    let index = index_of(&items, &id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "notification not found".to_string()))?;
    {
        let item = items[index].as_object_mut().ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "stored notification is not an object".to_string(),
            )
        })?;
        // Phase 02: `ack` keeps the four receipt classes and appends to
        // `receipts[]`, so every surface's delivery leaves a permanent row.
        let acked_at = now_iso();
        item.insert(
            "ackedAt".into(),
            if delivered {
                json!(acked_at)
            } else {
                Value::Null
            },
        );
        item.insert(
            "deliveryReceipt".into(),
            if delivered {
                json!(receipt_class)
            } else {
                Value::Null
            },
        );
        if delivered {
            let receipts = item.entry("receipts").or_insert_with(|| json!([]));
            if let Some(list) = receipts.as_array_mut() {
                list.push(json!({
                    "receiptClass": receipt_class,
                    "deliveredAt": acked_at,
                }));
            }
        }
        item.insert("updatedAt".into(), json!(now_iso()));
    }
    let updated = items[index].clone();
    let unread = count_unread(items.clone());
    set_items(&mut doc, &uid, items);
    write_json(&path, &doc).await?;

    Ok(Json(json!({
        "delivered": delivered,
        "receiptClass": receipt_class,
        "item": updated,
        "unreadCount": unread,
    })))
}

/// GET /api/notifications/settings
async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let doc = load_settings_doc(&state).await?;
    Ok(Json(settings_for(&doc, &uid)))
}

/// PUT /api/notifications/settings -- partial merge over stored settings.
async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let _lock = state.store.lock().await;
    let path = settings_path(&state);
    let mut doc = read_json(&path, json!({})).await?;
    let effective = settings_for(&doc, &uid);
    let mut merged = effective.as_object().cloned().unwrap_or_default();
    if let Some(incoming) = body.as_object() {
        for (key, value) in incoming {
            merged.insert(key.clone(), value.clone());
        }
    }
    let merged_value = Value::Object(merged);
    if !doc.is_object() {
        doc = json!({});
    }
    doc.as_object_mut()
        .expect("object")
        .insert(uid.clone(), merged_value.clone());
    write_json(&path, &doc).await?;
    Ok(Json(merged_value))
}

/// GET /api/notifications/{id}/deliveries -- per-channel delivery rows for one
/// feed item. Rows share the item's `deliveryId`; resends mint a new delivery
/// id under the same `signalId`, so rows are collected by signal and merged.
/// Only metadata is returned (channel, status, error, timestamps) — never a
/// token.
async fn notification_deliveries(
    Path(id): Path<String>,
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let doc = read_json(
        &notifications_path(&state),
        json!({ "version": 2, "items": {} }),
    )
    .await?;
    let item = items_for(&doc, &uid)
        .into_iter()
        .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "notification not found".to_string(),
            )
        })?;
    let delivery_id = item
        .get("deliveryId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let rows = crate::notify::store::all_deliveries(&state).await?;
    let mut signal_ids = std::collections::HashSet::new();
    for row in &rows {
        if row.get("userId").and_then(|v| v.as_str()) != Some(uid.as_str()) {
            continue;
        }
        if row.get("deliveryId").and_then(|v| v.as_str()) == Some(delivery_id.as_str()) {
            if let Some(signal_id) = row.get("signalId").and_then(|v| v.as_str()) {
                signal_ids.insert(signal_id.to_string());
            }
        }
    }
    let deliveries: Vec<Value> = rows
        .into_iter()
        .filter(|row| {
            row.get("userId").and_then(|v| v.as_str()) == Some(uid.as_str())
                && (row.get("deliveryId").and_then(|v| v.as_str()) == Some(delivery_id.as_str())
                    || row
                        .get("signalId")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| signal_ids.contains(s)))
        })
        .collect();
    Ok(Json(json!({ "deliveries": deliveries })))
}

/// GET /api/notifications/stream -- SSE snapshot + live fan-out.
async fn stream_notifications(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<impl IntoResponse, ApiError> {
    let uid = user_id_of(&user);
    let unread = unread_count_of(&state, &uid).await?;
    let mut receiver = crate::notify::subscribe();

    let stream = async_stream::stream! {
        yield Ok::<Event, Infallible>(
            Event::default().data(
                json!({ "type": "snapshot", "unreadCount": unread }).to_string(),
            ),
        );
        loop {
            match receiver.recv().await {
                Ok(value) => {
                    if !event_is_for(&value, &uid) {
                        continue;
                    }
                    yield Ok(Event::default().data(value.to_string()));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEPALIVE).text("keepalive")))
}

/// A broadcast event belongs to `uid` when its (or its notification's) `userId`
/// matches. Events without an owner are broadcast to everyone.
fn event_is_for(value: &Value, uid: &str) -> bool {
    let owner = value.get("userId").and_then(|v| v.as_str()).or_else(|| {
        value
            .get("notification")
            .and_then(|n| n.get("userId"))
            .and_then(|v| v.as_str())
    });
    match owner {
        Some(owner) => owner == uid,
        None => true,
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/notifications",
            get(list_notifications).post(create_notification),
        )
        .route("/api/notifications/test", post(test_notification))
        .route("/api/notifications/mark-all-read", post(mark_all_read))
        .route("/api/notifications/clear-all", post(clear_all))
        .route(
            "/api/notifications/settings",
            get(get_settings).put(put_settings),
        )
        .route("/api/notifications/stream", get(stream_notifications))
        .route(
            "/api/notifications/{id}",
            axum::routing::patch(patch_notification)
                .put(patch_notification)
                .delete(delete_notification),
        )
        .route("/api/notifications/{id}/ack", post(ack_notification))
        .route(
            "/api/notifications/{id}/deliveries",
            get(notification_deliveries),
        )
}

/// DELETE /api/notifications/{id} -- dismiss a single notification.
async fn delete_notification(
    Path(id): Path<String>,
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let result = update_notification(&state, &uid, &id, &json!({ "status": "dismissed" })).await?;
    publish(json!({
        "type": "notifications_updated",
        "userId": uid,
        "unreadCount": result.get("unreadCount").cloned().unwrap_or(json!(0)),
    }));
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_policy_matches_vellum_completion_rules() {
        let on = default_settings();
        assert!(!resolve_silent(&on, "chat_reply", "normal"));
        assert!(!resolve_silent(&on, "system", "low"));

        let mut alerts_off = default_settings();
        alerts_off["allAlertsEnabled"] = json!(false);
        assert!(!resolve_silent(&alerts_off, "chat_reply", "low"));
        assert!(!resolve_silent(&alerts_off, "approval", "normal"));
        assert!(!resolve_silent(&alerts_off, "system", "critical"));
        assert!(resolve_silent(&alerts_off, "system", "low"));

        let mut disabled = default_settings();
        disabled["enabled"] = json!(false);
        assert!(resolve_silent(&disabled, "chat_reply", "critical"));

        let mut chat_off = default_settings();
        chat_off["chatReplyAlerts"] = json!(false);
        assert!(resolve_silent(&chat_off, "chat_reply", "high"));
        assert!(!resolve_silent(&chat_off, "heartbeat", "high"));
    }

    #[test]
    fn build_item_rejects_unknown_enums() {
        let settings = default_settings();
        let bad = json!({ "title": "x", "category": "nope" });
        assert!(build_item("u1", &bad, &settings, None).is_err());
        let bad_urgency = json!({ "title": "x", "urgency": "extreme" });
        assert!(build_item("u1", &bad_urgency, &settings, None).is_err());
        let ok = json!({ "title": "x" });
        let item = build_item("u1", &ok, &settings, None).unwrap();
        assert_eq!(item["category"], json!("system"));
        assert_eq!(item["urgency"], json!("normal"));
        assert_eq!(item["status"], json!("new"));
    }

    #[test]
    fn event_filter_is_owner_scoped() {
        assert!(event_is_for(&json!({"userId": "u1"}), "u1"));
        assert!(!event_is_for(&json!({"userId": "u2"}), "u1"));
        assert!(event_is_for(
            &json!({"notification": {"userId": "u1"}}),
            "u1"
        ));
        assert!(!event_is_for(
            &json!({"notification": {"userId": "u2"}}),
            "u1"
        ));
        assert!(event_is_for(
            &json!({"type": "notifications_updated"}),
            "u1"
        ));
    }
}
