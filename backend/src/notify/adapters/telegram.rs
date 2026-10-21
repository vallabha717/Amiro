//! Telegram adapter: Bot API `getMe` (verify) + `sendMessage` (deliver).
//!
//! The bot token lives in the vault (`notify.telegram/bot_token`) and is
//! passed to `send`/`verify` already decrypted — this module never touches
//! the vault itself, so it stays unit-testable against a stub server.

use serde_json::json;

use crate::notify::adapters::http;
use crate::state::ApiError;
use axum::http::StatusCode;

pub const PRODUCTION_BASE: &str = "https://api.telegram.org";
/// Test seam: when set, all Telegram calls go here instead.
pub const BASE_ENV: &str = "AMIRO_NOTIFY_TELEGRAM_BASE_URL";

fn base() -> String {
    http::base_url(BASE_ENV, PRODUCTION_BASE)
}

/// Outcome of a send: the message id (unused for threading today — Telegram
/// bot DMs have no threads, so the pairing layer keeps the chat id).
#[derive(Debug, Clone, Default)]
pub struct SendOutcome {
    pub message_id: Option<String>,
}

/// Verify the token with `getMe`. Returns the bot username for display.
pub async fn verify(token: &str) -> Result<String, ApiError> {
    if token.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "telegram bot token is required".to_string(),
        ));
    }
    let url = format!("{}/bot{}/getMe", base(), token);
    let body = http::get_json(&url, &[]).await?;
    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            format!(
                "telegram rejected the token: {}",
                body.get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error")
            ),
        ));
    }
    let name = body
        .pointer("/result/username")
        .or_else(|| body.pointer("/result/first_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("telegram-bot")
        .to_string();
    Ok(name)
}

/// Deliver one message to the bound chat. `thread_hint` is accepted for the
/// common adapter signature but unused: bot DMs carry no thread.
pub async fn send(
    token: &str,
    chat_id: &str,
    title: &str,
    body_text: &str,
    _thread_hint: Option<&str>,
) -> Result<SendOutcome, ApiError> {
    if token.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "telegram bot token is required".to_string(),
        ));
    }
    if chat_id.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "telegram chat id is required (bind the channel first)".to_string(),
        ));
    }
    let text = if title.trim().is_empty() {
        body_text.to_string()
    } else if body_text.trim().is_empty() {
        title.to_string()
    } else {
        format!("{title}\n{body_text}")
    };
    let url = format!("{}/bot{}/sendMessage", base(), token);
    let response = http::post_json(&url, &[], &json!({ "chat_id": chat_id, "text": text })).await?;
    if !response
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            format!(
                "telegram send failed: {}",
                response
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error")
            ),
        ));
    }
    Ok(SendOutcome {
        message_id: response
            .pointer("/result/message_id")
            .map(|v| v.to_string()),
    })
}

/// Build the display name recorded on the binding after a successful verify.
pub fn display_name(raw: &str) -> String {
    raw.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_trims_whitespace() {
        assert_eq!(display_name("  Amiro Bot\n"), "Amiro Bot");
    }
}
