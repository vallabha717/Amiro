//! Slack adapter: `auth.test` (verify) + `conversations.open` +
//! `chat.postMessage` (deliver), all bearer-authenticated.
//!
//! The token lives in the vault (`notify.slack/bot_token`); the destination
//! (a channel id like `C…` or a user id like `U…` to DM) lives in the
//! binding. Thread pairing reuses `thread_ts`: follow-ups for the same
//! source post as threaded replies.

use serde_json::{json, Value};

use crate::notify::adapters::http;
use crate::state::ApiError;
use axum::http::StatusCode;

pub const PRODUCTION_BASE: &str = "https://slack.com/api";
/// Test seam: when set, all Slack calls go here instead.
pub const BASE_ENV: &str = "AMIRO_NOTIFY_SLACK_BASE_URL";

fn base() -> String {
    http::base_url(BASE_ENV, PRODUCTION_BASE)
}

fn auth(token: &str) -> String {
    format!("Bearer {token}")
}

/// Outcome of a send: the channel plus `thread_ts` root for pairing.
#[derive(Debug, Clone, Default)]
pub struct SendOutcome {
    pub channel: Option<String>,
    pub thread_ts: Option<String>,
}

fn check_ok(body: &Value, what: &str) -> Result<(), ApiError> {
    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(());
    }
    let error = body
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown_error");
    let status = if matches!(error, "invalid_auth" | "token_revoked" | "account_inactive") {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::BAD_GATEWAY
    };
    Err(ApiError(status, format!("slack {what} failed: {error}")))
}

/// Verify the token with `auth.test`. Returns the authed team/user label.
pub async fn verify(token: &str) -> Result<String, ApiError> {
    if token.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "slack bot token is required".to_string(),
        ));
    }
    let url = format!("{}/auth.test", base());
    let body = http::post_json(&url, &[("authorization", &auth(token))], &json!({})).await?;
    check_ok(&body, "verify")?;
    let team = body.get("team").and_then(|v| v.as_str()).unwrap_or("");
    let user = body.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let label = format!("{team}/{user}").trim_matches('/').to_string();
    Ok(if label.is_empty() {
        "slack".to_string()
    } else {
        label
    })
}

/// Open (or reuse) the DM channel for `destination`, then post. A
/// destination that already looks like a channel id (`C…`/`G…`/`D…`) is
/// posted to directly; anything else is treated as a user id and opened
/// with `conversations.open` first. `thread_hint` posts as a threaded
/// reply when present.
pub async fn send(
    token: &str,
    destination: &str,
    title: &str,
    body_text: &str,
    thread_hint: Option<&str>,
) -> Result<SendOutcome, ApiError> {
    if token.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "slack bot token is required".to_string(),
        ));
    }
    if destination.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "slack destination is required (bind the channel first)".to_string(),
        ));
    }
    let text = if title.trim().is_empty() {
        body_text.to_string()
    } else if body_text.trim().is_empty() {
        title.to_string()
    } else {
        format!("*{title}*\n{body_text}")
    };

    let channel = if destination.starts_with('C')
        || destination.starts_with('G')
        || destination.starts_with('D')
    {
        destination.to_string()
    } else {
        let open_url = format!("{}/conversations.open", base());
        let opened = http::post_json(
            &open_url,
            &[("authorization", &auth(token))],
            &json!({ "users": destination }),
        )
        .await?;
        check_ok(&opened, "conversations.open")?;
        opened
            .pointer("/channel/id")
            .and_then(|v| v.as_str())
            .unwrap_or(destination)
            .to_string()
    };

    let mut payload = json!({ "channel": channel, "text": text });
    if let Some(thread) = thread_hint.filter(|t| !t.trim().is_empty()) {
        payload["thread_ts"] = json!(thread);
    }
    let post_url = format!("{}/chat.postMessage", base());
    let posted = http::post_json(&post_url, &[("authorization", &auth(token))], &payload).await?;
    check_ok(&posted, "chat.postMessage")?;
    let ts = posted
        .get("ts")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    // The first message's ts becomes the thread root; replies reuse the hint.
    let thread_ts = thread_hint
        .filter(|t| !t.trim().is_empty())
        .map(str::to_string)
        .or(ts.clone());
    Ok(SendOutcome {
        channel: Some(channel),
        thread_ts,
    })
}
