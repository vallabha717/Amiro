use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::{read_json, ApiError, AppState, AuthUser};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
struct UserListQuery {
    q: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize, Default)]
#[allow(dead_code)]
struct UserStatsQuery {
    days: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

fn format_user_detail(u: &Value, now: &str) -> Value {
    let id = u.get("id").cloned().unwrap_or(json!(""));
    let name = u.get("name").cloned().unwrap_or(json!(""));
    let email = u.get("email").cloned().unwrap_or(json!(""));
    let role = u.get("role").cloned().unwrap_or(json!("user"));
    let image = u.get("image").cloned().unwrap_or(Value::Null);
    let created_at = u.get("createdAt").cloned().unwrap_or_else(|| json!(now));
    let updated_at = u
        .get("updatedAt")
        .cloned()
        .or_else(|| u.get("createdAt").cloned())
        .unwrap_or_else(|| json!(now));
    let last_login = u.get("lastLogin").cloned().unwrap_or(Value::Null);

    json!({
        "id": id,
        "name": name,
        "email": email,
        "role": role,
        "emailVerified": true,
        "image": image,
        "banned": false,
        "banReason": Value::Null,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "lastLogin": last_login,
    })
}

async fn get_admin_users(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<UserListQuery>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let users_file = state.home.join("users.json");
    let doc = read_json(&users_file, json!({ "users": [] })).await?;
    let empty_vec = Vec::new();
    let all_users = doc.get("users").and_then(|u| u.as_array()).unwrap_or(&empty_vec);

    let q = query.q.unwrap_or_default().to_lowercase().trim().to_string();
    let limit = query.limit.unwrap_or(10).max(1);
    let offset = query.offset.unwrap_or(0);

    let filtered: Vec<&Value> = all_users
        .iter()
        .filter(|u| {
            if q.is_empty() {
                true
            } else {
                let name = u.get("name").and_then(|s| s.as_str()).unwrap_or("").to_lowercase();
                let email = u.get("email").and_then(|s| s.as_str()).unwrap_or("").to_lowercase();
                name.contains(&q) || email.contains(&q)
            }
        })
        .collect();

    let total = filtered.len();
    let now = now_iso();
    let paged: Vec<Value> = filtered
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|u| format_user_detail(u, &now))
        .collect();

    Ok(Json(json!({
        "users": paged,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

async fn get_admin_user_stats(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(_query): Query<UserStatsQuery>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let users_file = state.home.join("users.json");
    let doc = read_json(&users_file, json!({ "users": [] })).await?;
    let empty_vec = Vec::new();
    let all_users = doc.get("users").and_then(|u| u.as_array()).unwrap_or(&empty_vec);

    let target_user = all_users
        .iter()
        .find(|u| u.get("id").and_then(|i| i.as_str()) == Some(&id))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "user not found".to_string()))?;

    let now = now_iso();
    let user_detail = format_user_detail(target_user, &now);

    // Threads count
    let threads_file = state.home.join("threads.json");
    let threads_doc = read_json(&threads_file, json!({})).await.unwrap_or(json!({}));
    let mut thread_count = 0;
    if let Some(obj) = threads_doc.as_object() {
        for t in obj.values() {
            if t.get("userId").and_then(|u| u.as_str()) == Some(&id) {
                thread_count += 1;
            }
        }
    }

    let stats = json!({
        "threadCount": thread_count,
        "messageCount": 0,
        "modelStats": [],
        "totalTokens": 0,
        "promptTokens": 0,
        "completionTokens": 0,
        "totalCost": 0.0,
        "promptCost": 0,
        "completionCost": 0,
        "dailyUsage": [],
        "limits": []
    });

    Ok(Json(json!({
        "user": user_detail,
        "stats": stats,
    })))
}

async fn get_admin_user_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let users_file = state.home.join("users.json");
    let doc = read_json(&users_file, json!({ "users": [] })).await?;
    let empty_vec = Vec::new();
    let all_users = doc.get("users").and_then(|u| u.as_array()).unwrap_or(&empty_vec);

    let target_user = all_users
        .iter()
        .find(|u| u.get("id").and_then(|i| i.as_str()) == Some(&id))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "user not found".to_string()))?;

    let now = now_iso();
    Ok(Json(format_user_detail(target_user, &now)))
}

async fn dead_admin_role(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

async fn dead_admin_ban(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

async fn dead_admin_delete(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/users", get(get_admin_users))
        .route("/api/admin/users/{id}/stats", get(get_admin_user_stats))
        .route("/api/admin/users/{id}", get(get_admin_user_by_id).delete(dead_admin_delete))
        .route("/api/admin/users/{id}/role", put(dead_admin_role))
        .route("/api/admin/users/{id}/ban", put(dead_admin_ban))
}
