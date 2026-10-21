//! The routing decision: an LLM model path with a deterministic fallback.
//!
//! Phase 01 adds the model call in front of `decide_deterministic` without
//! changing its contract. The model is reached over the same runtime bridge
//! the chat turns use (`runtime::start_turn`): a small JSON-mode turn with no
//! tools, a pinned system prompt (channel/event registries + channel policy),
//! and a strict response schema. Any failure — unreachable bridge, model
//! error, timeout, invalid JSON — falls back to the deterministic rules with
//! `fallback_used: true`.
//!
//! Budgets (from the design): one model call per signal, never per channel;
//! dedupe runs before the model call (in the broadcaster); a signal already
//! silent with a single-channel routing intent skips the model call because
//! there is nothing else to render.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use amiro_sdk::ApiEvent;
use serde_json::Value;

use crate::notify::adapters::ChannelCopy;
use crate::notify::signal::{category_for_event, NotificationSignal};
use crate::state::AppState;

/// How long the decision turn may run before the deterministic fallback wins.
/// Banners must not wait on a slow model.
pub const DECISION_TIMEOUT: Duration = Duration::from_secs(20);

/// Channels the model may select. `local` (the feed/SSE inbox) is the only
/// one with an adapter in Phase 01; external selections are recorded in the
/// decision row and delivered by later phases.
pub const VALID_LLM_CHANNELS: [&str; 4] = ["local", "telegram", "slack", "discord"];

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
    /// Rendered copy per selected channel. The deterministic fallback fills
    /// only `local` (see [`fallback_copy`]).
    pub copies: HashMap<String, ChannelCopy>,
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

/// Fallback copy templates per `sourceEventName` family. The Phase 01
/// baseline renders the signal's own title/body (byte-identical to Phase 00,
/// which the pipeline tests pin); the per-family match is the hook Phase 03
/// customises per channel. Families covered: schedule result/notify, chat
/// reply, heartbeat, and test (`system.test`).
pub fn fallback_copy(signal: &NotificationSignal) -> ChannelCopy {
    let title = signal.title.clone();
    let body = signal.body.clone();
    match signal.source_event_name.as_str() {
        "schedule.result" | "schedule.notify" => ChannelCopy { title, body },
        "chat.assistant_reply" => ChannelCopy { title, body },
        event if event.starts_with("heartbeat.") => ChannelCopy { title, body },
        "system.test" => ChannelCopy { title, body },
        _ => ChannelCopy { title, body },
    }
}

/// Decide routing for a signal with no model involved. The local channel is
/// always selected (the feed is the inbox); `silent` controls the banner.
pub fn decide_deterministic(signal: &NotificationSignal, settings: &Value) -> Decision {
    let category = category_for_event(&signal.source_event_name);
    let silent = resolve_silent(settings, category, &signal.urgency, signal.quiet);
    let copy = fallback_copy(signal);
    Decision {
        should_notify: true,
        channels: vec!["local".to_string()],
        silent,
        title: copy.title.clone(),
        body: copy.body.clone(),
        fallback_used: true,
        reasoning: format!(
            "deterministic: category={category} urgency={} silent={silent}",
            signal.urgency
        ),
        copies: HashMap::from([("local".to_string(), copy)]),
    }
}

/// The user is already looking at the signal's source (the chat the reply
/// landed in), so nothing is delivered. Recorded like any other decision, so
/// the audit shows why a reply never reached the Bell.
pub fn suppressed_source_active(signal: &NotificationSignal) -> Decision {
    let copy = fallback_copy(signal);
    Decision {
        should_notify: false,
        channels: Vec::new(),
        silent: true,
        title: copy.title,
        body: copy.body,
        fallback_used: false,
        reasoning: "suppressed: the user is viewing the source right now".to_string(),
        copies: HashMap::new(),
    }
}

/// Which model the decision turn runs on: `AMIRO_NOTIFY_DECISION_MODEL` when
/// set, else the deployment's chat default (`AMIRO_DEFAULT_MODEL`), else
/// `None` for the runtime's own default. An explicit non-empty override wins
/// over both environment variables.
pub fn resolve_decision_model(explicit: Option<&str>) -> Option<String> {
    let clean = |value: &str| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    if let Some(model) = explicit.and_then(clean) {
        return Some(model);
    }
    for var in ["AMIRO_NOTIFY_DECISION_MODEL", "AMIRO_DEFAULT_MODEL"] {
        if let Some(model) = std::env::var(var).ok().as_deref().and_then(clean) {
            return Some(model);
        }
    }
    None
}

/// See [`resolve_decision_model`]: the configured model with no override.
pub fn decision_model() -> Option<String> {
    resolve_decision_model(None)
}

// ---------------------------------------------------------------------------
// Model path
// ---------------------------------------------------------------------------

/// One decision-turn request: the resolved model (or `None` for the runtime
/// default) and the full JSON-mode prompt (registries + schema + signal).
#[derive(Debug, Clone)]
pub struct ModelCall {
    pub model: Option<String>,
    pub prompt: String,
}

/// Something that can answer one [`ModelCall`] with the raw response text.
/// The live implementation runs a turn over the runtime bridge; tests inject
/// stubs (fixed answers, errors, hangs) without network or provider keys.
pub trait ModelCaller: Send + Sync {
    fn call<'a>(
        &'a self,
        call: ModelCall,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
}

impl<F> ModelCaller for F
where
    F: Fn(ModelCall) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync,
{
    fn call<'a>(
        &'a self,
        call: ModelCall,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        (self)(call)
    }
}

/// The live caller: one JSON-mode turn over the runtime bridge with no tools.
/// Any bridge, turn, or collection failure is an `Err` and the caller falls
/// back to the deterministic decision.
pub struct RuntimeModelCaller {
    pub state: AppState,
    pub working_dir: String,
}

impl ModelCaller for RuntimeModelCaller {
    fn call<'a>(
        &'a self,
        call: ModelCall,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        let state = self.state.clone();
        let working_dir = self.working_dir.clone();
        Box::pin(async move {
            let plan = crate::runtime::TurnPlan {
                session_id: None,
                working_dir,
                expose_tools: false,
                model: call.model,
                prompt: call.prompt,
                images: Vec::new(),
                tool_results: Vec::new(),
                system_reminder: None,
                agent_tools: None,
            };
            let started = crate::runtime::start_turn(state.clone(), plan)
                .await
                .map_err(|error| error.1)?;
            let session = started
                .session
                .await
                .map_err(|_| "decision turn never started".to_string())?
                .map_err(|message| message)?;
            let session_id = session.session_id.clone();
            let mut updates = started.updates;
            let mut text = String::new();
            let outcome = loop {
                match updates.recv().await {
                    None => break Err("runtime closed the decision turn".to_string()),
                    Some(crate::runtime::TurnUpdate::Event(ApiEvent::TextDelta {
                        text: delta,
                        ..
                    })) => text.push_str(&delta),
                    Some(crate::runtime::TurnUpdate::Event(ApiEvent::TextReplace {
                        text: replacement,
                        ..
                    })) => text = replacement,
                    Some(crate::runtime::TurnUpdate::Event(ApiEvent::TextDone { .. })) => {}
                    Some(crate::runtime::TurnUpdate::Event(ApiEvent::Error {
                        message, ..
                    })) => break Err(message),
                    Some(crate::runtime::TurnUpdate::Error(message)) => break Err(message),
                    Some(crate::runtime::TurnUpdate::Done(_)) => break Ok(()),
                    Some(_) => {}
                }
            };
            // Best-effort cleanup of the throwaway session; the turn result is
            // the answer either way.
            let _ = crate::runtime::archive_session(&state, &session_id).await;
            outcome.map(|()| text)
        })
    }
}

/// The pinned JSON-mode prompt: channel/event registries, channel policy, the
/// strict response schema, and the signal under decision.
pub fn decision_prompt(signal: &NotificationSignal) -> String {
    let signal_json = serde_json::json!({
        "sourceChannel": signal.source_channel,
        "sourceContextId": signal.source_context_id,
        "sourceEventName": signal.source_event_name,
        "title": signal.title,
        "body": signal.body,
        "urgency": signal.urgency,
        "requiresAction": signal.requires_action,
        "isAsyncBackground": signal.is_async_background,
        "visibleInSourceNow": signal.visible_in_source_now,
        "quiet": signal.quiet,
        "routingIntent": signal.routing_intent,
        "threadId": signal.thread_id,
        "scheduleId": signal.schedule_id,
    });
    format!(
        "You are Amiro's notification decision engine. Reply with JSON only, \
no markdown fences, no commentary, matching this schema exactly:\n\
{{\"shouldNotify\": boolean, \"selectedChannels\": string[], \
\"copy\": {{\"local\": {{\"title\": string, \"body\": string}}}}, \
\"silent\": boolean, \"dedupeKey\": string (optional), \
\"reasoning\": string}}\n\
\n\
Deliverable channels in this deployment: [\"local\"]. You may also select \
\"telegram\", \"slack\", or \"discord\" when the signal warrants an external \
ping; those selections are recorded and delivered by a later phase, so always \
include copy for \"local\" whenever it is selected.\n\
Known source channels: {:?}.\n\
Known source event names: {:?}.\n\
Channel policy: \"local\" is the in-app feed inbox and is always available. \
Set \"silent\" true when the payload is quiet, the category is routine, or \
the user is already looking at the source (visibleInSourceNow) and the \
urgency is not high or critical. Set \"shouldNotify\" false only for noise \
that should reach no channel at all.\n\
\n\
Signal under decision:\n{}",
        crate::notify::signal::SOURCE_CHANNELS,
        crate::notify::signal::SOURCE_EVENT_NAMES,
        serde_json::to_string_pretty(&signal_json).unwrap_or_default(),
    )
}

/// Strict-parse one model response into a [`Decision`]. `None` means invalid —
/// the caller falls back to the deterministic rules. Required: `shouldNotify`
/// (bool), `selectedChannels` (non-empty when notifying, all known channels),
/// `copy` with a `{title, body}` entry per selected channel, `silent` (bool),
/// `reasoning` (string).
pub fn parse_llm_response(text: &str, signal: &NotificationSignal) -> Option<Decision> {
    let trimmed = strip_fences(text.trim());
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let object = value.as_object()?;
    let should_notify = object.get("shouldNotify")?.as_bool()?;
    let raw_channels = object.get("selectedChannels")?.as_array()?;
    let mut channels = Vec::new();
    for entry in raw_channels {
        let channel = entry.as_str()?;
        if !VALID_LLM_CHANNELS.contains(&channel) {
            return None;
        }
        if !channels.contains(&channel.to_string()) {
            channels.push(channel.to_string());
        }
    }
    if should_notify && channels.is_empty() {
        return None;
    }
    if !should_notify {
        channels.clear();
    }
    let copy_object = object.get("copy").and_then(|v| v.as_object());
    let mut copies = HashMap::new();
    for channel in &channels {
        let entry = copy_object?.get(channel)?;
        copies.insert(
            channel.clone(),
            ChannelCopy {
                title: entry.get("title")?.as_str()?.to_string(),
                body: entry.get("body")?.as_str()?.to_string(),
            },
        );
    }
    let silent = object.get("silent")?.as_bool()?;
    let reasoning = object.get("reasoning")?.as_str()?.to_string();
    let (title, body) = copies
        .get("local")
        .map(|copy| (copy.title.clone(), copy.body.clone()))
        .unwrap_or_else(|| {
            let fallback = fallback_copy(signal);
            (fallback.title, fallback.body)
        });
    Some(Decision {
        should_notify,
        channels,
        silent: if should_notify { silent } else { true },
        title,
        body,
        fallback_used: false,
        reasoning: format!("llm: {reasoning}"),
        copies,
    })
}

/// Tolerate one pair of markdown fences around an otherwise exact JSON
/// document. Anything else malformed still fails the strict parse below.
fn strip_fences(text: &str) -> &str {
    let mut out = text;
    if let Some(rest) = out.strip_prefix("```json") {
        out = rest;
    } else if let Some(rest) = out.strip_prefix("```") {
        out = rest;
    }
    if let Some(rest) = out.strip_suffix("```") {
        out = rest;
    }
    out.trim()
}

/// Route one signal through the model, falling back to the deterministic
/// rules on any failure. Signals already silent with a single-channel intent
/// skip the model call: there is nothing else to render.
pub async fn decide_with_caller(
    signal: &NotificationSignal,
    settings: &Value,
    model: Option<String>,
    caller: &dyn ModelCaller,
    timeout: Duration,
) -> Decision {
    let pre = decide_deterministic(signal, settings);
    if pre.silent && signal.routing_intent == "single_channel" {
        return pre;
    }
    // Vellum's pass-through: a chat reply's copy is the reply itself and its
    // routing is fixed, so there is nothing for a model to decide.
    if signal.source_event_name == "chat.assistant_reply" {
        return Decision {
            fallback_used: false,
            reasoning: "pass-through: a chat reply notifies with its own text".to_string(),
            ..pre
        };
    }
    // A test notification must arrive exactly as written, and fast.
    if signal.source_event_name == "system.test" {
        return Decision {
            fallback_used: false,
            reasoning: "pass-through: a test notification is sent as written".to_string(),
            ..pre
        };
    }
    let prompt = decision_prompt(signal);
    let text = match tokio::time::timeout(timeout, caller.call(ModelCall { model, prompt })).await {
        Ok(Ok(text)) => text,
        _ => return pre,
    };
    parse_llm_response(&text, signal).unwrap_or(pre)
}

/// Route one signal through the live runtime bridge with the configured
/// model and the 20s decision timeout.
pub async fn decide_signal(
    state: &AppState,
    signal: &NotificationSignal,
    settings: &Value,
) -> Decision {
    let caller = RuntimeModelCaller {
        state: state.clone(),
        working_dir: state.workspace.to_string_lossy().to_string(),
    };
    decide_with_caller(
        signal,
        settings,
        decision_model(),
        &caller,
        DECISION_TIMEOUT,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::signal::parse_signal;
    use serde_json::json;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

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

    /// Audible signal: high urgency with allAlertsEnabled off still banners,
    /// so it always reaches the model call.
    fn callable_signal() -> NotificationSignal {
        signal_for("schedule.result", "high")
    }

    fn ok_caller(response: &str) -> impl ModelCaller {
        let response = response.to_string();
        move |_call: ModelCall| {
            let response = response.clone();
            Box::pin(async move { Ok(response) })
                as Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        }
    }

    fn valid_response() -> String {
        json!({
            "shouldNotify": true,
            "selectedChannels": ["local"],
            "copy": {"local": {"title": "Model title", "body": "Model body"}},
            "silent": false,
            "reasoning": "audible schedule result",
        })
        .to_string()
    }

    /// Environment resolution mutates process-global state, so these tests
    /// hold one lock and restore every variable they touch.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

    struct EnvRestore {
        notify: Option<String>,
        default: Option<String>,
    }

    impl EnvRestore {
        fn capture() -> Self {
            Self {
                notify: std::env::var("AMIRO_NOTIFY_DECISION_MODEL").ok(),
                default: std::env::var("AMIRO_DEFAULT_MODEL").ok(),
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            restore("AMIRO_NOTIFY_DECISION_MODEL", self.notify.take());
            restore("AMIRO_DEFAULT_MODEL", self.default.take());
        }
    }

    fn restore(var: &str, previous: Option<String>) {
        match previous {
            Some(value) => std::env::set_var(var, value),
            None => std::env::remove_var(var),
        }
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

    #[test]
    fn decision_model_prefers_the_notify_setting() {
        let _guard = ENV_GUARD.lock().unwrap();
        let _restore = EnvRestore::capture();
        std::env::set_var("AMIRO_NOTIFY_DECISION_MODEL", "openrouter:qwen3-8b");
        std::env::set_var("AMIRO_DEFAULT_MODEL", "openai:gpt-5");
        assert_eq!(
            resolve_decision_model(None).as_deref(),
            Some("openrouter:qwen3-8b")
        );
    }

    #[test]
    fn decision_model_falls_back_to_the_chat_default() {
        let _guard = ENV_GUARD.lock().unwrap();
        let _restore = EnvRestore::capture();
        std::env::remove_var("AMIRO_NOTIFY_DECISION_MODEL");
        std::env::set_var("AMIRO_DEFAULT_MODEL", "openai:gpt-5");
        assert_eq!(
            resolve_decision_model(None).as_deref(),
            Some("openai:gpt-5")
        );
    }

    #[test]
    fn decision_model_unset_means_the_runtime_default() {
        let _guard = ENV_GUARD.lock().unwrap();
        let _restore = EnvRestore::capture();
        std::env::remove_var("AMIRO_NOTIFY_DECISION_MODEL");
        std::env::remove_var("AMIRO_DEFAULT_MODEL");
        assert_eq!(resolve_decision_model(None), None);
        // An explicit blank never resolves to a model either.
        assert_eq!(resolve_decision_model(Some("  ")), None);
    }

    #[test]
    fn fallback_copy_covers_every_named_family() {
        for event in [
            "schedule.result",
            "schedule.notify",
            "chat.assistant_reply",
            "heartbeat.message",
            "system.test",
            "something.else",
        ] {
            let signal = signal_for(event, "high");
            let copy = fallback_copy(&signal);
            assert_eq!(copy.title, "T", "title for {event}");
            assert_eq!(copy.body, "B", "body for {event}");
        }
    }

    #[tokio::test]
    async fn invalid_json_falls_back() {
        let decision = decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &ok_caller("this is not json"),
            Duration::from_secs(5),
        )
        .await;
        assert!(decision.fallback_used);
        assert_eq!(decision.channels, vec!["local".to_string()]);
        assert_eq!(decision.title, "T");
    }

    #[tokio::test]
    async fn unknown_channel_falls_back() {
        let response = json!({
            "shouldNotify": true,
            "selectedChannels": ["pigeon"],
            "copy": {"pigeon": {"title": "T", "body": "B"}},
            "silent": false,
            "reasoning": "unknown channel",
        })
        .to_string();
        let decision = decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &ok_caller(&response),
            Duration::from_secs(5),
        )
        .await;
        assert!(decision.fallback_used);
    }

    #[tokio::test]
    async fn missing_copy_for_a_selected_channel_falls_back() {
        let response = json!({
            "shouldNotify": true,
            "selectedChannels": ["local", "telegram"],
            "copy": {"local": {"title": "T", "body": "B"}},
            "silent": false,
            "reasoning": "telegram copy missing",
        })
        .to_string();
        let decision = decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &ok_caller(&response),
            Duration::from_secs(5),
        )
        .await;
        assert!(decision.fallback_used);
    }

    #[tokio::test]
    async fn model_error_falls_back() {
        let caller = |_call: ModelCall| {
            Box::pin(async move { Err("connection refused".to_string()) })
                as Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        };
        let decision = decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &caller,
            Duration::from_secs(5),
        )
        .await;
        assert!(decision.fallback_used);
        assert!(decision.should_notify);
    }

    #[tokio::test]
    async fn timeout_falls_back() {
        let caller = |_call: ModelCall| {
            Box::pin(async move {
                std::future::pending::<()>().await;
                Ok(String::new())
            }) as Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        };
        let decision = decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &caller,
            Duration::from_millis(50),
        )
        .await;
        assert!(decision.fallback_used);
        assert_eq!(decision.title, "T");
    }

    #[tokio::test]
    async fn valid_response_carries_copy_for_every_selected_channel() {
        let response = json!({
            "shouldNotify": true,
            "selectedChannels": ["local", "telegram"],
            "copy": {
                "local": {"title": "Feed title", "body": "Feed body"},
                "telegram": {"title": "TG title", "body": "TG body"},
            },
            "silent": false,
            "reasoning": "worth a ping",
        })
        .to_string();
        let decision = decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &ok_caller(&response),
            Duration::from_secs(5),
        )
        .await;
        assert!(!decision.fallback_used);
        assert_eq!(decision.channels, vec!["local", "telegram"]);
        assert_eq!(decision.copies["local"].title, "Feed title");
        assert_eq!(decision.copies["telegram"].body, "TG body");
        // The feed copy is the local one.
        assert_eq!(decision.title, "Feed title");
        assert_eq!(decision.body, "Feed body");
    }

    #[tokio::test]
    async fn one_signal_costs_one_model_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let caller = move |_call: ModelCall| {
            let seen = seen.clone();
            let response = valid_response();
            Box::pin(async move {
                seen.fetch_add(1, Ordering::SeqCst);
                Ok(response)
            }) as Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        };
        decide_with_caller(
            &callable_signal(),
            &settings(),
            None,
            &caller,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn silent_single_channel_signal_skips_the_model_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let caller = move |_call: ModelCall| {
            let seen = seen.clone();
            let response = valid_response();
            Box::pin(async move {
                seen.fetch_add(1, Ordering::SeqCst);
                Ok(response)
            }) as Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        };
        let mut signal = signal_for("watcher.notification", "low");
        signal.routing_intent = "single_channel".to_string();
        let decision =
            decide_with_caller(&signal, &settings(), None, &caller, Duration::from_secs(5)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(decision.fallback_used);
        assert!(decision.silent);
    }
}
