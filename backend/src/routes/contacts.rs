//! Contacts module (Vellum-style native architecture).
//!
//! Stores contacts, channels, risk ceilings, and invites under:
//! - `$AMIRO_HOME/store/contacts.json`

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use uuid::Uuid;

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const CONTACTS_STORE: &str = "contacts.json";

/// Contacts are the owner's address book and trust list (Vellum's guardian
/// data), so only the owner reads or changes them.
fn require_owner(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Only the owner can manage contacts".into(),
        ));
    }
    Ok(())
}

fn contacts_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join(CONTACTS_STORE)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactChannel {
    pub id: String,
    pub contact_id: String,
    pub r#type: String,
    pub address: String,
    #[serde(default)]
    pub is_primary: bool,
    pub external_chat_id: Option<String>,
    pub external_user_id: Option<String>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_policy")]
    pub policy: String,
    pub verified_at: Option<u64>,
    pub verified_via: Option<String>,
    pub last_seen_at: Option<u64>,
    #[serde(default)]
    pub interaction_count: u64,
    pub last_interaction: Option<u64>,
    pub revoked_reason: Option<String>,
    pub blocked_reason: Option<String>,
    pub created_at: Option<u64>,
    pub updated_at: Option<u64>,
}

fn default_status() -> String {
    "unverified".to_string()
}

fn default_policy() -> String {
    "allow".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub display_name: String,
    pub role: String, // "guardian" | "contact"
    pub notes: Option<String>,
    #[serde(default = "default_contact_type")]
    pub contact_type: String, // "human" | "assistant"
    pub principal_id: Option<String>,
    #[serde(default)]
    pub interaction_count: u64,
    pub last_interaction: Option<u64>,
    pub auto_approve_threshold: Option<String>, // "none" | "low" | "medium" | "high" | null
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub channels: Vec<ContactChannel>,
}

fn default_contact_type() -> String {
    "human".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressInvite {
    pub id: String,
    pub token: String,
    pub source_channel: String,
    pub contact_id: String,
    pub note: Option<String>,
    pub status: String, // "active" | "redeemed" | "revoked"
    pub expires_at: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/contacts", get(list_contacts).post(upsert_contact))
        .route("/api/contacts/search", post(search_contacts))
        .route("/api/contacts/merge", post(merge_contacts))
        .route("/api/contacts/invites", post(create_invite))
        .route("/api/contacts/invites/{id}", delete(revoke_invite))
        .route("/api/contacts/invites/redeem", post(redeem_invite))
        .route(
            "/api/contact-channels/{id}",
            patch(patch_contact_channel),
        )
        .route(
            "/api/contact-channels/{id}/verify",
            post(verify_contact_channel),
        )
        .route(
            "/api/contacts/{id}",
            get(get_contact).delete(delete_contact),
        )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn load_contacts_doc(state: &AppState) -> Value {
    let path = contacts_path(state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    if doc.get("contacts").is_none() {
        // Ensure a guardian contact exists for the current instance owner
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let guardian = json!({
            "id": Uuid::new_v4().to_string(),
            "displayName": "You",
            "role": "guardian",
            "notes": "Instance administrator",
            "contactType": "human",
            "interactionCount": 0,
            "lastInteraction": null,
            "autoApproveThreshold": null,
            "createdAt": now,
            "updatedAt": now,
            "channels": []
        });
        doc = json!({
            "contacts": [guardian],
            "invites": []
        });
        let _ = write_json(&path, &doc).await;
    }
    doc
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

pub async fn list_contacts(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let doc = load_contacts_doc(&state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some(role) = params.get("role") {
        contacts.retain(|c| c.get("role").and_then(Value::as_str) == Some(role));
    }
    if let Some(channel_type) = params.get("channelType") {
        contacts.retain(|c| {
            c.get("channels")
                .and_then(Value::as_array)
                .map(|chs| {
                    chs.iter().any(|ch| {
                        ch.get("type").and_then(Value::as_str) == Some(channel_type)
                    })
                })
                .unwrap_or(false)
        });
    }

    Ok(Json(json!({ "ok": true, "contacts": contacts })))
}

pub async fn get_contact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(contact_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let doc = load_contacts_doc(&state).await;
    let contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let found = contacts.into_iter().find(|c| c.get("id").and_then(Value::as_str) == Some(&contact_id));
    match found {
        Some(contact) => Ok(Json(json!({ "ok": true, "contact": contact }))),
        None => Err(ApiError(StatusCode::NOT_FOUND, "Contact not found".into())),
    }
}

pub async fn search_contacts(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let doc = load_contacts_doc(&state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let query = body.get("query").and_then(Value::as_str).map(|s| s.trim().to_lowercase());
    let channel_addr = body.get("channelAddress").and_then(Value::as_str).map(|s| s.trim().to_lowercase());
    let channel_type = body.get("channelType").and_then(Value::as_str);

    if let Some(q) = query {
        if !q.is_empty() {
            contacts.retain(|c| {
                c.get("displayName")
                    .and_then(Value::as_str)
                    .map(|name| name.to_lowercase().contains(&q))
                    .unwrap_or(false)
            });
        }
    }

    if let Some(addr) = channel_addr {
        if !addr.is_empty() {
            contacts.retain(|c| {
                c.get("channels")
                    .and_then(Value::as_array)
                    .map(|chs| {
                        chs.iter().any(|ch| {
                            ch.get("address")
                                .and_then(Value::as_str)
                                .map(|a| a.to_lowercase().contains(&addr))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            });
        }
    }

    if let Some(ct) = channel_type {
        contacts.retain(|c| {
            c.get("channels")
                .and_then(Value::as_array)
                .map(|chs| {
                    chs.iter().any(|ch| ch.get("type").and_then(Value::as_str) == Some(ct))
                })
                .unwrap_or(false)
        });
    }

    Ok(Json(Value::Array(contacts)))
}

pub async fn upsert_contact(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let id_opt = body.get("id").and_then(Value::as_str);
    let display_name = body.get("displayName").and_then(Value::as_str).unwrap_or("New Contact");
    let notes = body.get("notes").and_then(Value::as_str);
    let threshold = body.get("autoApproveThreshold").and_then(Value::as_str);

    let contact = if let Some(contact_id) = id_opt {
        if let Some(existing) = contacts.iter_mut().find(|c| c.get("id").and_then(Value::as_str) == Some(contact_id)) {
            if let Some(map) = existing.as_object_mut() {
                map.insert("displayName".into(), json!(display_name));
                if body.get("notes").is_some() {
                    map.insert("notes".into(), json!(notes));
                }
                if body.get("autoApproveThreshold").is_some() {
                    map.insert("autoApproveThreshold".into(), json!(threshold));
                }
                map.insert("updatedAt".into(), json!(now));

                // Process channels if provided
                if let Some(chs) = body.get("channels").and_then(Value::as_array) {
                    let mut current_chs = map.get("channels").and_then(Value::as_array).cloned().unwrap_or_default();
                    for ch in chs {
                        let ch_type = ch.get("type").and_then(Value::as_str).unwrap_or("");
                        let ch_addr = ch.get("address").and_then(Value::as_str).unwrap_or("");
                        if ch_type.is_empty() || ch_addr.is_empty() {
                            continue;
                        }
                        if let Some(existing_ch) = current_chs.iter_mut().find(|c| {
                            c.get("type").and_then(Value::as_str) == Some(ch_type)
                                && c.get("address").and_then(Value::as_str).map(|a| a.eq_ignore_ascii_case(ch_addr)).unwrap_or(false)
                        }) {
                            if let Some(ch_map) = existing_ch.as_object_mut() {
                                ch_map.insert("updatedAt".into(), json!(now));
                            }
                        } else {
                            let new_ch_id = Uuid::new_v4().to_string();
                            current_chs.push(json!({
                                "id": new_ch_id,
                                "contactId": contact_id,
                                "type": ch_type,
                                "address": ch_addr,
                                "isPrimary": ch.get("isPrimary").and_then(Value::as_bool).unwrap_or(false),
                                // Verification is earned through the channel
                                // (see `verify_contact_channel`), never sent.
                                "status": "unverified",
                                "policy": ch.get("policy").and_then(Value::as_str).unwrap_or("allow"),
                                "verifiedAt": null,
                                "interactionCount": 0,
                                "createdAt": now,
                                "updatedAt": now
                            }));
                        }
                    }
                    map.insert("channels".into(), Value::Array(current_chs));
                }
            }
            existing.clone()
        } else {
            let new_c = json!({
                "id": contact_id,
                "displayName": display_name,
                "role": "contact",
                "notes": notes,
                "contactType": "human",
                "interactionCount": 0,
                "lastInteraction": null,
                "autoApproveThreshold": threshold,
                "createdAt": now,
                "updatedAt": now,
                "channels": []
            });
            contacts.push(new_c.clone());
            new_c
        }
    } else {
        let new_id = Uuid::new_v4().to_string();
        let mut new_channels = Vec::new();
        if let Some(chs) = body.get("channels").and_then(Value::as_array) {
            for ch in chs {
                let ch_type = ch.get("type").and_then(Value::as_str).unwrap_or("");
                let ch_addr = ch.get("address").and_then(Value::as_str).unwrap_or("");
                if !ch_type.is_empty() && !ch_addr.is_empty() {
                    new_channels.push(json!({
                        "id": Uuid::new_v4().to_string(),
                        "contactId": new_id,
                        "type": ch_type,
                        "address": ch_addr,
                        "isPrimary": true,
                        "status": "unverified",
                        "policy": "allow",
                        "verifiedAt": null,
                        "interactionCount": 0,
                        "createdAt": now,
                        "updatedAt": now
                    }));
                }
            }
        }
        let new_c = json!({
            "id": new_id,
            "displayName": display_name,
            "role": "contact",
            "notes": notes,
            "contactType": "human",
            "interactionCount": 0,
            "lastInteraction": null,
            "autoApproveThreshold": threshold,
            "createdAt": now,
            "updatedAt": now,
            "channels": new_channels
        });
        contacts.push(new_c.clone());
        new_c
    };

    doc["contacts"] = Value::Array(contacts);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "ok": true, "contact": contact })))
}

pub async fn delete_contact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(contact_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    require_owner(&user)?;
    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let target = contacts.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(&contact_id));
    if let Some(c) = target {
        if c.get("role").and_then(Value::as_str) == Some("guardian") {
            return Err(ApiError(StatusCode::FORBIDDEN, "Cannot delete guardian contact".into()));
        }
    } else {
        return Err(ApiError(StatusCode::NOT_FOUND, "Contact not found".into()));
    }

    contacts.retain(|c| c.get("id").and_then(Value::as_str) != Some(&contact_id));
    doc["contacts"] = Value::Array(contacts);
    write_json(&path, &doc).await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn merge_contacts(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let keep_id = body.get("keepId").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "keepId is required".into())
    })?;
    let merge_id = body.get("mergeId").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "mergeId is required".into())
    })?;

    if keep_id == merge_id {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Cannot merge contact with itself".into()));
    }

    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let merge_pos = contacts.iter().position(|c| c.get("id").and_then(Value::as_str) == Some(merge_id));
    let Some(merge_idx) = merge_pos else {
        return Err(ApiError(StatusCode::NOT_FOUND, "Merge contact not found".into()));
    };

    let donor = contacts.remove(merge_idx);
    if donor.get("role").and_then(Value::as_str) == Some("guardian") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Cannot merge away guardian contact".into()));
    }

    let keep_pos = contacts.iter().position(|c| c.get("id").and_then(Value::as_str) == Some(keep_id));
    let Some(keep_idx) = keep_pos else {
        return Err(ApiError(StatusCode::NOT_FOUND, "Keep contact not found".into()));
    };

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let donor_channels = donor.get("channels").and_then(Value::as_array).cloned().unwrap_or_default();
    let donor_notes = donor.get("notes").and_then(Value::as_str).unwrap_or("");

    let survivor = &mut contacts[keep_idx];
    if let Some(map) = survivor.as_object_mut() {
        map.insert("updatedAt".into(), json!(now));
        if !donor_notes.is_empty() {
            let existing_notes = map.get("notes").and_then(Value::as_str).unwrap_or("");
            let combined = if existing_notes.is_empty() {
                donor_notes.to_string()
            } else {
                format!("{existing_notes}\n{donor_notes}")
            };
            map.insert("notes".into(), json!(combined));
        }

        let mut survivor_chs = map.get("channels").and_then(Value::as_array).cloned().unwrap_or_default();
        for mut dch in donor_channels {
            let d_type = dch.get("type").and_then(Value::as_str).unwrap_or("");
            let d_addr = dch.get("address").and_then(Value::as_str).unwrap_or("");
            let exists = survivor_chs.iter().any(|sch| {
                sch.get("type").and_then(Value::as_str) == Some(d_type)
                    && sch.get("address").and_then(Value::as_str).map(|a| a.eq_ignore_ascii_case(d_addr)).unwrap_or(false)
            });
            if !exists {
                if let Some(dch_map) = dch.as_object_mut() {
                    dch_map.insert("contactId".into(), json!(keep_id));
                    dch_map.insert("updatedAt".into(), json!(now));
                }
                survivor_chs.push(dch);
            }
        }
        map.insert("channels".into(), Value::Array(survivor_chs));
    }

    let result_contact = survivor.clone();
    doc["contacts"] = Value::Array(contacts);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "ok": true, "contact": result_contact })))
}

pub async fn patch_contact_channel(
    State(state): State<AppState>,
    user: AuthUser,
    Path(channel_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let mut found = false;
    let mut updated_contact = Value::Null;

    for contact in &mut contacts {
        if let Some(chs) = contact.get_mut("channels").and_then(Value::as_array_mut) {
            for ch in chs.iter_mut() {
                if ch.get("id").and_then(Value::as_str) == Some(&channel_id) {
                    found = true;
                    if let Some(ch_map) = ch.as_object_mut() {
                        if let Some(status) = body.get("status").and_then(Value::as_str) {
                            // Revoke, block, or reset to unverified. Becoming
                            // verified only happens through a code.
                            if !matches!(status, "revoked" | "blocked" | "unverified") {
                                return Err(ApiError(
                                    StatusCode::BAD_REQUEST,
                                    "status must be revoked, blocked or unverified; verify a channel with its code".into(),
                                ));
                            }
                            ch_map.insert("status".into(), json!(status));
                            if status == "unverified" {
                                ch_map.insert("verifiedAt".into(), Value::Null);
                                ch_map.insert("verifiedVia".into(), Value::Null);
                            }
                            if status == "revoked" {
                                ch_map.insert("revokedReason".into(), json!(body.get("reason").and_then(Value::as_str)));
                                ch_map.insert("blockedReason".into(), Value::Null);
                            } else if status == "blocked" {
                                ch_map.insert("blockedReason".into(), json!(body.get("reason").and_then(Value::as_str)));
                                ch_map.insert("revokedReason".into(), Value::Null);
                            }
                        }
                        if let Some(policy) = body.get("policy").and_then(Value::as_str) {
                            ch_map.insert("policy".into(), json!(policy));
                        }
                        ch_map.insert("updatedAt".into(), json!(now));
                    }
                    break;
                }
            }
        }
        if found {
            if let Some(c_map) = contact.as_object_mut() {
                c_map.insert("updatedAt".into(), json!(now));
            }
            updated_contact = contact.clone();
            break;
        }
    }

    if !found {
        return Err(ApiError(StatusCode::NOT_FOUND, "Channel not found".into()));
    }

    doc["contacts"] = Value::Array(contacts);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "ok": true, "contact": updated_contact })))
}

/// A verification code waiting to be typed back.
struct PendingCode {
    code: String,
    expires: Instant,
    attempts: u8,
}

const CODE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_CODE_ATTEMPTS: u8 = 5;

/// Codes by contact-channel id. In memory: a restart simply means sending a
/// new code.
static PENDING_CODES: OnceLock<Mutex<HashMap<String, PendingCode>>> = OnceLock::new();

fn pending_codes() -> &'static Mutex<HashMap<String, PendingCode>> {
    PENDING_CODES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Channel types Amiro can message, so they verify by code.
fn verifies_by_code(channel_type: &str) -> bool {
    matches!(channel_type, "telegram" | "slack" | "discord")
}

fn channel_label(channel_type: &str) -> &str {
    match channel_type {
        "telegram" => "Telegram",
        "slack" => "Slack",
        "discord" => "Discord",
        other => other,
    }
}

fn find_channel(doc: &Value, channel_id: &str) -> Option<Value> {
    doc.get("contacts")?
        .as_array()?
        .iter()
        .flat_map(|c| c.get("channels").and_then(Value::as_array).cloned().unwrap_or_default())
        .find(|ch| ch.get("id").and_then(Value::as_str) == Some(channel_id))
}

/// Mark a channel verified (`via` is `"code"` or `"manual"`).
async fn mark_verified(state: &AppState, channel_id: &str, via: &str) -> Result<(), ApiError> {
    let _guard = state.store.lock().await;
    let path = contacts_path(state);
    let mut doc = load_contacts_doc(state).await;
    let mut contacts: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let mut found = false;
    for contact in &mut contacts {
        if let Some(chs) = contact.get_mut("channels").and_then(Value::as_array_mut) {
            if let Some(ch) = chs
                .iter_mut()
                .find(|ch| ch.get("id").and_then(Value::as_str) == Some(channel_id))
            {
                if let Some(ch_map) = ch.as_object_mut() {
                    ch_map.insert("status".into(), json!("active"));
                    ch_map.insert("verifiedAt".into(), json!(now));
                    ch_map.insert("verifiedVia".into(), json!(via));
                    ch_map.insert("revokedReason".into(), Value::Null);
                    ch_map.insert("blockedReason".into(), Value::Null);
                    ch_map.insert("updatedAt".into(), json!(now));
                }
                found = true;
            }
        }
        if found {
            if let Some(c_map) = contact.as_object_mut() {
                c_map.insert("updatedAt".into(), json!(now));
            }
            break;
        }
    }
    if !found {
        return Err(ApiError(StatusCode::NOT_FOUND, "Channel not found".into()));
    }
    doc["contacts"] = Value::Array(contacts);
    write_json(&path, &doc).await
}

/// POST /api/contact-channels/{id}/verify
///
/// Vellum's verification: proof comes through the channel itself. Without a
/// body, Amiro sends a six-digit code to the account with the bot set up in
/// Channels (`{"status":"code_sent"}`); posting `{"code":"123456"}` back
/// marks the channel verified. A code lasts ten minutes and allows five
/// tries. Channel types Amiro cannot message (email, phone) are confirmed by
/// the owner directly and recorded as `verifiedVia: "manual"`.
pub async fn verify_contact_channel(
    State(state): State<AppState>,
    user: AuthUser,
    Path(channel_id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let body: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "body must be JSON".into()))?
    };
    let doc = load_contacts_doc(&state).await;
    let record = find_channel(&doc, &channel_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Channel not found".into()))?;
    let channel_type = record.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    if matches!(record.get("status").and_then(Value::as_str), Some("blocked")) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "This account is blocked. Unblock it first.".into()));
    }

    if !verifies_by_code(&channel_type) {
        mark_verified(&state, &channel_id, "manual").await?;
        return Ok(Json(json!({ "ok": true, "status": "verified", "via": "manual" })));
    }

    let label = channel_label(&channel_type).to_string();
    if let Some(code) = body.get("code").and_then(Value::as_str).map(str::trim) {
        let outcome = {
            let mut codes = pending_codes().lock().map_err(|_| {
                ApiError(StatusCode::INTERNAL_SERVER_ERROR, "verification codes unavailable".into())
            })?;
            match codes.get_mut(&channel_id) {
                None => Err("No code is waiting for this account. Send a new code."),
                Some(pending) if pending.expires < Instant::now() => {
                    codes.remove(&channel_id);
                    Err("That code has expired. Send a new code.")
                }
                Some(pending) if pending.code == code => {
                    codes.remove(&channel_id);
                    Ok(())
                }
                Some(pending) => {
                    pending.attempts += 1;
                    if pending.attempts >= MAX_CODE_ATTEMPTS {
                        codes.remove(&channel_id);
                        Err("Too many wrong codes. Send a new code.")
                    } else {
                        Err("That code is not right. Check the message and try again.")
                    }
                }
            }
        };
        return match outcome {
            Ok(()) => {
                mark_verified(&state, &channel_id, "code").await?;
                Ok(Json(json!({ "ok": true, "status": "verified", "via": "code" })))
            }
            Err(message) => Err(ApiError(StatusCode::BAD_REQUEST, message.into())),
        };
    }

    // No code yet: send one through the channel.
    let token = crate::notify::destinations::bot_token(&state, &channel_type)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                format!("Connect the {label} bot on the Channels page first, so Amiro can send you a code."),
            )
        })?;
    let endpoint = crate::notify::destinations::endpoint_for(&channel_type, &record).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            if channel_type == "telegram" {
                "A bot can only message a Telegram account by its numeric user id, not an @username. Add the number instead (message @userinfobot on Telegram to see yours).".to_string()
            } else {
                format!("Amiro cannot message this {label} account directly. Use your {label} user id.")
            },
        )
    })?;
    let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
    crate::routes::notify_channels::send_raw(
        &channel_type,
        &token,
        &endpoint,
        "Amiro verification",
        &format!("Your code is {code}. Enter it in Amiro → Contacts to confirm this account is yours. It expires in 10 minutes."),
        None,
    )
    .await
    .map_err(|error| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("{label} did not deliver the code: {}. Message the bot once first, then try again.", error.1),
        )
    })?;
    if let Ok(mut codes) = pending_codes().lock() {
        codes.retain(|_, pending| pending.expires > Instant::now());
        codes.insert(
            channel_id.clone(),
            PendingCode { code, expires: Instant::now() + CODE_TTL, attempts: 0 },
        );
    }
    Ok(Json(json!({ "ok": true, "status": "code_sent", "channel": channel_type })))
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

pub async fn create_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let contact_id = body.get("contactId").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "contactId is required".into())
    })?;
    let source_channel = body.get("sourceChannel").and_then(Value::as_str).unwrap_or("a2a");
    let note = body.get("note").and_then(Value::as_str);

    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut invites: Vec<Value> = doc
        .get("invites")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let expires_at = now + 7 * 24 * 60 * 60 * 1000; // 7 days
    let token = Uuid::new_v4().to_string();
    let invite_id = Uuid::new_v4().to_string();

    let invite = json!({
        "id": invite_id,
        "token": token,
        "sourceChannel": source_channel,
        "contactId": contact_id,
        "note": note,
        "status": "active",
        "expiresAt": expires_at,
        "createdAt": now,
        "updatedAt": now,
    });

    invites.push(invite.clone());
    doc["invites"] = Value::Array(invites);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "ok": true, "invite": invite, "token": token })))
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(invite_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut invites: Vec<Value> = doc
        .get("invites")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut found = false;
    let now = chrono::Utc::now().timestamp_millis() as u64;
    for inv in &mut invites {
        if inv.get("id").and_then(Value::as_str) == Some(&invite_id) {
            found = true;
            if let Some(map) = inv.as_object_mut() {
                map.insert("status".into(), json!("revoked"));
                map.insert("updatedAt".into(), json!(now));
            }
            break;
        }
    }

    if !found {
        return Err(ApiError(StatusCode::NOT_FOUND, "Invite not found".into()));
    }

    doc["invites"] = Value::Array(invites);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn redeem_invite(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let token = body.get("token").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "token is required".into())
    })?;

    let _guard = state.store.lock().await;
    let path = contacts_path(&state);
    let mut doc = load_contacts_doc(&state).await;
    let mut invites: Vec<Value> = doc
        .get("invites")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let invite_pos = invites.iter().position(|i| {
        i.get("token").and_then(Value::as_str) == Some(token)
            && i.get("status").and_then(Value::as_str) == Some("active")
            && i.get("expiresAt").and_then(Value::as_u64).unwrap_or(0) > now
    });

    let Some(idx) = invite_pos else {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Invalid or expired invite".into()));
    };

    let invite = &mut invites[idx];
    let contact_id = invite.get("contactId").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(map) = invite.as_object_mut() {
        map.insert("status".into(), json!("redeemed"));
        map.insert("updatedAt".into(), json!(now));
    }

    let redeemed_invite = invite.clone();
    doc["invites"] = Value::Array(invites);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "ok": true, "success": true, "invite": redeemed_invite, "contactId": contact_id })))
}
