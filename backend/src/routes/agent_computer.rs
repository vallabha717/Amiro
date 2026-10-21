//! A team agent's computer: its tool switches and its container.
//!
//! - `GET   /api/agents/{id}/computer`        switches, sandbox state, isolation
//! - `PATCH /api/agents/{id}/computer`        owner: `{tools: {shell?, files?}}`
//! - `POST  /api/agents/{id}/computer/check`  owner: the boundary, measured inside
//!
//! `isolation` is the one statement the agent page makes about the boundary:
//! `none` (every tool off), `container` (tools on, supervisor up) or
//! `unavailable` (tools on, supervisor missing or down: calls fail, never fall
//! back to the host). See `docs/multi-agent-team-isolation/02-policy-and-ui.md`.

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::routes::agents::{self, MAIN_AGENT_ID};
use crate::sandbox;
use crate::state::{ApiError, AppState, AuthUser};

/// Switches the owner can set today. `browser` is stored but refused until
/// the browser phase builds it.
const SETTABLE: [&str; 2] = ["shell", "files"];

async fn team_tools(state: &AppState, id: &str) -> Result<Value, ApiError> {
    if id == MAIN_AGENT_ID {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The main agent uses Amiro's own tools on this machine; it has no separate computer.".into(),
        ));
    }
    agents::agent_tools(state, id).await?.ok_or_else(agents::not_found)
}

async fn describe(state: &AppState, id: &str, tools: Value) -> Value {
    let any_on = ["shell", "files", "browser"].iter().any(|k| tools[k].as_bool() == Some(true));
    let client = sandbox::client(state).await;
    let configured = client.is_some();
    let (available, container) = match &client {
        Some(client) => match client.health().await {
            Ok(health) if health["docker"].as_bool() == Some(true) => {
                (true, client.status(id).await.ok())
            }
            _ => (false, None),
        },
        None => (false, None),
    };
    let isolation = match (any_on, available) {
        (false, _) => "none",
        (true, true) => "container",
        (true, false) => "unavailable",
    };
    json!({
        "tools": tools,
        "configured": configured,
        "available": available,
        "state": container.as_ref().and_then(|c| c.get("state").cloned()),
        "network": container.as_ref().and_then(|c| c.get("network").cloned()),
        "runtime": container.as_ref().and_then(|c| c.get("runtime").cloned()),
        "isolation": isolation,
    })
}

async fn get_computer(
    State(state): State<AppState>,
    _user: AuthUser,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    let tools = team_tools(&state, &id).await?;
    Ok(Json(describe(&state, &id, tools).await))
}

async fn patch_computer(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    team_tools(&state, &id).await?;
    let requested = body
        .get("tools")
        .and_then(Value::as_object)
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "tools is required".into()))?;
    let mut changes = Map::new();
    for (key, value) in requested {
        let on = value
            .as_bool()
            .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("{key} must be true or false")))?;
        if key == "browser" {
            if on {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "A browser for team agents is not available yet.".into(),
                ));
            }
        } else if !SETTABLE.contains(&key.as_str()) {
            return Err(ApiError(StatusCode::BAD_REQUEST, format!("unknown tool switch {key}")));
        }
        changes.insert(key.clone(), Value::Bool(on));
    }
    let tools = agents::set_agent_tools(&state, &id, &changes).await?;
    Ok(Json(describe(&state, &id, tools).await))
}

async fn check_computer(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    team_tools(&state, &id).await?;
    let client = sandbox::client(&state).await.ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "The sandbox is not set up. Run scripts/sandbox.sh up on the machine Amiro runs on.".into(),
        )
    })?;
    let check = client.selfcheck(&id).await.map_err(|e| match e.status {
        None => ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into()),
        Some(_) => ApiError(StatusCode::BAD_GATEWAY, e.message),
    })?;
    Ok(Json(check))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agents/{id}/computer", get(get_computer).patch(patch_computer))
        .route("/api/agents/{id}/computer/check", post(check_computer))
}
