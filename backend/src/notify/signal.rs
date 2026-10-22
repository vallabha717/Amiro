//! Notification signals: the flexible input producers send. Mirrors Vellum's
//! `NotificationSignal` — free-form event names with structured attention
//! hints — adapted to Amiro's feed categories and `normal` urgency.

use axum::http::StatusCode;
use serde_json::Value;

use crate::state::ApiError;

/// Where the event originated. Same registry as Vellum's source channels.
pub const SOURCE_CHANNELS: [&str; 14] = [
    "assistant_tool",
    "vellum",
    "phone",
    "telegram",
    "whatsapp",
    "slack",
    "email",
    "platform",
    "a2a",
    "discord",
    "plugin",
    "vellum-shared",
    "scheduler",
    "watcher",
];

/// Known event names. Unknown names are accepted (Vellum treats the registry
/// as documentation) but known ones drive category mapping and copy.
pub const SOURCE_EVENT_NAMES: [&str; 18] = [
    "assistant.share",
    "schedule.notify",
    "schedule.result",
    "schedule.definition_error",
    "schedule.declared",
    "schedule.definition_changed",
    "guardian.question",
    "guardian.channel_activation",
    "ingress.access_request",
    "ingress.access_request.callback_handoff",
    "ingress.trusted_contact.guardian_decision",
    "ingress.trusted_contact.verification_sent",
    "ingress.trusted_contact.activated",
    "watcher.notification",
    "activity.complete",
    "activity.failed",
    "credential.health_alert",
    "chat.assistant_reply",
];

/// Amiro urgencies. `medium` is accepted on input as an alias for `normal`
/// (Vellum's spelling) and never persisted.
pub const URGENCIES: [&str; 4] = ["low", "normal", "high", "critical"];

/// Validated signal from a producer.
#[derive(Debug, Clone)]
pub struct NotificationSignal {
    pub signal_id: String,
    pub created_at: String,
    pub source_channel: String,
    pub source_context_id: String,
    pub source_event_name: String,
    pub title: String,
    pub body: String,
    pub urgency: String,
    pub requires_action: bool,
    pub is_async_background: bool,
    pub visible_in_source_now: bool,
    pub quiet: bool,
    pub dedupe_key: Option<String>,
    pub routing_intent: String,
    pub thread_id: Option<String>,
    pub schedule_id: Option<String>,
}

/// `medium` (Vellum) maps to `normal` (Amiro). Anything else unknown is a 400.
pub fn normalize_urgency(raw: &str) -> Result<String, ApiError> {
    if raw == "medium" {
        return Ok("normal".to_string());
    }
    if URGENCIES.contains(&raw) {
        return Ok(raw.to_string());
    }
    Err(ApiError(
        StatusCode::BAD_REQUEST,
        format!("unknown notification urgency: {raw}"),
    ))
}

/// Feed category derived from the event name. Unknown events are `system`.
pub fn category_for_event(event: &str) -> &'static str {
    if event == "chat.assistant_reply" {
        "chat_reply"
    } else if event == "schedule.result" || event == "schedule.notify" {
        "schedule_result"
    } else if event.starts_with("guardian.") {
        "approval"
    } else if event.starts_with("heartbeat.") {
        "heartbeat"
    } else {
        "system"
    }
}

fn opt_str(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

fn req_str(body: &Value, key: &str) -> Result<String, ApiError> {
    opt_str(body, key).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("notification signal requires '{key}'"),
        )
    })
}

/// Validate raw caller input into a signal. Never panics on missing fields.
pub fn parse_signal(body: &Value) -> Result<NotificationSignal, ApiError> {
    let source_channel = req_str(body, "sourceChannel")?;
    if !SOURCE_CHANNELS.contains(&source_channel.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown notification source channel: {source_channel}"),
        ));
    }
    let urgency_raw = body
        .get("urgency")
        .and_then(|v| v.as_str())
        .unwrap_or("normal");
    let hints = body.get("attentionHints").cloned().unwrap_or(Value::Null);
    let hint_urgency = hints.get("urgency").and_then(|v| v.as_str());
    let urgency = normalize_urgency(hint_urgency.unwrap_or(urgency_raw))?;
    let bool_hint = |key: &str| hints.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(NotificationSignal {
        signal_id: opt_str(body, "signalId").unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        created_at: opt_str(body, "createdAt").unwrap_or_else(crate::state::now_iso),
        source_channel,
        source_context_id: opt_str(body, "sourceContextId").unwrap_or_default(),
        source_event_name: opt_str(body, "sourceEventName").unwrap_or("system.notification".into()),
        title: opt_str(body, "title").unwrap_or_else(|| "Notification".into()),
        body: body
            .get("body")
            .or_else(|| body.get("summary"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        urgency,
        requires_action: bool_hint("requiresAction"),
        is_async_background: bool_hint("isAsyncBackground"),
        visible_in_source_now: bool_hint("visibleInSourceNow"),
        quiet: body.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false),
        dedupe_key: opt_str(body, "dedupeKey"),
        routing_intent: opt_str(body, "routingIntent").unwrap_or("single_channel".into()),
        thread_id: opt_str(body, "threadId"),
        schedule_id: opt_str(body, "scheduleId"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signal_body() -> Value {
        json!({
            "sourceChannel": "scheduler",
            "sourceEventName": "schedule.result",
            "title": "Nightly backup",
            "body": "Backup finished.",
            "urgency": "high",
        })
    }

    #[test]
    fn parses_a_valid_signal() {
        let signal = parse_signal(&signal_body()).unwrap();
        assert_eq!(signal.source_channel, "scheduler");
        assert_eq!(signal.urgency, "high");
        assert!(!signal.signal_id.is_empty());
    }

    #[test]
    fn rejects_an_unknown_source_channel() {
        let mut body = signal_body();
        body["sourceChannel"] = json!("pigeon");
        let err = parse_signal(&body).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn rejects_an_unknown_urgency() {
        let mut body = signal_body();
        body["urgency"] = json!("extreme");
        let err = parse_signal(&body).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn medium_maps_to_normal() {
        assert_eq!(normalize_urgency("medium").unwrap(), "normal");
    }

    #[test]
    fn maps_events_to_categories() {
        assert_eq!(category_for_event("chat.assistant_reply"), "chat_reply");
        assert_eq!(category_for_event("schedule.result"), "schedule_result");
        assert_eq!(category_for_event("guardian.question"), "approval");
        assert_eq!(category_for_event("heartbeat.message"), "heartbeat");
        assert_eq!(category_for_event("something.else"), "system");
    }
}
