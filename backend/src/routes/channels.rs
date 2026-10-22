//! Channels and integration adapters module (Vellum-style native architecture).
//!
//! Stores channel settings, readiness, and webhook/socket configurations under:
//! - `$AMIRO_HOME/store/channels.json`
//! - `$AMIRO_HOME/protected/credentials.enc` (via `credentials::set` for tokens)

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::credentials;
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const CHANNELS_STORE: &str = "channels.json";

fn channels_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join(CHANNELS_STORE)
}

/// Check a bot token with its provider before it is saved, as Vellum's
/// channel setup does, and return the bot's name as the provider reports it.
/// A rejected token is a 400 the form can show, never a saved credential.
async fn verified_bot_name(channel: &str, label: &str, token: &str) -> Result<String, ApiError> {
    crate::routes::notify_channels::verify_bot(channel, token)
        .await
        .map_err(|error| {
            if error.0 == StatusCode::UNAUTHORIZED || error.0 == StatusCode::FORBIDDEN {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    format!("{label} rejected that bot token. Check it and try again."),
                )
            } else {
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    format!("Could not reach {label} to check the bot token: {}", error.1),
                )
            }
        })
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPolicy {
    pub channel_type: String,
    pub policy: String,
    pub note: Option<String>,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPermissionOverride {
    pub scope: String,
    pub adapter: String,
    #[serde(default)]
    pub channel_type: String,
    #[serde(default)]
    pub channel_external_id: String,
    pub contact_type: String,
    pub threshold: String,
    pub note: Option<String>,
    pub updated_at: u64,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        // Available channels
        .route("/api/channels/available", get(get_available_channels))
        // Readiness
        .route("/api/channels/readiness", get(get_channel_readiness))
        .route(
            "/api/channels/readiness/refresh",
            post(refresh_channel_readiness),
        )
        // Admission policy (trust floors)
        .route(
            "/api/channels/policy",
            get(list_channel_policies).put(set_channel_policy_root),
        )
        .route(
            "/api/channels/policy/{channel_type}",
            put(set_channel_policy_typed),
        )
        // Permission overrides (Slack thread / room access tiers)
        .route(
            "/api/channels/permissions/overrides",
            get(list_permission_overrides).put(set_permission_override),
        )
        .route(
            "/api/channels/permissions/resolve",
            post(resolve_channel_permission),
        )
        .route(
            "/api/channels/permissions/overrides/delete",
            post(delete_permission_override),
        )
        // Slack integration config
        .route(
            "/api/integrations/slack/channel/config",
            get(get_slack_config)
                .post(set_slack_config)
                .patch(patch_slack_config)
                .delete(delete_slack_config),
        )
        .route("/api/slack/channels", get(list_slack_channels))
        .route("/api/slack/users", get(list_slack_users))
        // Telegram integration config
        .route(
            "/api/integrations/telegram/config",
            get(get_telegram_config)
                .post(set_telegram_config)
                .delete(delete_telegram_config),
        )
        // Discord integration config
        .route(
            "/api/integrations/discord/config",
            get(get_discord_config)
                .post(set_discord_config)
                .delete(delete_discord_config),
        )
        // Twilio integration config
        .route(
            "/api/integrations/twilio/credentials",
            get(get_twilio_credentials)
                .post(set_twilio_credentials)
                .delete(delete_twilio_credentials),
        )
}

// ---------------------------------------------------------------------------
// Available Channels
// ---------------------------------------------------------------------------

pub async fn get_available_channels(
    State(_state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let channels = json!([
        {
            "id": "slack",
            "source": "default",
            "label": "Slack",
            "subtitle": "Message your assistant from Slack",
            "icon": "hash",
            "supportsVerification": true,
            "setupMessages": {
                "guardian": "I'd like to verify my identity as your guardian on Slack. Can you help me set that up?",
                "contact": "I'd like to verify a contact's Slack identity. Can you walk me through it?"
            }
        },
        {
            "id": "telegram",
            "source": "default",
            "label": "Telegram",
            "subtitle": "Message your assistant from Telegram",
            "icon": "send",
            "supportsVerification": true,
            "setupMessages": {
                "guardian": "I'd like to verify my identity as your guardian on Telegram. Can you help me set that up?",
                "contact": "I'd like to verify a contact's Telegram identity. Can you walk me through it?"
            }
        },
        {
            "id": "discord",
            "source": "default",
            "label": "Discord",
            "subtitle": "Message your assistant from Discord",
            "icon": "hash",
            "supportsVerification": true,
            "setupMessages": {
                "guardian": "I'd like to verify my identity as your guardian on Discord. Can you help me set that up?",
                "contact": "I'd like to verify a contact's Discord identity. Can you walk me through it?"
            }
        },
        {
            "id": "phone",
            "source": "default",
            "label": "Phone Calling",
            "subtitle": "Call or text your assistant via phone",
            "icon": "phone",
            "supportsVerification": true,
            "setupMessages": {
                "guardian": "I'd like to verify my identity as your guardian for phone calls. Can you help me set that up?",
                "contact": "I'd like to verify a contact's phone number. Can you help me set that up?"
            }
        },
        {
            "id": "email",
            "source": "default",
            "label": "Email",
            "subtitle": "Reach your assistant by email",
            "icon": "mail",
            "supportsVerification": false,
            "setupMessages": {
                "guardian": "I'd like to set up email as a way for me to reach you. Can you walk me through it?",
                "contact": "I'd like to set up email as a way to reach this contact. Can you walk me through it?"
            }
        }
    ]);

    Ok(Json(json!({ "channels": channels })))
}

// ---------------------------------------------------------------------------
// Channel Readiness
// ---------------------------------------------------------------------------

pub async fn compute_channel_snapshots(state: &AppState) -> Result<Vec<Value>, ApiError> {
    let creds = credentials::list_metadata(state).await.unwrap_or_default();
    let has_cred = |service: &str, field: &str| -> bool {
        creds.iter().any(|c| c.service == service && c.field == field)
    };

    let doc = read_json(&channels_path(state), json!({})).await.unwrap_or_else(|_| json!({}));
    let slack_cfg = doc.get("slack").cloned().unwrap_or_else(|| json!({}));
    let telegram_cfg = doc.get("telegram").cloned().unwrap_or_else(|| json!({}));
    let discord_cfg = doc.get("discord").cloned().unwrap_or_else(|| json!({}));
    let twilio_cfg = doc.get("twilio").cloned().unwrap_or_else(|| json!({}));

    let mut snapshots = Vec::new();

    // 1. Slack
    let slack_has_bot = has_cred("slack_channel", "bot_token");
    let slack_has_app = has_cred("slack_channel", "app_token");
    let slack_ready = slack_has_bot && slack_has_app;
    let slack_status = if slack_ready {
        "ready"
    } else if slack_has_bot || slack_has_app {
        "incomplete"
    } else {
        "not_configured"
    };
    snapshots.push(json!({
        "channel": "slack",
        "ready": slack_ready,
        "setupStatus": slack_status,
        "health": if slack_ready { "ok" } else { "unknown" },
        "channelHandle": slack_cfg.get("botUsername").and_then(Value::as_str),
        "localChecks": [
            { "name": "bot_token", "passed": slack_has_bot, "message": if slack_has_bot { "Slack bot token configured" } else { "Missing bot token" } },
            { "name": "app_token", "passed": slack_has_app, "message": if slack_has_app { "Slack app token configured" } else { "Missing app token" } }
        ]
    }));

    // 2. Telegram
    let telegram_has_token = has_cred("telegram", "bot_token");
    let telegram_status = if telegram_has_token { "ready" } else { "not_configured" };
    snapshots.push(json!({
        "channel": "telegram",
        "ready": telegram_has_token,
        "setupStatus": telegram_status,
        "health": if telegram_has_token { "ok" } else { "unknown" },
        "channelHandle": telegram_cfg.get("botUsername").and_then(Value::as_str),
        "localChecks": [
            { "name": "bot_token", "passed": telegram_has_token, "message": if telegram_has_token { "Telegram bot token configured" } else { "Missing bot token" } }
        ]
    }));

    // 3. Discord
    let discord_has_token = has_cred("discord_channel", "bot_token");
    let discord_status = if discord_has_token { "ready" } else { "not_configured" };
    snapshots.push(json!({
        "channel": "discord",
        "ready": discord_has_token,
        "setupStatus": discord_status,
        "health": if discord_has_token { "ok" } else { "unknown" },
        "channelHandle": discord_cfg.get("botUsername").and_then(Value::as_str),
        "localChecks": [
            { "name": "bot_token", "passed": discord_has_token, "message": if discord_has_token { "Discord bot token configured" } else { "Missing bot token" } }
        ]
    }));

    // 4. Phone (Twilio)
    let twilio_has_sid = has_cred("twilio", "account_sid");
    let twilio_has_token = has_cred("twilio", "auth_token");
    let _twilio_has_number = twilio_cfg.get("phoneNumber").is_some();
    let twilio_ready = twilio_has_sid && twilio_has_token;
    let twilio_status = if twilio_ready {
        "ready"
    } else if twilio_has_sid || twilio_has_token {
        "incomplete"
    } else {
        "not_configured"
    };
    snapshots.push(json!({
        "channel": "phone",
        "ready": twilio_ready,
        "setupStatus": twilio_status,
        "health": if twilio_ready { "ok" } else { "unknown" },
        "channelHandle": twilio_cfg.get("phoneNumber").and_then(Value::as_str),
        "localChecks": [
            { "name": "account_sid", "passed": twilio_has_sid, "message": if twilio_has_sid { "Twilio SID configured" } else { "Missing SID" } },
            { "name": "auth_token", "passed": twilio_has_token, "message": if twilio_has_token { "Twilio Token configured" } else { "Missing Token" } }
        ]
    }));

    // 5. Email
    let email_has_key = has_cred("resend", "api_key") || has_cred("mailgun", "api_key");
    snapshots.push(json!({
        "channel": "email",
        "ready": email_has_key,
        "setupStatus": if email_has_key { "ready" } else { "not_configured" },
        "health": if email_has_key { "ok" } else { "unknown" },
        "channelHandle": doc.get("email").and_then(|e| e.get("address")).and_then(Value::as_str),
        "localChecks": [
            { "name": "email_api_key", "passed": email_has_key, "message": if email_has_key { "Provider configured" } else { "Provider not configured" } }
        ]
    }));

    Ok(snapshots)
}

pub async fn get_channel_readiness(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let snapshots = compute_channel_snapshots(&state).await?;
    Ok(Json(json!({ "success": true, "snapshots": snapshots })))
}

pub async fn refresh_channel_readiness(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    get_channel_readiness(State(state), user).await
}

// ---------------------------------------------------------------------------
// Channel Admission Policy (Trust floors)
// ---------------------------------------------------------------------------

pub async fn list_channel_policies(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let policies = doc.get("policies").cloned().unwrap_or_else(|| json!([]));
    Ok(Json(json!({ "policies": policies })))
}

pub async fn set_channel_policy_root(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let channel_type = body.get("channelType").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "channelType is required".into())
    })?;
    let policy = body.get("policy").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "policy is required".into())
    })?;
    let note = body.get("note").and_then(Value::as_str);

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut list: Vec<Value> = doc
        .get("policies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let entry = json!({
        "channelType": channel_type,
        "policy": policy,
        "note": note,
        "updatedAt": now,
    });

    list.retain(|p| p.get("channelType").and_then(Value::as_str) != Some(channel_type));
    list.push(entry.clone());

    if !doc.is_object() {
        doc = json!({});
    }
    doc["policies"] = Value::Array(list);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "policy": entry })))
}

pub async fn set_channel_policy_typed(
    State(state): State<AppState>,
    user: AuthUser,
    Path(channel_type): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut merged = body;
    merged["channelType"] = json!(channel_type);
    set_channel_policy_root(State(state), user, Json(merged)).await
}

// ---------------------------------------------------------------------------
// Channel Permission Overrides (Slack thread / room access tiers)
// ---------------------------------------------------------------------------

pub async fn list_permission_overrides(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let cells = doc.get("permissionOverrides").cloned().unwrap_or_else(|| json!([]));
    Ok(Json(json!({ "cells": cells })))
}

pub async fn set_permission_override(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let selector = body.get("selector").ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "selector is required".into())
    })?;
    let contact_type = body.get("contactType").and_then(Value::as_str).unwrap_or("trusted_contact");
    let threshold = body.get("threshold").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "threshold is required".into())
    })?;
    let note = body.get("note").and_then(Value::as_str);

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut list: Vec<Value> = doc
        .get("permissionOverrides")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis() as u64;
    let cell = json!({
        "selector": selector,
        "contactType": contact_type,
        "threshold": threshold,
        "note": note,
        "updatedAt": now,
    });

    list.retain(|c| {
        !(c.get("selector") == Some(selector)
            && c.get("contactType").and_then(Value::as_str) == Some(contact_type))
    });
    list.push(cell.clone());

    if !doc.is_object() {
        doc = json!({});
    }
    doc["permissionOverrides"] = Value::Array(list);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "cell": cell })))
}

pub async fn resolve_channel_permission(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let adapter = body.get("adapter").and_then(Value::as_str).unwrap_or("slack");
    let channel_ext_id = body.get("channelExternalId").and_then(Value::as_str);
    let channel_type = body.get("channelType").and_then(Value::as_str);

    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let cells: Vec<Value> = doc
        .get("permissionOverrides")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // 1. Channel specific match
    if let Some(id) = channel_ext_id {
        if let Some(matched) = cells.iter().find(|c| {
            c.get("selector")
                .and_then(|s| s.get("channelExternalId"))
                .and_then(Value::as_str)
                == Some(id)
        }) {
            return Ok(Json(json!({
                "resolved": {
                    "threshold": matched["threshold"],
                    "scope": "channel"
                }
            })));
        }
    }

    // 2. Channel type match (e.g. dm)
    if let Some(ct) = channel_type {
        if let Some(matched) = cells.iter().find(|c| {
            c.get("selector")
                .and_then(|s| s.get("channelType"))
                .and_then(Value::as_str)
                == Some(ct)
        }) {
            return Ok(Json(json!({
                "resolved": {
                    "threshold": matched["threshold"],
                    "scope": "channel_type"
                }
            })));
        }
    }

    // 3. Adapter scope match
    if let Some(matched) = cells.iter().find(|c| {
        c.get("selector")
            .and_then(|s| s.get("scope"))
            .and_then(Value::as_str)
            == Some("adapter")
            && c.get("selector")
                .and_then(|s| s.get("adapter"))
                .and_then(Value::as_str)
                == Some(adapter)
    }) {
        return Ok(Json(json!({
            "resolved": {
                "threshold": matched["threshold"],
                "scope": "adapter"
            }
        })));
    }

    Ok(Json(json!({ "resolved": null })))
}

pub async fn delete_permission_override(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let selector = body.get("selector").ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "selector is required".into())
    })?;
    let contact_type = body.get("contactType").and_then(Value::as_str).unwrap_or("trusted_contact");

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut list: Vec<Value> = doc
        .get("permissionOverrides")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let before = list.len();
    list.retain(|c| {
        !(c.get("selector") == Some(selector)
            && c.get("contactType").and_then(Value::as_str) == Some(contact_type))
    });
    let removed = list.len() < before;

    if !doc.is_object() {
        doc = json!({});
    }
    doc["permissionOverrides"] = Value::Array(list);
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "removed": removed })))
}

// ---------------------------------------------------------------------------
// Slack Integration Config
// ---------------------------------------------------------------------------

pub async fn get_slack_config(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let creds = credentials::list_metadata(&state).await.unwrap_or_default();
    let has_bot = creds.iter().any(|c| c.service == "slack_channel" && c.field == "bot_token");
    let has_app = creds.iter().any(|c| c.service == "slack_channel" && c.field == "app_token");
    let has_user = creds.iter().any(|c| c.service == "slack_channel" && c.field == "user_token");

    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let slack_cfg = doc.get("slack").cloned().unwrap_or_else(|| json!({}));
    let thread_mode = slack_cfg.get("threadMode").and_then(Value::as_str).unwrap_or("mention_then_thread");

    Ok(Json(json!({
        "success": true,
        "hasBotToken": has_bot,
        "hasAppToken": has_app,
        "hasUserToken": has_user,
        "connected": has_bot && has_app,
        "botUserId": slack_cfg.get("botUserId"),
        "botUsername": slack_cfg.get("botUsername"),
        "teamId": slack_cfg.get("teamId"),
        "teamName": slack_cfg.get("teamName"),
        "teamUrl": slack_cfg.get("teamUrl"),
        "threadMode": thread_mode,
    })))
}

pub async fn set_slack_config(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let mut bot_name = None;
    if let Some(bot_token) = body.get("botToken").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        bot_name = Some(verified_bot_name("slack", "Slack", bot_token).await?);
        credentials::set(&state, "slack_channel", "bot_token", bot_token, Some("Slack Bot Token")).await?;
    }
    if let Some(app_token) = body.get("appToken").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        credentials::set(&state, "slack_channel", "app_token", app_token, Some("Slack App Token")).await?;
    }
    if let Some(user_token) = body.get("userToken").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        credentials::set(&state, "slack_channel", "user_token", user_token, Some("Slack User Token")).await?;
    }

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut slack = doc.get("slack").cloned().unwrap_or_else(|| json!({}));
    if !slack.is_object() {
        slack = json!({});
    }
    if let Some(thread_mode) = body.get("threadMode").and_then(Value::as_str) {
        slack["threadMode"] = json!(thread_mode);
    }
    if let Some(name) = bot_name {
        slack["botUsername"] = json!(name);
    }
    doc["slack"] = slack;
    write_json(&path, &doc).await?;
    drop(_guard);

    get_slack_config(State(state), user).await
}

pub async fn patch_slack_config(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut slack = doc.get("slack").cloned().unwrap_or_else(|| json!({}));
    if !slack.is_object() {
        slack = json!({});
    }
    if let Some(thread_mode) = body.get("threadMode").and_then(Value::as_str) {
        slack["threadMode"] = json!(thread_mode);
    }
    doc["slack"] = slack;
    write_json(&path, &doc).await?;
    drop(_guard);

    get_slack_config(State(state), user).await
}

pub async fn delete_slack_config(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let _ = credentials::delete(&state, "slack_channel", "bot_token").await;
    let _ = credentials::delete(&state, "slack_channel", "app_token").await;
    let _ = credentials::delete(&state, "slack_channel", "user_token").await;

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("slack");
    }
    write_json(&path, &doc).await?;
    drop(_guard);

    get_slack_config(State(state), user).await
}

pub async fn list_slack_channels(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let channels = doc.get("slackChannels").cloned().unwrap_or_else(|| json!([]));
    Ok(Json(json!({ "channels": channels })))
}

pub async fn list_slack_users(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let users = doc.get("slackUsers").cloned().unwrap_or_else(|| json!([]));
    Ok(Json(json!({ "users": users })))
}

// ---------------------------------------------------------------------------
// Telegram Integration Config
// ---------------------------------------------------------------------------

pub async fn get_telegram_config(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let creds = credentials::list_metadata(&state).await.unwrap_or_default();
    let has_token = creds.iter().any(|c| c.service == "telegram" && c.field == "bot_token");
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let tg_cfg = doc.get("telegram").cloned().unwrap_or_else(|| json!({}));

    Ok(Json(json!({
        "success": true,
        "hasBotToken": has_token,
        "connected": has_token,
        "botUsername": tg_cfg.get("botUsername"),
        "webhookUrl": tg_cfg.get("webhookUrl"),
    })))
}

pub async fn set_telegram_config(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let mut bot_name = None;
    if let Some(bot_token) = body.get("botToken").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        bot_name = Some(verified_bot_name("telegram", "Telegram", bot_token).await?);
        credentials::set(&state, "telegram", "bot_token", bot_token, Some("Telegram Bot Token")).await?;
    }

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut tg = doc.get("telegram").cloned().unwrap_or_else(|| json!({}));
    if !tg.is_object() {
        tg = json!({});
    }
    if let Some(name) = bot_name {
        tg["botUsername"] = json!(name);
    }
    doc["telegram"] = tg;
    write_json(&path, &doc).await?;
    drop(_guard);

    get_telegram_config(State(state), user).await
}

pub async fn delete_telegram_config(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let _ = credentials::delete(&state, "telegram", "bot_token").await;
    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("telegram");
    }
    write_json(&path, &doc).await?;
    drop(_guard);

    get_telegram_config(State(state), user).await
}

// ---------------------------------------------------------------------------
// Discord Integration Config
// ---------------------------------------------------------------------------

pub async fn get_discord_config(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let creds = credentials::list_metadata(&state).await.unwrap_or_default();
    let has_token = creds.iter().any(|c| c.service == "discord_channel" && c.field == "bot_token");
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let dc_cfg = doc.get("discord").cloned().unwrap_or_else(|| json!({}));
    let app_id = dc_cfg.get("applicationId").and_then(Value::as_str).unwrap_or("");
    let invite_url = if !app_id.is_empty() {
        format!("https://discord.com/oauth2/authorize?client_id={app_id}&permissions=277025770560&scope=bot")
    } else {
        "".to_string()
    };

    Ok(Json(json!({
        "success": true,
        "hasBotToken": has_token,
        "connected": has_token,
        "botUsername": dc_cfg.get("botUsername"),
        "applicationId": app_id,
        "inviteUrl": invite_url,
    })))
}

pub async fn set_discord_config(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let mut bot_name = None;
    if let Some(bot_token) = body.get("botToken").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        bot_name = Some(verified_bot_name("discord", "Discord", bot_token).await?);
        credentials::set(&state, "discord_channel", "bot_token", bot_token, Some("Discord Bot Token")).await?;
    }

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    let mut dc = doc.get("discord").cloned().unwrap_or_else(|| json!({}));
    if !dc.is_object() {
        dc = json!({});
    }
    if let Some(app_id) = body.get("applicationId").and_then(Value::as_str) {
        dc["applicationId"] = json!(app_id);
    }
    if let Some(name) = bot_name {
        dc["botUsername"] = json!(name);
    }
    doc["discord"] = dc;
    write_json(&path, &doc).await?;
    drop(_guard);

    get_discord_config(State(state), user).await
}

pub async fn delete_discord_config(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let _ = credentials::delete(&state, "discord_channel", "bot_token").await;
    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("discord");
    }
    write_json(&path, &doc).await?;
    drop(_guard);

    get_discord_config(State(state), user).await
}

// ---------------------------------------------------------------------------
// Twilio Integration Config
// ---------------------------------------------------------------------------

pub async fn get_twilio_credentials(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let creds = credentials::list_metadata(&state).await.unwrap_or_default();
    let has_sid = creds.iter().any(|c| c.service == "twilio" && c.field == "account_sid");
    let has_token = creds.iter().any(|c| c.service == "twilio" && c.field == "auth_token");
    let doc = read_json(&channels_path(&state), json!({})).await.unwrap_or_else(|_| json!({}));
    let twilio = doc.get("twilio").cloned().unwrap_or_else(|| json!({}));

    Ok(Json(json!({
        "success": true,
        "hasCredentials": has_sid && has_token,
        "phoneNumber": twilio.get("phoneNumber"),
    })))
}

pub async fn set_twilio_credentials(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let sid = body.get("accountSid").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "accountSid is required".into())
    })?;
    let token = body.get("authToken").and_then(Value::as_str).ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "authToken is required".into())
    })?;

    credentials::set(&state, "twilio", "account_sid", sid, Some("Twilio Account SID")).await?;
    credentials::set(&state, "twilio", "auth_token", token, Some("Twilio Auth Token")).await?;

    if let Some(phone) = body.get("phoneNumber").and_then(Value::as_str) {
        let _guard = state.store.lock().await;
        let path = channels_path(&state);
        let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
        let mut tw = doc.get("twilio").cloned().unwrap_or_else(|| json!({}));
        if !tw.is_object() {
            tw = json!({});
        }
        tw["phoneNumber"] = json!(phone);
        doc["twilio"] = tw;
        write_json(&path, &doc).await?;
    }

    Ok(Json(json!({ "success": true, "hasCredentials": true })))
}

pub async fn delete_twilio_credentials(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let _ = credentials::delete(&state, "twilio", "account_sid").await;
    let _ = credentials::delete(&state, "twilio", "auth_token").await;

    let _guard = state.store.lock().await;
    let path = channels_path(&state);
    let mut doc = read_json(&path, json!({})).await.unwrap_or_else(|_| json!({}));
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("twilio");
    }
    write_json(&path, &doc).await?;

    Ok(Json(json!({ "success": true, "hasCredentials": false })))
}
