use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, Utc};
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
    Query(query): Query<UserStatsQuery>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let users_file = state.home.join("users.json");
    let doc = read_json(&users_file, json!({ "users": [] })).await?;
    let empty_vec = Vec::new();
    let all_users = doc.get("users").and_then(|u| u.as_array()).unwrap_or(&empty_vec);

    // Self-view must never 404: a signed-in admin whose id is absent from
    // users.json (fresh install, OAuth user never persisted) falls back to
    // the session identity. Other unknown ids still 404.
    let session_id = user.0.get("id").and_then(|i| i.as_str()).unwrap_or("");
    let target_user;
    let fallback;
    match all_users
        .iter()
        .find(|u| u.get("id").and_then(|i| i.as_str()) == Some(&id))
    {
        Some(found) => target_user = found,
        None if id == session_id && !session_id.is_empty() => {
            fallback = user.0.clone();
            target_user = &fallback;
        }
        None => {
            return Err(ApiError(StatusCode::NOT_FOUND, "user not found".to_string()));
        }
    }

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

    let (start_opt, end_opt, period) = if let Some(ref from) = query.from {
        let s = DateTime::parse_from_rfc3339(from)
            .map(|dt| dt.with_timezone(&Utc))
            .ok();
        let e = query.to.as_ref().and_then(|to| {
            DateTime::parse_from_rfc3339(to)
                .map(|dt| dt.with_timezone(&Utc))
                .ok()
        });
        let label = match (&s, &e) {
            (Some(s_dt), Some(e_dt)) => format!(
                "{} - {}",
                s_dt.format("%b %d, %Y"),
                e_dt.format("%b %d, %Y")
            ),
            (Some(s_dt), None) => format!("From {}", s_dt.format("%b %d, %Y")),
            _ => "Custom Range".to_string(),
        };
        (s, e, label)
    } else if let Some(ref days_str) = query.days {
        let d: i64 = days_str.parse().unwrap_or(30).clamp(1, 3650);
        if d <= 1 {
            let now = Utc::now();
            let start = now
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc));
            (start, None, "Today".to_string())
        } else {
            let start = Utc::now() - Duration::days(d);
            (Some(start), None, format!("Last {} Days", d))
        }
    } else {
        let start = Utc::now() - Duration::days(30);
        (Some(start), None, "Last 30 Days".to_string())
    };

    let oauth_file = state.runtime_home.join("openai_oauth_usage.json");
    let oauth_doc = read_json(&oauth_file, json!({})).await.unwrap_or(json!({}));

    let mut daily_map: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    let mut total_prompt_tokens: u64 = 0;
    let mut total_completion_tokens: u64 = 0;
    let mut total_tokens: u64 = 0;
    let mut total_cost: f64 = 0.0;
    let mut message_count: u64 = 0;

    if let Some(accounts) = oauth_doc.get("accounts").and_then(|a| a.as_object()) {
        for acc in accounts.values() {
            if let Some(days) = acc.get("days").and_then(|d| d.as_object()) {
                for (date_str, day_data) in days {
                    let in_range = if let Ok(naive) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                        if let (Some(day_start), Some(day_end)) = (
                            naive.and_hms_opt(0, 0, 0).map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc)),
                            naive.and_hms_opt(23, 59, 59).map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc)),
                        ) {
                            let after_start = match start_opt {
                                Some(s) => day_end >= s,
                                None => true,
                            };
                            let before_end = match end_opt {
                                Some(e) => day_start <= e,
                                None => true,
                            };
                            after_start && before_end
                        } else {
                            true
                        }
                    } else {
                        true
                    };

                    if in_range {
                        let inp = day_data.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
                        let out = day_data.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cost = day_data.get("known_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let reqs = day_data.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);

                        total_prompt_tokens += inp;
                        total_completion_tokens += out;
                        total_tokens += inp + out;
                        total_cost += cost;
                        message_count += reqs;

                        let entry = daily_map.entry(date_str.clone()).or_insert_with(|| {
                            json!({
                                "date": date_str,
                                "totalTokens": 0,
                                "promptTokens": 0,
                                "completionTokens": 0,
                                "totalCost": 0.0,
                                "messageCount": 0
                            })
                        });

                        if let Some(obj) = entry.as_object_mut() {
                            let curr_inp = obj.get("promptTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let curr_out = obj.get("completionTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let curr_cost = obj.get("totalCost").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let curr_reqs = obj.get("messageCount").and_then(|v| v.as_u64()).unwrap_or(0);

                            obj.insert("promptTokens".to_string(), json!(curr_inp + inp));
                            obj.insert("completionTokens".to_string(), json!(curr_out + out));
                            obj.insert("totalTokens".to_string(), json!(curr_inp + inp + curr_out + out));
                            obj.insert("totalCost".to_string(), json!((curr_cost + cost * 10000.0).round() / 10000.0));
                            obj.insert("messageCount".to_string(), json!(curr_reqs + reqs));
                        }
                    }
                }
            }
        }
    }

    let daily_usage: Vec<Value> = daily_map.into_values().collect();

    let mut limits = Vec::new();
    if let Ok(output) = tokio::process::Command::new("jcode")
        .args(["usage", "--json"])
        .output()
        .await
    {
        if output.status.success() {
            if let Ok(parsed) = serde_json::from_slice::<Value>(&output.stdout) {
                if let Some(providers) = parsed.get("providers").and_then(|p| p.as_array()) {
                    for prov in providers {
                        let prov_name = prov.get("provider_name").and_then(|s| s.as_str()).unwrap_or("");
                        if let Some(lim_arr) = prov.get("limits").and_then(|l| l.as_array()) {
                            for lim in lim_arr {
                                limits.push(json!({
                                    "name": lim.get("name").cloned().unwrap_or(json!("")),
                                    "usage_percent": lim.get("usage_percent").cloned().unwrap_or(json!(0)),
                                    "resets_at": lim.get("resets_at").cloned().unwrap_or(Value::Null),
                                    "reset_in": lim.get("reset_in").cloned().unwrap_or(Value::Null),
                                    "provider": prov_name,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    let stats = json!({
        "threadCount": thread_count,
        "messageCount": message_count,
        "modelStats": [],
        "totalTokens": total_tokens,
        "promptTokens": total_prompt_tokens,
        "completionTokens": total_completion_tokens,
        "totalCost": (total_cost * 10000.0).round() / 10000.0,
        "promptCost": 0,
        "completionCost": 0,
        "dailyUsage": daily_usage,
        "period": period,
        "limits": limits,
        "usageNotice": "Usage is shared Amiro runtime provider-account data, not per-user billing. Token and known-cost totals cover OpenAI OAuth only. Per-model token attribution is unavailable."
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
