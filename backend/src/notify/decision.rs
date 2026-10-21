//! The deterministic routing decision. This is the fallback Vellum keeps
//! behind its LLM engine — and in Phase 00 it is the whole engine. Phase 01
//! adds the model call in front of `decide_deterministic` without changing
//! its contract.

use serde_json::Value;

use crate::notify::signal::{category_for_event, NotificationSignal};

/// Routing decision for one signal.
#[derive(Debug, Clone)]
pub struct Decision {
    pub should_notify: bool,
    pub channels: Vec<String>,
    pub silent: bool,
    pub title: String,
    pub body: String,
    pub fallback_used: bool,
    pub reasoning: String,
}

fn bool_setting(settings: &Value, key: &str, fallback: bool) -> bool {
    settings
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback)
}

/// Vellum's `isLocalNotificationSilent`, ported to Amiro's settings keys:
/// an explicit quiet payload or a disabled category forces silence; the
/// global `allAlertsEnabled` lets everything through; otherwise only the
/// known audible categories and high/critical urgencies banner.
pub fn resolve_silent(settings: &Value, category: &str, urgency: &str, quiet: bool) -> bool {
    if quiet {
        return true;
    }
    if !bool_setting(settings, "enabled", true) {
        return true;
    }
    let category_on = match category {
        "chat_reply" => bool_setting(settings, "chatReplyAlerts", true),
        "schedule_result" => bool_setting(settings, "scheduleAlerts", true),
        "heartbeat" => bool_setting(settings, "heartbeatAlerts", true),
        _ => true,
    };
    if !category_on {
        return true;
    }
    if bool_setting(settings, "allAlertsEnabled", true) {
        return false;
    }
    let audible_category = matches!(
        category,
        "chat_reply" | "schedule_result" | "heartbeat" | "approval"
    );
    !(audible_category || urgency == "high" || urgency == "critical")
}

/// Decide routing for a signal with no model involved. The local channel is
/// always selected (the feed is the inbox); `silent` controls the banner.
pub fn decide_deterministic(signal: &NotificationSignal, settings: &Value) -> Decision {
    let category = category_for_event(&signal.source_event_name);
    let silent = resolve_silent(settings, category, &signal.urgency, signal.quiet);
    Decision {
        should_notify: true,
        channels: vec!["local".to_string()],
        silent,
        title: signal.title.clone(),
        body: signal.body.clone(),
        fallback_used: true,
        reasoning: format!(
            "deterministic: category={category} urgency={} silent={silent}",
            signal.urgency
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::signal::parse_signal;
    use serde_json::json;

    fn settings() -> Value {
        json!({
            "enabled": true,
            "allAlertsEnabled": false,
            "chatReplyAlerts": true,
            "scheduleAlerts": true,
            "heartbeatAlerts": true,
        })
    }

    fn signal_for(event: &str, urgency: &str) -> NotificationSignal {
        parse_signal(&json!({
            "sourceChannel": "scheduler",
            "sourceEventName": event,
            "title": "T",
            "body": "B",
            "urgency": urgency,
        }))
        .unwrap()
    }

    #[test]
    fn high_urgency_banners_without_all_alerts() {
        let decision = decide_deterministic(&signal_for("schedule.result", "high"), &settings());
        assert!(decision.should_notify);
        assert_eq!(decision.channels, vec!["local".to_string()]);
        assert!(!decision.silent);
    }

    #[test]
    fn low_system_signal_stays_silent() {
        let decision =
            decide_deterministic(&signal_for("watcher.notification", "low"), &settings());
        assert!(decision.silent);
        // Silent still reaches the feed.
        assert!(decision.should_notify);
    }

    #[test]
    fn quiet_payload_forces_silence() {
        let mut signal = signal_for("chat.assistant_reply", "critical");
        signal.quiet = true;
        let decision = decide_deterministic(&signal, &settings());
        assert!(decision.silent);
    }

    #[test]
    fn disabled_category_forces_silence() {
        let mut settings = settings();
        settings["chatReplyAlerts"] = json!(false);
        let decision =
            decide_deterministic(&signal_for("chat.assistant_reply", "normal"), &settings);
        assert!(decision.silent);
    }
}
