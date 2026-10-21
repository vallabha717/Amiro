//! Discord adapter: `GET /users/@me` (verify) + DM channel create +
//! message create (deliver), all `Bot`-authenticated.
//!
//! The token lives in the vault (`notify.discord/bot_token`); the DM
//! recipient (a user id) lives in the binding, and the created DM channel
//! id is the pairing layer's thread value.

use serde_json::json;

use crate::notify::adapters::http;
use crate::state::ApiError;
use axum::http::StatusCode;

pub const PRODUCTION_BASE: &str = "https://discord.com/api/v10";
/// Test seam: when set, all Discord calls go here instead.
pub const BASE_ENV: &str = "AMIRO_NOTIFY_DISCORD_BASE_URL";

fn base() -> String {
    http::base_url(BASE_ENV, PRODUCTION_BASE)
}

fn auth(token: &str) -> String {
    format!("Bot {token}")
}

/// Outcome of a send: the DM channel id for pairing.
#[derive(Debug, Clone, Default)]
pub struct SendOutcome {
    pub channel_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_uses_bot_scheme() {
        assert_eq!(auth("tok"), "Bot tok");
    }
}

/// Verify the token with `GET /users/@me`. Returns `username` for display.
pub async fn verify(token: &str) -> Result<String, ApiError> {
    if token.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "discord bot token is required".to_string(),
        ));
    }
    let url = format!("{}/users/@me", base());
    let body = http::get_json(&url, &[("authorization", &auth(token))]).await?;
    Ok(body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("discord-bot")
        .to_string())
}

/// Deliver one message: create (or reuse) the recipient DM channel, then
/// post. `thread_hint` reuses a known DM channel id and skips creation.
pub async fn send(
    token: &str,
    recipient_id: &str,
    title: &str,
    body_text: &str,
    thread_hint: Option<&str>,
) -> Result<SendOutcome, ApiError> {
    if token.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "discord bot token is required".to_string(),
        ));
    }
    if recipient_id.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "discord recipient id is required (bind the channel first)".to_string(),
        ));
    }
    let content = if title.trim().is_empty() {
        body_text.to_string()
    } else if body_text.trim().is_empty() {
        title.to_string()
    } else {
        format!("**{title}**\n{body_text}")
    };

    let channel_id = match thread_hint.filter(|t| !t.trim().is_empty()) {
        Some(known) => known.to_string(),
        None => {
            let url = format!("{}/users/@me/channels", base());
            let created = http::post_json(
                &url,
                &[("authorization", &auth(token))],
                &json!({ "recipient_id": recipient_id }),
            )
            .await?;
            created
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ApiError(
                        StatusCode::BAD_GATEWAY,
                        "discord did not return a DM channel id".to_string(),
                    )
                })?
                .to_string()
        }
    };

    let url = format!("{}/channels/{channel_id}/messages", base());
    http::post_json(
        &url,
        &[("authorization", &auth(token))],
        &json!({ "content": content.chars().take(2000).collect::<String>() }),
    )
    .await?;
    Ok(SendOutcome {
        channel_id: Some(channel_id),
    })
}
