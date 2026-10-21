//! Notification channel routes (Phase 03): bind/verify/unbind/resend for
//! the external adapters (Telegram, Slack, Discord).
//!
//! Tokens live in the credential vault (`notify.<channel>/bot_token`) and
//! never appear in a response, a log line, or `notification-channels.json`.
//! Every response carries metadata only: channel, bound flag, destination
//! id, display name, timestamps. The agent tools in `agent_mcp.rs` call the
//! same `bind_channel` / `unbind_channel` / `list_channels` /
//! `resend_to_channel` functions the routes use.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::notify::adapters::{discord, pairing, slack, telegram};
use crate::notify::store;
use crate::state::{ApiError, AppState, AuthUser};

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

/// Verify a plaintext token against its provider. Returns the display name
/// recorded on the binding. A provider rejection surfaces as 401 so the UI
/// can prompt for a replacement token.
async fn verify_token(channel: &str, token: &str) -> Result<String, ApiError> {
    match channel {
        "telegram" => telegram::verify(token).await,
        "slack" => slack::verify(token).await,
        "discord" => discord::verify(token).await,
        _ => Err(bad_request(format!(
            "unknown notification channel: {channel} (expected telegram, slack or discord)"
        ))),
    }
}

/// Send one message through `channel`. Returns the thread id to pair, if the
/// provider produced one.
pub(crate) async fn deliver(
    state: &AppState,
    user_id: &str,
    channel: &str,
    title: &str,
    body_text: &str,
    source_context_id: &str,
) -> Result<(), ApiError> {
    let binding = pairing::get_binding(state, user_id, channel)
        .await?
        .ok_or_else(|| bad_request(format!("{channel} is not bound (bind the channel first)")))?;
    let service = pairing::vault_service(channel);
    let secret = crate::credentials::get_plaintext(state, &service, pairing::vault_field())
        .await?
        .ok_or_else(|| {
            bad_request(format!(
                "{channel} has no bot token in the vault (save it first)"
            ))
        })?;
    let token = secret.expose().to_string();
    let thread_hint = pairing::get_thread(state, user_id, channel, source_context_id).await?;
    send_with_token(
        state,
        user_id,
        channel,
        &token,
        &binding.chat_id,
        title,
        body_text,
        source_context_id,
        thread_hint.as_deref(),
    )
    .await
}

/// Send with an already-decrypted token (bind-time verify path and the
/// broadcaster share this; neither logs nor returns the token).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_with_token(
    state: &AppState,
    user_id: &str,
    channel: &str,
    token: &str,
    chat_id: &str,
    title: &str,
    body_text: &str,
    source_context_id: &str,
    thread_hint: Option<&str>,
) -> Result<(), ApiError> {
    let paired: Option<String> = match channel {
        "telegram" => {
            telegram::send(token, chat_id, title, body_text, thread_hint).await?;
            // Bot DMs carry no thread: pair on the chat itself so a missing
            // binding is detected rather than re-created per signal.
            Some(chat_id.to_string())
        }
        "slack" => {
            let outcome = slack::send(token, chat_id, title, body_text, thread_hint).await?;
            outcome.thread_ts
        }
        "discord" => {
            let outcome = discord::send(token, chat_id, title, body_text, thread_hint).await?;
            outcome.channel_id
        }
        _ => {
            return Err(bad_request(format!(
                "unknown notification channel: {channel} (expected telegram, slack or discord)"
            )));
        }
    };
    if let Some(thread_id) = paired {
        pairing::save_thread(state, user_id, channel, source_context_id, &thread_id).await?;
    }
    Ok(())
}

fn binding_json(binding: &pairing::Binding, has_token: bool) -> Value {
    json!({
        "channel": binding.channel,
        "bound": true,
        "chatId": binding.chat_id,
        "chatName": binding.chat_name,
        "updatedAt": binding.updated_at,
        "hasToken": has_token,
    })
}

fn unbound_json(channel: &str) -> Value {
    json!({
        "channel": channel,
        "bound": false,
        "chatId": Value::Null,
        "chatName": Value::Null,
        "updatedAt": Value::Null,
        "hasToken": false,
    })
}

/// List every external channel with its binding metadata (never a secret).
/// Shared by the route and the `notify_channel_list` agent tool.
pub async fn list_channels(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let bindings = pairing::list_bindings(state, user_id).await?;
    let mut channels = Vec::new();
    for channel in pairing::EXTERNAL_CHANNELS {
        match bindings.iter().find(|b| b.channel == channel) {
            Some(binding) => {
                let service = pairing::vault_service(channel);
                let has_token =
                    crate::credentials::get_plaintext(state, &service, pairing::vault_field())
                        .await?
                        .is_some();
                channels.push(binding_json(binding, has_token));
            }
            None => channels.push(unbound_json(channel)),
        }
    }
    Ok(json!({ "channels": channels }))
}

/// Bind a channel: store the token in the vault (when supplied), verify it
/// with a `getMe`-style call, then persist the binding. Metadata only in
/// the result. Shared by the route and the `notify_channel_bind` agent tool.
///
/// When no token is supplied and none is in the vault, this returns a 400
/// whose message tells the caller to collect the token through the secure
/// secret card — the agent tool maps that to a SECRET_PROMPT card.
pub async fn bind_channel(
    state: &AppState,
    user_id: &str,
    channel: &str,
    chat_id: &str,
    token: Option<&str>,
) -> Result<Value, ApiError> {
    let channel = channel.trim().to_lowercase();
    if !pairing::is_external_channel(&channel) {
        return Err(bad_request(format!(
            "unknown notification channel: {channel} (expected telegram, slack or discord)"
        )));
    }
    if chat_id.trim().is_empty() {
        return Err(bad_request(format!("{channel} destination id is required")));
    }
    let service = pairing::vault_service(&channel);
    if let Some(provided) = token.map(str::trim).filter(|t| !t.is_empty()) {
        crate::credentials::set(
            state,
            &service,
            pairing::vault_field(),
            provided,
            Some(&format!("{channel} notification bot token")),
        )
        .await?;
    }
    let secret = crate::credentials::get_plaintext(state, &service, pairing::vault_field())
        .await?
        .ok_or_else(|| {
            bad_request(format!(
                "no bot token for {channel} in the vault (service {service}); save it through the secure secret card first"
            ))
        })?;
    let token_value = secret.expose().to_string();
    // Verify before persisting: a bad token must not create a binding.
    let chat_name = verify_token(&channel, &token_value).await?;
    let binding =
        pairing::save_binding(state, user_id, &channel, chat_id, Some(&chat_name)).await?;
    Ok(binding_json(&binding, true))
}

/// Remove a binding (the vault token is kept so a rebind needs no new
/// token). Shared by the route and the `notify_channel_unbind` agent tool.
pub async fn unbind_channel(
    state: &AppState,
    user_id: &str,
    channel: &str,
) -> Result<Value, ApiError> {
    let channel = channel.trim().to_lowercase();
    if !pairing::is_external_channel(&channel) {
        return Err(bad_request(format!(
            "unknown notification channel: {channel} (expected telegram, slack or discord)"
        )));
    }
    pairing::delete_binding(state, user_id, &channel).await?;
    Ok(json!({ "channel": channel, "bound": false }))
}

/// Re-send an already-recorded delivery to one external channel: reloads
/// the source event's copy, delivers through the binding, and records a new
/// delivery row. Shared by the route and the `notify_channel_resend` agent
/// tool.
pub async fn resend_to_channel(
    state: &AppState,
    user_id: &str,
    delivery_id: &str,
    channel: &str,
) -> Result<Value, ApiError> {
    let channel = channel.trim().to_lowercase();
    if !pairing::is_external_channel(&channel) {
        return Err(bad_request(format!(
            "unknown notification channel: {channel} (expected telegram, slack or discord)"
        )));
    }
    if delivery_id.trim().is_empty() {
        return Err(bad_request("deliveryId is required"));
    }
    let rows = store::all_deliveries(state).await?;
    let original = rows
        .iter()
        .find(|row| {
            row.get("deliveryId").and_then(|v| v.as_str()) == Some(delivery_id)
                && row.get("userId").and_then(|v| v.as_str()) == Some(user_id)
        })
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "delivery not found".to_string()))?;
    let signal_id = original
        .get("signalId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let event = store::find_event_by_signal(state, signal_id)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "signal event not found".to_string()))?;
    let title = event
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Notification");
    let body_text = event.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let source_context_id = event
        .get("sourceContextId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let new_delivery_id = uuid::Uuid::new_v4().to_string();
    match deliver(
        state,
        user_id,
        &channel,
        title,
        body_text,
        source_context_id,
    )
    .await
    {
        Ok(()) => {
            store::record_delivery(
                state,
                user_id,
                &new_delivery_id,
                signal_id,
                &channel,
                "sent",
                None,
            )
            .await?;
            Ok(json!({ "deliveryId": new_delivery_id, "channel": channel, "status": "sent" }))
        }
        Err(error) => {
            store::record_delivery(
                state,
                user_id,
                &new_delivery_id,
                signal_id,
                &channel,
                "failed",
                Some(error.1.clone()),
            )
            .await?;
            Ok(
                json!({ "deliveryId": new_delivery_id, "channel": channel, "status": "failed", "error": error.1 }),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP handlers (thin wrappers over the shared functions above)
// ---------------------------------------------------------------------------

async fn list_handler(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(list_channels(&state, &user_id_of(&user)).await?))
}

async fn bind_handler(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel = body.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    let chat_id = body
        .get("chatId")
        .or_else(|| body.get("chat_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let token = body.get("token").and_then(|v| v.as_str());
    let bound = bind_channel(&state, &user_id_of(&user), channel, chat_id, token).await?;
    Ok((StatusCode::OK, Json(bound)))
}

async fn unbind_handler(
    Path(channel): Path<String>,
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        unbind_channel(&state, &user_id_of(&user), &channel).await?,
    ))
}

async fn resend_handler(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let delivery_id = body
        .get("deliveryId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let channel = body.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Json(
        resend_to_channel(&state, &user_id_of(&user), delivery_id, channel).await?,
    ))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/notifications/channels", get(list_handler))
        .route("/api/notifications/channels/bind", post(bind_handler))
        .route(
            "/api/notifications/channels/{channel}",
            delete(unbind_handler),
        )
        .route("/api/notifications/channels/resend", post(resend_handler))
}
