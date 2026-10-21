//! Audit stores for the notification pipeline. Three JSON files under
//! `AMIRO_HOME/store`, all read-modify-written under the `AppState` store
//! lock, following the backend persistence standard:
//!
//! * `notification-events.json`   — every signal that entered the pipeline
//! * `notification-decisions.json` — the routing decision per signal
//! * `notification-deliveries.json` — one row per channel attempt

use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState};

fn doc(rows: Vec<Value>) -> Value {
    json!({ "version": 1, "rows": rows })
}

fn rows_of(doc: &Value) -> Vec<Value> {
    doc.get("rows")
        .and_then(|rows| rows.as_array())
        .cloned()
        .unwrap_or_default()
}

async fn append_row(state: &AppState, file: &str, row: Value) -> Result<(), ApiError> {
    let _lock = state.store.lock().await;
    let path = state.home.join("store").join(file);
    let mut stored = read_json(&path, doc(vec![])).await?;
    let mut rows = rows_of(&stored);
    rows.push(row);
    stored = doc(rows);
    write_json(&path, &stored).await
}

async fn all_rows(state: &AppState, file: &str) -> Result<Vec<Value>, ApiError> {
    let path = state.home.join("store").join(file);
    let stored = read_json(&path, doc(vec![])).await?;
    Ok(rows_of(&stored))
}

/// Record a signal entering the pipeline. Returns the stored event row.
pub async fn record_event(
    state: &AppState,
    user_id: &str,
    signal: &crate::notify::NotificationSignal,
) -> Result<Value, ApiError> {
    let row = json!({
        "signalId": signal.signal_id,
        "createdAt": signal.created_at,
        "userId": user_id,
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
        "dedupeKey": signal.dedupe_key,
        "routingIntent": signal.routing_intent,
    });
    append_row(state, "notification-events.json", row.clone()).await?;
    Ok(row)
}

/// Find a prior event by producer dedupe key (permanent claim, like Vellum:
/// a second row for a held key is never written).
pub async fn find_event_by_dedupe(
    state: &AppState,
    user_id: &str,
    dedupe_key: &str,
) -> Result<Option<Value>, ApiError> {
    let rows = all_rows(state, "notification-events.json").await?;
    Ok(rows.into_iter().find(|row| {
        row.get("userId").and_then(|v| v.as_str()) == Some(user_id)
            && row.get("dedupeKey").and_then(|v| v.as_str()) == Some(dedupe_key)
    }))
}

/// Record the routing decision for a signal. Returns the stored decision row.
pub async fn record_decision(
    state: &AppState,
    user_id: &str,
    signal_id: &str,
    decision: &crate::notify::Decision,
) -> Result<Value, ApiError> {
    let row = json!({
        "signalId": signal_id,
        "userId": user_id,
        "decidedAt": crate::state::now_iso(),
        "shouldNotify": decision.should_notify,
        "channels": decision.channels,
        "silent": decision.silent,
        "fallbackUsed": decision.fallback_used,
        "reasoning": decision.reasoning,
    });
    append_row(state, "notification-decisions.json", row.clone()).await?;
    Ok(row)
}

/// Record one channel delivery attempt.
pub async fn record_delivery(
    state: &AppState,
    user_id: &str,
    delivery_id: &str,
    signal_id: &str,
    channel: &str,
    status: &str,
    error: Option<String>,
) -> Result<Value, ApiError> {
    let row = json!({
        "deliveryId": delivery_id,
        "signalId": signal_id,
        "userId": user_id,
        "channel": channel,
        "status": status,
        "error": error,
        "recordedAt": crate::state::now_iso(),
    });
    append_row(state, "notification-deliveries.json", row.clone()).await?;
    Ok(row)
}

/// The stored decision for a signal, if one was recorded.
pub async fn find_decision_by_signal(
    state: &AppState,
    signal_id: &str,
) -> Result<Option<Value>, ApiError> {
    let rows = all_rows(state, "notification-decisions.json").await?;
    Ok(rows
        .into_iter()
        .find(|row| row.get("signalId").and_then(|v| v.as_str()) == Some(signal_id)))
}

/// All delivery rows for one signal (used to prove dedupe sent once).
pub async fn deliveries_for_signal(
    state: &AppState,
    signal_id: &str,
) -> Result<Vec<Value>, ApiError> {
    let rows = all_rows(state, "notification-deliveries.json").await?;
    Ok(rows
        .into_iter()
        .filter(|row| row.get("signalId").and_then(|v| v.as_str()) == Some(signal_id))
        .collect())
}
