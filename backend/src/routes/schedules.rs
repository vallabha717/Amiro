//! HTTP contract for native schedules (v1, camelCase, owner-scoped).
//!
//! - `POST /api/schedules` -> 201 `{schedule}`
//! - `GET /api/schedules` -> `{schedules}`
//! - `GET /api/schedules/:id` -> `{schedule}`
//! - `PATCH /api/schedules/:id` -> `{schedule}`
//! - `DELETE /api/schedules/:id` -> 204
//! - `POST /api/schedules/:id/run` -> `{schedule, run}`
//! - `GET /api/schedules/:id/runs` -> `{runs}`
//! - `GET /api/schedules/system` -> `{tasks}` (heartbeat + memory upkeep)
//! - `POST /api/schedules/preview` -> `{nextRuns}` (read-only, validated)
//!
//! Cross-owner access is 404 (existence is never leaked). Malformed
//! timezone/cron/once payloads are 400 with an actionable message. A standby
//! backend that does not hold the scheduler lock answers 409 on mutations;
//! preview never probes the lock.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::schedules;
use crate::state::{ApiError, AppState, AuthUser};

fn uid_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn missing_id() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "schedule not found".into())
}

async fn create_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let schedule = schedules::create_schedule(&state, &uid_of(&user), &body).await?;
    Ok((StatusCode::CREATED, Json(json!({ "schedule": schedule }))))
}

async fn list_schedules(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let list = schedules::list_schedules(&state, &uid_of(&user)).await?;
    Ok(Json(json!({ "schedules": list })))
}

async fn get_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let schedule = schedules::get_schedule(&state, &uid_of(&user), &id)
        .await?
        .ok_or_else(missing_id)?;
    Ok(Json(json!({ "schedule": schedule })))
}

async fn update_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let schedule = schedules::update_schedule(&state, &uid_of(&user), &id, &body).await?;
    Ok(Json(json!({ "schedule": schedule })))
}

async fn delete_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    schedules::delete_schedule(&state, &uid_of(&user), &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn run_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (schedule, run) = schedules::run_schedule_now(&state, &uid_of(&user), &id).await?;
    Ok(Json(json!({ "schedule": schedule, "run": run })))
}

async fn list_runs(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let runs = schedules::list_runs(&state, &uid_of(&user), &id).await?;
    Ok(Json(json!({ "runs": runs })))
}

async fn preview(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let kind = body.get("schedule").cloned().unwrap_or(Value::Null);
    let timezone = body.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
    let next = schedules::preview_next_runs(&kind, timezone, 5).await?;
    Ok(Json(json!({ "nextRuns": next })))
}

async fn system_tasks(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(schedules::system_tasks(&state).await?))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/schedules", post(create_schedule).get(list_schedules))
        .route("/api/schedules/preview", post(preview))
        .route("/api/schedules/system", get(system_tasks))
        .route(
            "/api/schedules/{id}",
            get(get_schedule)
                .patch(update_schedule)
                .delete(delete_schedule),
        )
        .route("/api/schedules/{id}/run", post(run_schedule))
        .route("/api/schedules/{id}/runs", get(list_runs))
}
