use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::header::{HeaderMap, HeaderValue, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use std::path::{Path as FsPath, PathBuf};

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const MAX_UPLOAD_SIZE: usize = 32 * 1024 * 1024; // 32 MiB

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

pub fn is_valid_token(token: &str) -> bool {
    token.len() == 48 && token.chars().all(|c| c.is_ascii_hexdigit())
}

async fn get_token_info(state: &AppState, token: &str) -> Result<Option<Value>, ApiError> {
    if !is_valid_token(token) {
        return Ok(None);
    }
    let tokens_file = store_path(state, "storage-tokens.json");
    let tokens_doc = read_json(&tokens_file, json!({})).await?;
    if let Some(info) = tokens_doc.get(token) {
        if let Some(exp_str) = info.get("expiresAt").and_then(|s| s.as_str()) {
            if let Ok(exp_dt) = chrono::DateTime::parse_from_rfc3339(exp_str) {
                if exp_dt > Utc::now() {
                    return Ok(Some(info.clone()));
                }
            }
        }
    }
    Ok(None)
}

async fn post_upload_url(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let mut rand_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut rand_bytes);
    let token = hex::encode(rand_bytes);

    let raw_filename = body
        .get("filename")
        .and_then(|f| f.as_str())
        .unwrap_or("file");
    let filename = FsPath::new(raw_filename)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string())
        .replace(['\r', '\n', '"'], "_");

    let content_type = body
        .get("contentType")
        .and_then(|c| c.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();

    let expires_at = (Utc::now() + Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let info = json!({
        "filename": filename,
        "contentType": content_type,
        "userId": uid,
        "expiresAt": expires_at,
    });

    let tokens_file = store_path(&state, "storage-tokens.json");
    {
        let _lock = state.store.lock().await;
        let mut tokens_doc = read_json(&tokens_file, json!({})).await?;
        if let Some(map) = tokens_doc.as_object_mut() {
            map.insert(token.clone(), info.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(token.clone(), info.clone());
            tokens_doc = Value::Object(map);
        }
        write_json(&tokens_file, &tokens_doc).await?;
    }

    let url = format!("/storage/{token}");
    Ok(Json(json!({
        "directUploadSupported": true,
        "key": token,
        "url": url,
        "method": "PUT",
        "headers": { "Content-Type": content_type },
        "sourceUrl": url,
    })))
}

async fn put_storage_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let info = get_token_info(&state, &token).await?;
    if info.is_none() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Unknown or expired upload capability".to_string(),
        ));
    }

    if body.len() > MAX_UPLOAD_SIZE {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "File exceeds 32 MiB".to_string(),
        ));
    }

    let storage_dir = state.home.join("storage");
    tokio::fs::create_dir_all(&storage_dir)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&storage_dir, std::fs::Permissions::from_mode(0o700));
    }

    let target_file = storage_dir.join(&token);

    // Symlink safety: verify target is not a symlink
    if let Ok(meta) = tokio::fs::symlink_metadata(&target_file).await {
        if meta.file_type().is_symlink() {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Symlinks not permitted in storage directory".to_string(),
            ));
        }
    }

    tokio::fs::write(&target_file, &body)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target_file, std::fs::Permissions::from_mode(0o600));
    }

    Ok(Json(json!({ "success": true, "size": body.len() })))
}

async fn get_storage_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    let info = get_token_info(&state, &token).await?;
    let info = info.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            "Unknown or expired upload capability".to_string(),
        )
    })?;

    let storage_dir = state.home.join("storage");
    let target_file = storage_dir.join(&token);

    // Symlink safety
    if let Ok(meta) = tokio::fs::symlink_metadata(&target_file).await {
        if meta.file_type().is_symlink() {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }
    }

    let data = tokio::fs::read(&target_file).await.map_err(|_| {
        ApiError(StatusCode::NOT_FOUND, "File not found".to_string())
    })?;

    let filename = info
        .get("filename")
        .and_then(|f| f.as_str())
        .unwrap_or("file")
        .chars()
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '_' })
        .collect::<String>();

    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let disposition = format!("attachment; filename=\"{filename}\"");
    if let Ok(val) = HeaderValue::from_str(&disposition) {
        headers.insert(CONTENT_DISPOSITION, val);
    }
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(CONTENT_LENGTH, HeaderValue::from(data.len()));

    Ok((StatusCode::OK, headers, data).into_response())
}

async fn post_storage_ingest(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if body.get("url").is_some() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "Remote URL ingestion is not enabled".to_string(),
        ));
    }

    let key = body.get("key").and_then(|k| k.as_str()).unwrap_or("");
    let uid = user_id_of(&user);

    let info = get_token_info(&state, key).await?;
    let info = info.ok_or_else(|| {
        ApiError(StatusCode::NOT_FOUND, "File not found".to_string())
    })?;

    if info.get("userId").and_then(|u| u.as_str()) != Some(&uid) {
        return Err(ApiError(StatusCode::NOT_FOUND, "File not found".to_string()));
    }

    let target_file = state.home.join("storage").join(key);
    if let Ok(meta) = tokio::fs::symlink_metadata(&target_file).await {
        if meta.file_type().is_symlink() {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }
    }

    let text = tokio::fs::read_to_string(&target_file).await.map_err(|_| {
        ApiError(StatusCode::NOT_FOUND, "File not found".to_string())
    })?;

    Ok(Json(json!({ "text": text })))
}

async fn dead_storage_upload() -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/storage/upload-url", post(post_upload_url))
        .route("/storage/{token}", put(put_storage_token).get(get_storage_token))
        .route("/api/storage/ingest", post(post_storage_ingest))
        .route("/api/storage/upload", post(dead_storage_upload))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE))
}
