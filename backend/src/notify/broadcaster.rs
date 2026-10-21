//! The broadcaster: owns the process-wide SSE fan-out, runs the decision,
//! and fans out to one adapter per selected channel. This is Vellum's
//! `broadcaster.ts` ported to the backend's store-and-broadcast shape.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::notify::adapters::local::LocalAdapter;
use crate::notify::adapters::{ChannelAdapter, ChannelCopy};
use crate::notify::{decision, signal, store};
use crate::routes::notifications as feed;
use crate::state::{ApiError, AppState};
use axum::http::StatusCode;

const CHANNEL_CAPACITY: usize = 256;

/// Keep-alive for the SSE stream is owned by the route; the broadcaster only
/// needs the channel to exist.
pub const KEEPALIVE_SECS: u64 = 15;
pub const _KEEPALIVE: Duration = Duration::from_secs(KEEPALIVE_SECS);

static NOTIFY_TX: OnceLock<broadcast::Sender<Value>> = OnceLock::new();

fn sender() -> &'static broadcast::Sender<Value> {
    NOTIFY_TX.get_or_init(|| broadcast::channel(CHANNEL_CAPACITY).0)
}

/// Subscribe to the fan-out channel (SSE route and tests).
pub fn subscribe() -> broadcast::Receiver<Value> {
    sender().subscribe()
}

/// Publish an already-built event. No subscribers is not an error.
pub(crate) fn publish(event: Value) {
    let _ = sender().send(event);
}

fn decision_json(decision: &decision::Decision) -> Value {
    json!({
        "shouldNotify": decision.should_notify,
        "channels": decision.channels,
        "silent": decision.silent,
        "fallbackUsed": decision.fallback_used,
        "reasoning": decision.reasoning,
    })
}

/// Emit a signal through the whole pipeline: validate → dedupe → decide →
/// record → fan out → audit. Returns the decision, the delivery id, and
/// (for the local channel) the feed item.
///
/// The decision runs the model path with the configured decision model and
/// the 20s decision timeout; any model failure falls back to the
/// deterministic rules with `fallbackUsed: true`.
pub async fn emit_signal(state: &AppState, user_id: &str, body: &Value) -> Result<Value, ApiError> {
    let caller = decision::RuntimeModelCaller {
        state: state.clone(),
        working_dir: state.workspace.to_string_lossy().to_string(),
    };
    emit_inner(
        state,
        user_id,
        body,
        decision::decision_model(),
        &caller,
        decision::DECISION_TIMEOUT,
    )
    .await
}

/// [`emit_signal`] with an injected model caller, so tests can stub the
/// bridge up (fixed answers), down (errors), or slow (hangs) without network
/// or provider keys. Production always goes through [`emit_signal`].
pub async fn emit_signal_with_caller(
    state: &AppState,
    user_id: &str,
    body: &Value,
    caller: &dyn decision::ModelCaller,
) -> Result<Value, ApiError> {
    emit_inner(
        state,
        user_id,
        body,
        None,
        caller,
        decision::DECISION_TIMEOUT,
    )
    .await
}

async fn emit_inner(
    state: &AppState,
    user_id: &str,
    body: &Value,
    model: Option<String>,
    caller: &dyn decision::ModelCaller,
    timeout: std::time::Duration,
) -> Result<Value, ApiError> {
    if user_id.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "notification requires a user id".to_string(),
        ));
    }
    let parsed = signal::parse_signal(body)?;

    // Dedupe: the producer key is a permanent claim. A replay returns the
    // stored decision without writing new rows.
    if let Some(key) = parsed.dedupe_key.clone() {
        if let Some(prior) = store::find_event_by_dedupe(state, user_id, &key).await? {
            let prior_id = prior
                .get("signalId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let stored = store::find_decision_by_signal(state, &prior_id).await?;
            let first_delivery = store::deliveries_for_signal(state, &prior_id)
                .await?
                .into_iter()
                .next();
            return Ok(json!({
                "duplicate": true,
                "signalId": prior_id,
                "deliveryId": first_delivery.and_then(|d| d.get("deliveryId").cloned()).unwrap_or(Value::Null),
                "decision": stored.unwrap_or(Value::Null),
            }));
        }
    }

    let settings_doc = feed::load_settings_doc(state).await?;
    let settings = feed::settings_for(&settings_doc, user_id);
    let decided = decision::decide_with_caller(&parsed, &settings, model, caller, timeout).await;
    let category = signal::category_for_event(&parsed.source_event_name);

    store::record_event(state, user_id, &parsed).await?;
    let stored_decision =
        store::record_decision(state, user_id, &parsed.signal_id, &decided).await?;

    let delivery_id = uuid::Uuid::new_v4().to_string();
    let fallback_copy = ChannelCopy {
        title: decided.title.clone(),
        body: decided.body.clone(),
    };
    let context = json!({
        "category": category,
        "urgency": parsed.urgency,
        "silent": decided.silent,
        "threadId": parsed.thread_id,
        "scheduleId": parsed.schedule_id,
        "sourceEventName": parsed.source_event_name,
    });

    // A model `shouldNotify: false` verdict records the decision but fans out
    // to nothing: no feed item, no deliveries.
    let mut item = Value::Null;
    let mut unread = 0u64;
    let selected: Vec<String> = if decided.should_notify {
        decided.channels.clone()
    } else {
        Vec::new()
    };
    for channel in selected {
        if channel == "local" {
            let copy = decided
                .copies
                .get("local")
                .cloned()
                .unwrap_or_else(|| fallback_copy.clone());
            let adapter = LocalAdapter;
            let result = adapter
                .send(state, user_id, &delivery_id, &copy, &context)
                .await?;
            if let Some(detail) = result.detail {
                item = detail.get("item").cloned().unwrap_or(Value::Null);
                unread = detail
                    .get("unreadCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
            store::record_delivery(
                state,
                user_id,
                &delivery_id,
                &parsed.signal_id,
                "local",
                if result.success { "sent" } else { "failed" },
                result.error,
            )
            .await?;
        } else {
            // Selected by the model, but no adapter in this phase (Phase 03
            // delivers external channels). Recorded, not delivered.
            store::record_delivery(
                state,
                user_id,
                &delivery_id,
                &parsed.signal_id,
                channel.as_str(),
                "skipped",
                Some("no adapter for this channel in Phase 01".to_string()),
            )
            .await?;
        }
    }

    Ok(json!({
        "duplicate": false,
        "signalId": parsed.signal_id,
        "deliveryId": delivery_id,
        "decision": decision_json(&decided),
        "storedDecision": stored_decision,
        "item": item,
        "unreadCount": unread,
    }))
}
