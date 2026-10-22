//! External notification delivery (Telegram, Slack, Discord), the Vellum way:
//! the bot comes from Channels, the recipient is the guardian's verified
//! address in Contacts, and nothing here stores a token or a chat id of its
//! own. See `notify/destinations.rs` for the resolution rules.
//!
//! Routes: `GET /api/notifications/channels` (readiness of each channel, never
//! a secret) and `POST /api/notifications/channels/resend`. The agent tools
//! in `agent_mcp.rs` call the same functions.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::notify::adapters::{discord, pairing, slack, telegram};
use crate::notify::destinations::{self, Destination};
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

fn label(channel: &str) -> &'static str {
    match channel {
        "telegram" => "Telegram",
        "slack" => "Slack",
        "discord" => "Discord",
        _ => "That channel",
    }
}

fn check_channel(channel: &str) -> Result<String, ApiError> {
    let channel = channel.trim().to_lowercase();
    if destinations::EXTERNAL_CHANNELS.contains(&channel.as_str()) {
        Ok(channel)
    } else {
        Err(bad_request(format!(
            "unknown notification channel: {channel} (expected telegram, slack or discord)"
        )))
    }
}

/// Check a bot token with its provider and return the bot's display name.
/// A rejected token surfaces as 401. Channels calls this before saving a bot.
pub(crate) async fn verify_bot(channel: &str, token: &str) -> Result<String, ApiError> {
    match channel {
        "telegram" => telegram::verify(token).await,
        "slack" => slack::verify(token).await,
        "discord" => discord::verify(token).await,
        _ => Err(bad_request(format!("{channel} has no bot to verify"))),
    }
}

/// Send one message with `token` to `endpoint` on `channel`. Returns the
/// external thread the provider produced, if any. Used for notifications and
/// for Contacts' verification codes alike.
pub(crate) async fn send_raw(
    channel: &str,
    token: &str,
    endpoint: &str,
    title: &str,
    body_text: &str,
    thread_hint: Option<&str>,
) -> Result<Option<String>, ApiError> {
    match channel {
        "telegram" => {
            telegram::send(token, endpoint, title, body_text, thread_hint).await?;
            Ok(None)
        }
        "slack" => Ok(slack::send(token, endpoint, title, body_text, thread_hint)
            .await?
            .thread_ts),
        "discord" => Ok(discord::send(token, endpoint, title, body_text, thread_hint)
            .await?
            .channel_id),
        _ => Err(bad_request(format!("{channel} cannot send messages"))),
    }
}

/// Deliver to one resolved destination, reusing (and recording) the thread
/// this source already lives in there.
pub(crate) async fn deliver_to(
    state: &AppState,
    user_id: &str,
    destination: &Destination,
    title: &str,
    body_text: &str,
    source_context_id: &str,
) -> Result<(), ApiError> {
    let token = destinations::bot_token(state, destination.channel)
        .await?
        .ok_or_else(|| {
            bad_request(format!(
                "{} has no bot connected. Connect one on the Channels page.",
                label(destination.channel)
            ))
        })?;
    let hint = pairing::get_thread(
        state,
        user_id,
        destination.channel,
        &destination.endpoint,
        source_context_id,
    )
    .await?;
    let thread = send_raw(
        destination.channel,
        &token,
        &destination.endpoint,
        title,
        body_text,
        hint.as_deref(),
    )
    .await?;
    if let Some(thread) = thread {
        pairing::save_thread(
            state,
            user_id,
            destination.channel,
            &destination.endpoint,
            source_context_id,
            &thread,
        )
        .await?;
    }
    Ok(())
}

/// Deliver to `channel` if it is ready for this user, or explain what is
/// missing (no bot in Channels, no verified address in Contacts).
pub(crate) async fn deliver(
    state: &AppState,
    user_id: &str,
    channel: &str,
    title: &str,
    body_text: &str,
    source_context_id: &str,
) -> Result<(), ApiError> {
    let found = destinations::resolve(state, user_id)
        .await?
        .into_iter()
        .find(|d| d.channel == channel);
    match found {
        Some(destination) => {
            deliver_to(state, user_id, &destination, title, body_text, source_context_id).await
        }
        None => Err(bad_request(format!(
            "{} is not ready for notifications: connect its bot on the Channels page and verify your {} account on your contact card in Contacts.",
            label(channel),
            label(channel)
        ))),
    }
}

/// Readiness of every external channel (shared by the route and the
/// `notify_channel_list` tool). Metadata only.
pub async fn list_channels(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    destinations::statuses(state, user_id).await
}

/// Re-send an already-recorded delivery to one external channel: reloads the
/// source event's copy, delivers to the guardian's current address, and
/// records a new delivery row. Shared by the route and the
/// `notify_channel_resend` agent tool.
pub async fn resend_to_channel(
    state: &AppState,
    user_id: &str,
    delivery_id: &str,
    channel: &str,
) -> Result<Value, ApiError> {
    let channel = check_channel(channel)?;
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
    let (status, error) =
        match deliver(state, user_id, &channel, title, body_text, source_context_id).await {
            Ok(()) => ("sent", None),
            Err(error) => ("failed", Some(error.1)),
        };
    store::record_delivery(
        state,
        user_id,
        &new_delivery_id,
        signal_id,
        &channel,
        status,
        error.clone(),
    )
    .await?;
    Ok(json!({
        "deliveryId": new_delivery_id,
        "channel": channel,
        "status": status,
        "error": error,
    }))
}

async fn list_handler(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(list_channels(&state, &user_id_of(&user)).await?))
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
        .route("/api/notifications/channels/resend", post(resend_handler))
}
