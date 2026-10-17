use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::auth::{hash_password, verify_password};
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

async fn get_user_details(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let users_file = state.home.join("users.json");
    let doc = read_json(&users_file, json!({ "users": [] })).await?;

    let users = doc.get("users").and_then(|u| u.as_array());
    let found = users
        .and_then(|arr| arr.iter().find(|u| u.get("id").and_then(|i| i.as_str()) == Some(&uid)))
        .unwrap_or(&user.0);

    let prefs_file = store_path(&state, "user-preferences.json");
    let prefs_doc = read_json(&prefs_file, json!({})).await?;
    let prefs = prefs_doc.get(&uid).cloned().unwrap_or(json!({}));

    let name = found.get("name").cloned().unwrap_or(json!(""));
    let email = found.get("email").cloned().unwrap_or(json!(""));
    let role = found.get("role").cloned().unwrap_or(json!("user"));
    let image = found.get("image").cloned().unwrap_or(Value::Null);
    let created_at = found.get("createdAt").cloned().unwrap_or_else(|| json!(now_iso()));
    let last_login = found.get("lastLogin").cloned().unwrap_or(Value::Null);

    Ok(Json(json!({
        "id": uid,
        "name": name,
        "email": email,
        "role": role,
        "image": image,
        "preferences": prefs,
        "createdAt": created_at,
        "lastLogin": last_login,
    })))
}

async fn put_user_details(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let users_file = state.home.join("users.json");
    let returned_user = {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&users_file, json!({ "users": [] })).await?;

        let users_arr = doc
            .get_mut("users")
            .and_then(|u| u.as_array_mut())
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "user not found".to_string()))?;

        let found = users_arr
            .iter_mut()
            .find(|u| u.get("id").and_then(|i| i.as_str()) == Some(&uid))
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "user not found".to_string()))?;

        if let Some(name_val) = body.get("name") {
            let name_str = name_val.as_str().unwrap_or("").trim();
            found["name"] = json!(name_str);
        }
        if let Some(image_val) = body.get("image") {
            if image_val.is_null() {
                found["image"] = Value::Null;
            } else {
                let img_str = image_val.as_str().unwrap_or("").trim();
                if img_str.is_empty() {
                    found["image"] = Value::Null;
                } else {
                    found["image"] = json!(img_str);
                }
            }
        }
        found["updatedAt"] = json!(now_iso());

        let ret = json!({
            "id": uid,
            "name": found.get("name").cloned().unwrap_or(json!("")),
            "email": found.get("email").cloned().unwrap_or(json!("")),
            "role": found.get("role").cloned().unwrap_or(json!("user")),
            "image": found.get("image").cloned().unwrap_or(Value::Null),
            "createdAt": found.get("createdAt").cloned().unwrap_or_else(|| json!(now_iso())),
            "lastLogin": found.get("lastLogin").cloned().unwrap_or(Value::Null),
        });

        write_json(&users_file, &doc).await?;
        ret
    };

    Ok(Json(returned_user))
}

async fn put_user_password(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let current_password = body
        .get("currentPassword")
        .and_then(|p| p.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    let new_password = body
        .get("newPassword")
        .and_then(|p| p.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    if current_password.is_empty() || new_password.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "currentPassword and newPassword are required".to_string(),
        ));
    }

    let uid = user_id_of(&user);
    let users_file = state.home.join("users.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&users_file, json!({ "users": [] })).await?;

        let users_arr = doc
            .get_mut("users")
            .and_then(|u| u.as_array_mut())
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "user not found".to_string()))?;

        let found = users_arr
            .iter_mut()
            .find(|u| u.get("id").and_then(|i| i.as_str()) == Some(&uid))
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "user not found".to_string()))?;

        let stored_hash = found
            .get("passwordHash")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if !verify_password(current_password, &stored_hash).await.unwrap_or(false) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Invalid current password".to_string(),
            ));
        }

        let new_hash = hash_password(new_password).await?;
        found["passwordHash"] = json!(new_hash);
        found["mustChangePassword"] = json!(false);
        found["updatedAt"] = json!(now_iso());

        write_json(&users_file, &doc).await?;
    }
    Ok(Json(json!({ "success": true })))
}

async fn get_user_auth_methods(_user: AuthUser) -> Json<Value> {
    Json(json!({ "hasPassword": true }))
}

async fn get_user_preferences(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let prefs_file = store_path(&state, "user-preferences.json");
    let prefs_doc = read_json(&prefs_file, json!({})).await?;
    let user_prefs = prefs_doc.get(&uid).cloned().unwrap_or(json!({}));
    Ok(Json(user_prefs))
}

async fn put_user_preferences(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let prefs_file = store_path(&state, "user-preferences.json");
    let mut prefs_doc = read_json(&prefs_file, json!({})).await?;

    let mut updated = serde_json::Map::new();
    if let Some(v) = body.get("displayName") {
        if !v.is_null() && v.as_str() != Some("") {
            updated.insert("displayName".to_string(), v.clone());
        }
    }
    if let Some(v) = body.get("profession") {
        if !v.is_null() && v.as_str() != Some("") {
            updated.insert("profession".to_string(), v.clone());
        }
    }
    if let Some(v) = body.get("responseStyleExample") {
        if !v.is_null() && v.as_str() != Some("") {
            updated.insert("responseStyleExample".to_string(), v.clone());
        }
    }
    if let Some(v) = body.get("botName") {
        if !v.is_null() && v.as_str() != Some("") {
            updated.insert("botName".to_string(), v.clone());
        }
    }

    let updated_val = Value::Object(updated);
    {
        let _lock = state.store.lock().await;
        if let Some(obj) = prefs_doc.as_object_mut() {
            obj.insert(uid, updated_val.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(uid, updated_val.clone());
            prefs_doc = Value::Object(map);
        }

        write_json(&prefs_file, &prefs_doc).await?;
    }
    Ok(Json(updated_val))
}

async fn dead_user_stats() -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

async fn dead_user_details_id(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/user/details", get(get_user_details).put(put_user_details))
        .route("/api/user/password", put(put_user_password))
        .route("/api/user/auth-methods", get(get_user_auth_methods))
        .route(
            "/api/user/preferences",
            get(get_user_preferences).put(put_user_preferences),
        )
        .route("/api/user/stats", get(dead_user_stats))
        .route("/api/user/details/{id}", get(dead_user_details_id))
}
