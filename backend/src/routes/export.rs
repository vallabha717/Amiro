use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

async fn list_exports(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let exports_file = store_path(&state, "exports.json");
    let comments_file = store_path(&state, "export-comments.json");

    let exports_doc = read_json(&exports_file, json!({})).await?;
    let comments_doc = read_json(&comments_file, json!({})).await?;

    let comments_map = comments_doc.as_object();

    let mut result = Vec::new();
    if let Some(exports_map) = exports_doc.as_object() {
        for e in exports_map.values() {
            if e.get("exporterId").and_then(|i| i.as_str()) == Some(&uid) {
                let eid = e.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let comment_count = if let Some(cc) = e.get("commentCount").and_then(|c| c.as_u64()) {
                    cc as usize
                } else if let Some(cm) = comments_map {
                    cm.values()
                        .filter(|c| c.get("exportId").and_then(|x| x.as_str()) == Some(eid))
                        .count()
                } else {
                    0
                };

                let original_thread_id = e
                    .get("originalThreadId")
                    .cloned()
                    .or_else(|| e.get("threadId").cloned())
                    .unwrap_or(Value::Null);

                let exported_at = e
                    .get("createdAt")
                    .cloned()
                    .or_else(|| e.get("exportedAt").cloned())
                    .unwrap_or_else(|| json!(now_iso()));

                result.push(json!({
                    "id": eid,
                    "title": e.get("title").cloned().unwrap_or(json!("Chat Export")),
                    "exporterId": uid,
                    "originalThreadId": original_thread_id,
                    "commentCount": comment_count,
                    "exportedAt": exported_at,
                    "expiresAt": e.get("expiresAt").cloned().unwrap_or(Value::Null),
                }));
            }
        }
    }

    Ok(Json(Value::Array(result)))
}

async fn get_export_by_id(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let exports_file = store_path(&state, "exports.json");
    let exports_doc = read_json(&exports_file, json!({})).await?;

    let exp = exports_doc
        .get(&id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Export not found".to_string()))?;

    let exporter_id = exp.get("exporterId").and_then(|i| i.as_str()).unwrap_or("");
    let users_file = state.home.join("users.json");
    let users_doc = read_json(&users_file, json!({ "users": [] })).await.unwrap_or(json!({}));
    let empty_vec = Vec::new();
    let users = users_doc.get("users").and_then(|u| u.as_array()).unwrap_or(&empty_vec);
    let exporter = users
        .iter()
        .find(|u| u.get("id").and_then(|i| i.as_str()) == Some(exporter_id));

    let now_dt = Utc::now();
    let is_expired = if let Some(exp_str) = exp.get("expiresAt").and_then(|s| s.as_str()) {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(exp_str) {
            parsed < now_dt
        } else {
            false
        }
    } else {
        false
    };

    let empty_messages = Vec::new();
    let messages = if is_expired {
        &empty_messages
    } else {
        exp.get("messages").and_then(|m| m.as_array()).unwrap_or(&empty_messages)
    };

    let original_thread_id = exp
        .get("originalThreadId")
        .cloned()
        .or_else(|| exp.get("threadId").cloned())
        .unwrap_or(Value::Null);

    let exported_at = exp
        .get("createdAt")
        .cloned()
        .or_else(|| exp.get("exportedAt").cloned())
        .unwrap_or_else(|| json!(now_iso()));

    Ok(Json(json!({
        "id": exp.get("id").cloned().unwrap_or(json!(id)),
        "title": exp.get("title").cloned().unwrap_or(json!("Chat Export")),
        "exporterId": exporter_id,
        "originalThreadId": original_thread_id,
        "messages": messages,
        "exportedAt": exported_at,
        "expiresAt": exp.get("expiresAt").cloned().unwrap_or(Value::Null),
        "exporterName": exporter.and_then(|u| u.get("name")).cloned().unwrap_or(Value::Null),
        "exporterImage": exporter.and_then(|u| u.get("image")).cloned().unwrap_or(Value::Null),
        "isExpired": is_expired,
    })))
}

async fn delete_export_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");

    let exports_file = store_path(&state, "exports.json");
    let comments_file = store_path(&state, "export-comments.json");
    {
        let _lock = state.store.lock().await;
        let mut exports_doc = read_json(&exports_file, json!({})).await?;

        let exports_map = exports_doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Export not found".to_string()))?;

        let exp = exports_map
            .get(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Export not found".to_string()))?;

        if exp.get("exporterId").and_then(|i| i.as_str()) != Some(&uid) && role != "admin" {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }

        exports_map.remove(&id);
        write_json(&exports_file, &exports_doc).await?;

        let mut comments_doc = read_json(&comments_file, json!({})).await?;
        if let Some(cm) = comments_doc.as_object_mut() {
            cm.retain(|_, v| v.get("exportId").and_then(|x| x.as_str()) != Some(&id));
        }
        write_json(&comments_file, &comments_doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

fn build_comment_tree(
    parent_id: Option<&str>,
    comments: &[Value],
    user_map: &HashMap<String, &Value>,
    current_uid: Option<&str>,
) -> Vec<Value> {
    comments
        .iter()
        .filter(|c| {
            let pid = c.get("parentId").and_then(|p| p.as_str()).filter(|p| !p.is_empty());
            pid == parent_id
        })
        .map(|c| {
            let cid = c.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let author_id = c.get("authorId").and_then(|a| a.as_str()).unwrap_or("");
            let author = user_map.get(author_id).copied();
            let is_owner = current_uid.map(|u| u == author_id).unwrap_or(false);

            let replies = build_comment_tree(Some(cid), comments, user_map, current_uid);

            json!({
                "id": cid,
                "exportId": c.get("exportId").cloned().unwrap_or(json!("")),
                "authorId": author_id,
                "parentId": c.get("parentId").cloned().unwrap_or(Value::Null),
                "content": c.get("content").cloned().unwrap_or(json!("")),
                "createdAt": c.get("createdAt").cloned().unwrap_or(Value::Null),
                "updatedAt": c.get("updatedAt").cloned().unwrap_or(Value::Null),
                "authorName": author.and_then(|a| a.get("name")).cloned().unwrap_or(Value::Null),
                "authorImage": author.and_then(|a| a.get("image")).cloned().unwrap_or(Value::Null),
                "isOwner": is_owner,
                "replies": replies,
            })
        })
        .collect()
}

async fn get_export_comments(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let comments_file = store_path(&state, "export-comments.json");
    let comments_doc = read_json(&comments_file, json!({})).await?;

    let mut all_comments = Vec::new();
    if let Some(cm) = comments_doc.as_object() {
        for c in cm.values() {
            if c.get("exportId").and_then(|x| x.as_str()) == Some(&id) {
                all_comments.push(c.clone());
            }
        }
    }

    let users_file = state.home.join("users.json");
    let users_doc = read_json(&users_file, json!({ "users": [] })).await.unwrap_or(json!({}));
    let empty_vec = Vec::new();
    let users = users_doc.get("users").and_then(|u| u.as_array()).unwrap_or(&empty_vec);

    let mut user_map = HashMap::new();
    for u in users {
        if let Some(uid) = u.get("id").and_then(|i| i.as_str()) {
            user_map.insert(uid.to_string(), u);
        }
    }

    let tree = build_comment_tree(None, &all_comments, &user_map, None);
    Ok(Json(Value::Array(tree)))
}

async fn add_export_comment(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let content = body
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "content is required".to_string()));
    }

    let parent_id = body
        .get("parentId")
        .and_then(|p| p.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);

    let comment_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let comment = json!({
        "id": comment_id,
        "exportId": id,
        "authorId": uid,
        "parentId": parent_id,
        "content": content,
        "createdAt": now,
        "updatedAt": now,
    });

    let exports_file = store_path(&state, "exports.json");
    let comments_file = store_path(&state, "export-comments.json");
    {
        let _lock = state.store.lock().await;
        let mut exports_doc = read_json(&exports_file, json!({})).await?;

        let exports_map = exports_doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Export not found".to_string()))?;

        let exp = exports_map
            .get_mut(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Export not found".to_string()))?;

        let mut comments_doc = read_json(&comments_file, json!({})).await?;
        if let Some(cm) = comments_doc.as_object_mut() {
            cm.insert(comment_id.clone(), comment.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(comment_id.clone(), comment.clone());
            comments_doc = Value::Object(map);
        }
        write_json(&comments_file, &comments_doc).await?;

        let count = exp.get("commentCount").and_then(|c| c.as_u64()).unwrap_or(0);
        exp["commentCount"] = json!(count + 1);
        write_json(&exports_file, &exports_doc).await?;
    }

    let author_name = user.0.get("name").cloned().unwrap_or(Value::Null);
    let author_image = user.0.get("image").cloned().unwrap_or(Value::Null);

    Ok(Json(json!({
        "id": comment_id,
        "exportId": id,
        "authorId": uid,
        "parentId": parent_id,
        "content": content,
        "createdAt": now,
        "updatedAt": now,
        "authorName": author_name,
        "authorImage": author_image,
        "isOwner": true,
        "replies": [],
    })))
}

async fn delete_export_comment(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, comment_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");

    let comments_file = store_path(&state, "export-comments.json");
    let exports_file = store_path(&state, "exports.json");
    {
        let _lock = state.store.lock().await;
        let mut comments_doc = read_json(&comments_file, json!({})).await?;

        let comments_map = comments_doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Comment not found".to_string()))?;

        let comment = comments_map
            .get(&comment_id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Comment not found".to_string()))?;

        if comment.get("authorId").and_then(|a| a.as_str()) != Some(&uid) && role != "admin" {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }

        comments_map.remove(&comment_id);
        write_json(&comments_file, &comments_doc).await?;

        if let Ok(mut exports_doc) = read_json(&exports_file, json!({})).await {
            if let Some(exp) = exports_doc.get_mut(&id) {
                let count = exp.get("commentCount").and_then(|c| c.as_u64()).unwrap_or(1);
                if count > 0 {
                    exp["commentCount"] = json!(count - 1);
                }
                let _ = write_json(&exports_file, &exports_doc).await;
            }
        }
    }

    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/export", get(list_exports))
        .route(
            "/api/export/{id}",
            get(get_export_by_id).delete(delete_export_by_id),
        )
        .route(
            "/api/export/{id}/comments",
            get(get_export_comments).post(add_export_comment),
        )
        .route(
            "/api/export/{id}/comments/{commentId}",
            delete(delete_export_comment),
        )
}
