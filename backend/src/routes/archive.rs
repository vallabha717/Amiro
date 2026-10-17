use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
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

async fn list_archives(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let archives_file = store_path(&state, "archives.json");
    let items_file = store_path(&state, "archive-items.json");

    let archives_doc = read_json(&archives_file, json!({})).await?;
    let items_doc = read_json(&items_file, json!({})).await?;

    let items_map = items_doc.as_object();

    let mut result = Vec::new();
    if let Some(archives_map) = archives_doc.as_object() {
        for a in archives_map.values() {
            if a.get("userId").and_then(|u| u.as_str()) == Some(&uid) {
                let aid = a.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let item_count = items_map
                    .map(|im| {
                        im.values()
                            .filter(|it| it.get("archiveId").and_then(|x| x.as_str()) == Some(aid))
                            .count()
                    })
                    .unwrap_or(0);

                result.push(json!({
                    "id": aid,
                    "name": a.get("name").cloned().unwrap_or(json!("")),
                    "description": a.get("description").cloned().unwrap_or(Value::Null),
                    "userId": uid,
                    "createdAt": a.get("createdAt").cloned().unwrap_or(Value::Null),
                    "updatedAt": a.get("updatedAt").cloned().unwrap_or(Value::Null),
                    "itemCount": item_count,
                }));
            }
        }
    }

    Ok(Json(Value::Array(result)))
}

async fn create_archive(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let name = body
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim();

    if name.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "name is required".to_string()));
    }
    if name.len() > 100 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "name must be at most 100 characters".to_string(),
        ));
    }

    let description = body
        .get("description")
        .and_then(|d| d.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let archive = json!({
        "id": id,
        "name": name,
        "description": description,
        "userId": uid,
        "createdAt": now,
        "updatedAt": now,
    });

    let archives_file = store_path(&state, "archives.json");
    {
        let _lock = state.store.lock().await;
        let mut archives_doc = read_json(&archives_file, json!({})).await?;
        if let Some(map) = archives_doc.as_object_mut() {
            map.insert(id.clone(), archive.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(id.clone(), archive.clone());
            archives_doc = Value::Object(map);
        }
        write_json(&archives_file, &archives_doc).await?;
    }

    Ok(Json(archive))
}

async fn get_archive_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let archives_file = store_path(&state, "archives.json");
    let archives_doc = read_json(&archives_file, json!({})).await?;

    let archive = archives_doc
        .get(&id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

    if archive.get("userId").and_then(|u| u.as_str()) != Some(&uid) {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }

    let items_file = store_path(&state, "archive-items.json");
    let items_doc = read_json(&items_file, json!({})).await?;
    let mut archive_items = Vec::new();
    if let Some(items_map) = items_doc.as_object() {
        for it in items_map.values() {
            if it.get("archiveId").and_then(|a| a.as_str()) == Some(&id) {
                archive_items.push(it.clone());
            }
        }
    }

    let mut res = archive.clone();
    if let Some(obj) = res.as_object_mut() {
        obj.insert("items".to_string(), Value::Array(archive_items));
    }

    Ok(Json(res))
}

async fn put_archive_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let archives_file = store_path(&state, "archives.json");
    let returned = {
        let _lock = state.store.lock().await;
        let mut archives_doc = read_json(&archives_file, json!({})).await?;

        let archives_map = archives_doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

        let archive = archives_map
            .get_mut(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

        if archive.get("userId").and_then(|u| u.as_str()) != Some(&uid) {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }

        if let Some(name_val) = body.get("name") {
            let name_str = name_val.as_str().unwrap_or("").trim();
            if !name_str.is_empty() {
                archive["name"] = json!(name_str);
            }
        }
        if let Some(desc_val) = body.get("description") {
            if desc_val.is_null() {
                archive["description"] = Value::Null;
            } else {
                let desc_str = desc_val.as_str().unwrap_or("").trim();
                if desc_str.is_empty() {
                    archive["description"] = Value::Null;
                } else {
                    archive["description"] = json!(desc_str);
                }
            }
        }
        archive["updatedAt"] = json!(now_iso());

        let ret = archive.clone();
        write_json(&archives_file, &archives_doc).await?;
        ret
    };

    Ok(Json(returned))
}

async fn delete_archive_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let archives_file = store_path(&state, "archives.json");
    let items_file = store_path(&state, "archive-items.json");
    {
        let _lock = state.store.lock().await;
        let mut archives_doc = read_json(&archives_file, json!({})).await?;

        let archives_map = archives_doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

        let archive = archives_map
            .get(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

        if archive.get("userId").and_then(|u| u.as_str()) != Some(&uid) {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }

        archives_map.remove(&id);
        write_json(&archives_file, &archives_doc).await?;

        let mut items_doc = read_json(&items_file, json!({})).await?;
        if let Some(items_map) = items_doc.as_object_mut() {
            items_map.retain(|_, v| v.get("archiveId").and_then(|a| a.as_str()) != Some(&id));
        }
        write_json(&items_file, &items_doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn add_archive_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let item_id = body
        .get("itemId")
        .and_then(|i| i.as_str())
        .unwrap_or("")
        .trim();
    if item_id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "itemId is required".to_string()));
    }

    let archives_file = store_path(&state, "archives.json");
    let items_file = store_path(&state, "archive-items.json");
    let item = {
        let _lock = state.store.lock().await;
        let mut archives_doc = read_json(&archives_file, json!({})).await?;

        let archives_map = archives_doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

        let archive = archives_map
            .get_mut(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

        if archive.get("userId").and_then(|u| u.as_str()) != Some(&uid) {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }

        let mut items_doc = read_json(&items_file, json!({})).await?;

        if let Some(items_map) = items_doc.as_object() {
            if let Some(existing) = items_map.values().find(|it| {
                it.get("archiveId").and_then(|a| a.as_str()) == Some(&id)
                    && it.get("itemId").and_then(|i| i.as_str()) == Some(item_id)
            }) {
                return Ok(Json(existing.clone()));
            }
        }

        let item_uuid = Uuid::new_v4().to_string();
        let now = now_iso();
        let it = json!({
            "id": item_uuid,
            "archiveId": id,
            "itemId": item_id,
            "createdAt": now,
        });

        if let Some(items_map) = items_doc.as_object_mut() {
            items_map.insert(item_uuid, it.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(item_uuid, it.clone());
            items_doc = Value::Object(map);
        }
        write_json(&items_file, &items_doc).await?;

        archive["updatedAt"] = json!(now);
        write_json(&archives_file, &archives_doc).await?;
        it
    };

    Ok(Json(item))
}

async fn remove_archive_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, item_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let archives_file = store_path(&state, "archives.json");
    let archives_doc = read_json(&archives_file, json!({})).await?;

    let archive = archives_doc
        .get(&id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Archive not found".to_string()))?;

    if archive.get("userId").and_then(|u| u.as_str()) != Some(&uid) {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }

    let items_file = store_path(&state, "archive-items.json");
    {
        let _lock = state.store.lock().await;
        let mut items_doc = read_json(&items_file, json!({})).await?;
        if let Some(items_map) = items_doc.as_object_mut() {
            items_map.retain(|k, v| {
                let matches_archive = v.get("archiveId").and_then(|a| a.as_str()) == Some(&id);
                let matches_item = k == &item_id
                    || v.get("itemId").and_then(|i| i.as_str()) == Some(&item_id)
                    || v.get("id").and_then(|i| i.as_str()) == Some(&item_id);
                !(matches_archive && matches_item)
            });
        }
        write_json(&items_file, &items_doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/archive", get(list_archives).post(create_archive))
        .route(
            "/api/archive/{id}",
            get(get_archive_by_id)
                .put(put_archive_by_id)
                .delete(delete_archive_by_id),
        )
        .route("/api/archive/{id}/items", post(add_archive_item))
        .route("/api/archive/{id}/items/{itemId}", delete(remove_archive_item))
}
