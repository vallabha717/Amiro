//! Where an external notification goes. Vellum's `destination-resolver.ts`,
//! ported onto Amiro's Channels and Contacts:
//!
//! - **Channels** own the transport: the bot each channel sends with
//!   (`telegram/bot_token`, `slack_channel/bot_token`,
//!   `discord_channel/bot_token` in the vault, set up on the Channels page).
//! - **Contacts** own the recipient: the guardian contact's verified address
//!   on each channel (its Telegram chat, Slack DM, Discord user).
//!
//! A channel is deliverable only when both exist. Notifications never keep
//! tokens or chat ids of their own. External delivery is for the guardian
//! alone: a notification for any other user stays in the app, so one
//! member's alerts never land in the owner's Telegram.

use serde_json::{json, Value};

use crate::state::{read_json, ApiError, AppState};

/// Channels with an external notification adapter, in display order.
pub const EXTERNAL_CHANNELS: [&str; 3] = ["telegram", "slack", "discord"];

/// The vault service holding a channel's bot token (owned by Channels).
pub fn bot_service(channel: &str) -> Option<&'static str> {
    match channel {
        "telegram" => Some("telegram"),
        "slack" => Some("slack_channel"),
        "discord" => Some("discord_channel"),
        _ => None,
    }
}

/// The vault field for every bot token.
pub const BOT_FIELD: &str = "bot_token";

/// One resolved external destination, ready for its adapter.
#[derive(Debug, Clone)]
pub struct Destination {
    pub channel: &'static str,
    /// What the adapter sends to: Telegram chat id, Slack DM channel or user
    /// id, Discord user id.
    pub endpoint: String,
    /// The guardian's address on the channel, as shown in Contacts.
    pub address: String,
}

/// Whether `user_id` is the instance owner (Vellum's guardian).
pub async fn is_owner(state: &AppState, user_id: &str) -> bool {
    let users = read_json(&state.home.join("users.json"), json!({ "users": [] }))
        .await
        .unwrap_or_else(|_| json!({ "users": [] }));
    users["users"].as_array().is_some_and(|list| {
        list.iter().any(|u| {
            u.get("id").and_then(Value::as_str) == Some(user_id)
                && u.get("role").and_then(Value::as_str) == Some("admin")
        })
    })
}

/// The bot token Channels stored for `channel`, if any.
pub async fn bot_token(state: &AppState, channel: &str) -> Result<Option<String>, ApiError> {
    let Some(service) = bot_service(channel) else {
        return Ok(None);
    };
    Ok(crate::credentials::get_plaintext(state, service, BOT_FIELD)
        .await?
        .map(|secret| secret.expose().to_string())
        .filter(|token| !token.trim().is_empty()))
}

/// The bot's display name recorded by Channels when its token was verified.
async fn bot_name(state: &AppState, channel: &str) -> Option<String> {
    let doc = read_json(&state.home.join("store").join("channels.json"), json!({}))
        .await
        .ok()?;
    doc.get(channel)?
        .get("botUsername")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn is_verified(record: &Value) -> bool {
    matches!(
        record.get("status").and_then(Value::as_str),
        Some("active") | Some("verified")
    )
}

/// The guardian's records for one channel type: verified first, then the
/// primary one. Revoked and blocked records never deliver.
async fn guardian_records(state: &AppState, channel: &str) -> Vec<Value> {
    let doc = read_json(&state.home.join("store").join("contacts.json"), json!({}))
        .await
        .unwrap_or_else(|_| json!({}));
    let mut records: Vec<Value> = doc
        .get("contacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("role").and_then(Value::as_str) == Some("guardian"))
        .flat_map(|c| c.get("channels").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter(|ch| ch.get("type").and_then(Value::as_str) == Some(channel))
        .filter(|ch| {
            !matches!(
                ch.get("status").and_then(Value::as_str),
                Some("revoked") | Some("blocked")
            )
        })
        .collect();
    records.sort_by_key(|ch| {
        (
            !is_verified(ch),
            !ch.get("isPrimary").and_then(Value::as_bool).unwrap_or(false),
        )
    });
    records
}

/// What the adapter sends to for one contact channel record. Slack is
/// restricted to direct messages, as in Vellum: a `C…`/`G…` id is a shared
/// channel and is never a notification destination.
pub fn endpoint_for(channel: &str, record: &Value) -> Option<String> {
    let text = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let address = text("address");
    let chat = text("externalChatId");
    match channel {
        // A bot's DM with a user has the user's numeric id as its chat id; a
        // bot cannot message a person by @username.
        "telegram" => chat.or(address).filter(|id| {
            let digits = id.strip_prefix('-').unwrap_or(id);
            !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
        }),
        "slack" => match chat {
            Some(dm) if dm.starts_with('D') => Some(dm),
            _ => address.filter(|a| a.starts_with('U') || a.starts_with('W')),
        },
        "discord" => text("externalUserId").or(address),
        _ => None,
    }
}

/// Every channel a notification for `user_id` can go out on right now.
pub async fn resolve(state: &AppState, user_id: &str) -> Result<Vec<Destination>, ApiError> {
    if !is_owner(state, user_id).await {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for channel in EXTERNAL_CHANNELS {
        if bot_token(state, channel).await?.is_none() {
            continue;
        }
        let Some(record) = guardian_records(state, channel)
            .await
            .into_iter()
            .find(is_verified)
        else {
            continue;
        };
        let Some(endpoint) = endpoint_for(channel, &record) else {
            continue;
        };
        out.push(Destination {
            channel,
            endpoint,
            address: record
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

/// Readiness of every external channel for the Notifications page and the
/// `notify_channel_list` tool: is the bot set up, is the guardian's address
/// known and verified, and so will notifications go there. Never a secret.
pub async fn statuses(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let owner = is_owner(state, user_id).await;
    let mut rows = Vec::new();
    for channel in EXTERNAL_CHANNELS {
        let bot_configured = bot_token(state, channel).await?.is_some();
        let records = guardian_records(state, channel).await;
        let record = records.first();
        let verified = record.is_some_and(is_verified);
        let endpoint = record.and_then(|r| endpoint_for(channel, r));
        let ready = owner && bot_configured && verified && endpoint.is_some();
        let next_step = if !owner {
            "owner_only"
        } else if !bot_configured {
            "connect_bot"
        } else if record.is_none() {
            "add_address"
        } else if !verified {
            "verify_address"
        } else if endpoint.is_none() {
            "fix_address"
        } else {
            "ready"
        };
        rows.push(json!({
            "channel": channel,
            "botConfigured": bot_configured,
            "botName": bot_name(state, channel).await,
            "address": record.and_then(|r| r.get("address")).cloned().unwrap_or(Value::Null),
            "contactChannelId": record.and_then(|r| r.get("id")).cloned().unwrap_or(Value::Null),
            "verified": verified,
            "ready": ready,
            "nextStep": next_step,
        }));
    }
    Ok(json!({ "channels": rows }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telegram_prefers_the_chat_id_and_falls_back_to_the_user_id() {
        let both = json!({ "address": "42", "externalChatId": "-100777" });
        assert_eq!(endpoint_for("telegram", &both).as_deref(), Some("-100777"));
        let user = json!({ "address": "42" });
        assert_eq!(endpoint_for("telegram", &user).as_deref(), Some("42"));
        assert_eq!(endpoint_for("telegram", &json!({ "address": " " })), None);
        // A bot cannot start a DM by @username.
        assert_eq!(endpoint_for("telegram", &json!({ "address": "@bob" })), None);
    }

    #[test]
    fn slack_only_ever_delivers_to_a_direct_message() {
        let dm = json!({ "address": "U1", "externalChatId": "D9" });
        assert_eq!(endpoint_for("slack", &dm).as_deref(), Some("D9"));
        let user = json!({ "address": "U1" });
        assert_eq!(endpoint_for("slack", &user).as_deref(), Some("U1"));
        let shared = json!({ "address": "C123", "externalChatId": "C123" });
        assert_eq!(endpoint_for("slack", &shared), None);
    }

    #[test]
    fn discord_sends_to_the_user() {
        let record = json!({ "address": "1234" });
        assert_eq!(endpoint_for("discord", &record).as_deref(), Some("1234"));
        assert_eq!(endpoint_for("email", &record), None);
    }
}
