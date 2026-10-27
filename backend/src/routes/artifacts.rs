// backend/src/routes/artifacts.rs -- user-visible file Artifacts.
//
// Vellum-style: the agent (or the user) generates a document — markdown, html,
// code, csv, pdf, word — it is saved as a real file inside the agent workspace
// at `artifacts/<userId>/<artifactId>/<filename>` so it is visible in the
// workspace browser, and its metadata lives in `<AMIRO_HOME>/store/artifacts.json`.
// The UI lists, previews and downloads them; the agent manages them through
// `artifact_*` MCP tools that call the same functions as these routes.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const MAX_ARTIFACT_BYTES: usize = 10 * 1024 * 1024;
const INLINE_TEXT_LIMIT: usize = 512 * 1024;

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

fn store_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("artifacts.json")
}

fn err(status: StatusCode, msg: &str) -> ApiError {
    ApiError(status, msg.to_string())
}

/// Safe filename: keep the base name, replace path separators and controls.
pub fn safe_filename(raw: &str) -> String {
    let base = std::path::Path::new(raw)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "artifact".to_string());
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "artifact".to_string()
    } else {
        cleaned.chars().take(128).collect()
    }
}

/// Kind inferred from filename/mime when the caller does not pin one.
pub fn infer_kind(filename: &str, mime: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "md" | "markdown" => "markdown".to_string(),
        "html" | "htm" => "html".to_string(),
        "pdf" => "pdf".to_string(),
        "docx" => "docx".to_string(),
        "csv" => "csv".to_string(),
        "json" => "json".to_string(),
        "svg" => "svg".to_string(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" => "image".to_string(),
        "xhtml" => "html".to_string(),
        _ => {
            if mime.starts_with("text/markdown") {
                "markdown".to_string()
            } else if mime.starts_with("text/html") {
                "html".to_string()
            } else if mime == "application/pdf" {
                "pdf".to_string()
            } else if mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
                "docx".to_string()
            } else if mime.starts_with("text/") || mime == "application/json" {
                "text".to_string()
            } else if ext == "js"
                || ext == "ts"
                || ext == "tsx"
                || ext == "py"
                || ext == "rs"
                || ext == "go"
                || ext == "java"
                || ext == "css"
                || ext == "sql"
            {
                "code".to_string()
            } else {
                "text".to_string()
            }
        }
    }
}

fn mime_for(filename: &str, kind: &str) -> String {
    let guess = mime_guess::from_path(filename).first();
    if let Some(m) = guess {
        let s = m.essence_str();
        if s != "application/octet-stream" {
            return s.to_string();
        }
    }
    match kind {
        "markdown" => "text/markdown".to_string(),
        "html" => "text/html".to_string(),
        "pdf" => "application/pdf".to_string(),
        "docx" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()
        }
        "csv" => "text/csv".to_string(),
        "json" => "application/json".to_string(),
        "code" | "text" => "text/plain".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn is_text_kind(kind: &str, mime: &str) -> bool {
    matches!(kind, "markdown" | "html" | "code" | "text" | "csv" | "json" | "svg")
        || mime.starts_with("text/")
        || mime == "application/json"
        || mime == "image/svg+xml"
}

fn artifact_dir(state: &AppState, owner: &str, id: &str) -> std::path::PathBuf {
    state
        .workspace
        .join("artifacts")
        .join(safe_filename(owner))
        .join(safe_filename(id))
}

fn workspace_rel(owner: &str, id: &str, filename: &str) -> String {
    format!(
        "artifacts/{}/{}/{}",
        safe_filename(owner),
        safe_filename(id),
        safe_filename(filename)
    )
}

#[derive(Deserialize, Default)]
struct CreateBody {
    title: Option<String>,
    kind: Option<String>,
    language: Option<String>,
    filename: Option<String>,
    mime: Option<String>,
    #[serde(rename = "contentText")]
    content_text: Option<String>,
    #[serde(rename = "contentBase64")]
    content_base64: Option<String>,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct UpdateBody {
    title: Option<String>,
    #[serde(rename = "contentText")]
    content_text: Option<String>,
    #[serde(rename = "contentBase64")]
    content_base64: Option<String>,
}

#[derive(Deserialize, Default)]
struct DownloadQuery {
    inline: Option<String>,
}

fn decode_body(body: &CreateBody) -> Result<Vec<u8>, ApiError> {
    match (&body.content_text, &body.content_base64) {
        (Some(_), Some(_)) => Err(err(
            StatusCode::BAD_REQUEST,
            "Provide contentText or contentBase64, not both",
        )),
        (Some(text), None) => {
            let bytes = text.as_bytes().to_vec();
            if bytes.len() > MAX_ARTIFACT_BYTES {
                return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "Artifact exceeds 10 MiB"));
            }
            Ok(bytes)
        }
        (None, Some(b64)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|_| err(StatusCode::BAD_REQUEST, "contentBase64 is not valid base64"))?;
            if bytes.len() > MAX_ARTIFACT_BYTES {
                return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "Artifact exceeds 10 MiB"));
            }
            Ok(bytes)
        }
        (None, None) => Err(err(
            StatusCode::BAD_REQUEST,
            "contentText or contentBase64 is required",
        )),
    }
}

fn decode_update(body: &UpdateBody) -> Result<Option<Vec<u8>>, ApiError> {
    match (&body.content_text, &body.content_base64) {
        (Some(_), Some(_)) => Err(err(
            StatusCode::BAD_REQUEST,
            "Provide contentText or contentBase64, not both",
        )),
        (Some(text), None) => {
            let bytes = text.as_bytes().to_vec();
            if bytes.len() > MAX_ARTIFACT_BYTES {
                return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "Artifact exceeds 10 MiB"));
            }
            Ok(Some(bytes))
        }
        (None, Some(b64)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|_| err(StatusCode::BAD_REQUEST, "contentBase64 is not valid base64"))?;
            if bytes.len() > MAX_ARTIFACT_BYTES {
                return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "Artifact exceeds 10 MiB"));
            }
            Ok(Some(bytes))
        }
        (None, None) => Ok(None),
    }
}

fn summary_of(entry: &Value) -> Value {
    json!({
        "id": entry.get("id").cloned().unwrap_or(Value::Null),
        "title": entry.get("title").cloned().unwrap_or(Value::Null),
        "kind": entry.get("kind").cloned().unwrap_or(Value::Null),
        "language": entry.get("language").cloned().unwrap_or(Value::Null),
        "filename": entry.get("filename").cloned().unwrap_or(Value::Null),
        "mime": entry.get("mime").cloned().unwrap_or(Value::Null),
        "size": entry.get("size").cloned().unwrap_or(Value::Null),
        "threadId": entry.get("threadId").cloned().unwrap_or(Value::Null),
        "workspacePath": entry.get("workspacePath").cloned().unwrap_or(Value::Null),
        "createdAt": entry.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": entry.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

/// Shared create used by the HTTP route and the `artifact_create` agent tool.
pub async fn create_artifact_record(
    state: &AppState,
    owner: &str,
    title: Option<String>,
    kind: Option<String>,
    language: Option<String>,
    filename: Option<String>,
    mime: Option<String>,
    thread_id: Option<String>,
    bytes: Vec<u8>,
) -> Result<Value, ApiError> {
    if owner.is_empty() {
        return Err(err(StatusCode::UNAUTHORIZED, "Sign in is required"));
    }
    let filename = safe_filename(filename.as_deref().unwrap_or("artifact.md"));
    let mime = mime.unwrap_or_else(|| mime_for(&filename, kind.as_deref().unwrap_or("")));
    let kind = kind.unwrap_or_else(|| infer_kind(&filename, &mime));
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| filename.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let dir = artifact_dir(state, owner, &id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Could not save the artifact: {e}"),
        )
    })?;
    let target = dir.join(&filename);
    tokio::fs::write(&target, &bytes).await.map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Could not save the artifact: {e}"),
        )
    })?;
    let stamp = now_iso();
    let mut entry = json!({
        "id": id,
        "ownerId": owner,
        "title": title,
        "kind": kind,
        "filename": filename,
        "mime": mime,
        "size": bytes.len(),
        "workspacePath": workspace_rel(owner, &id, &filename),
        "createdAt": stamp,
        "updatedAt": stamp,
    });
    match language.filter(|s| !s.trim().is_empty()) {
        Some(lang) => entry["language"] = json!(lang),
        None => entry["language"] = Value::Null,
    }
    match thread_id.filter(|s| !s.trim().is_empty()) {
        Some(thread) => entry["threadId"] = json!(thread),
        None => entry["threadId"] = Value::Null,
    }
    let file = store_path(state);
    {
        let _guard = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if !doc.is_object() {
            doc = json!({});
        }
        doc[&id] = entry.clone();
        write_json(&file, &doc).await?;
    }
    Ok(entry)
}

/// Shared update used by the HTTP route and the `artifact_update` agent tool.
pub async fn update_artifact_record(
    state: &AppState,
    owner: &str,
    id: &str,
    title: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<Value, ApiError> {
    let file = store_path(state);
    let _guard = state.store.lock().await;
    let mut doc = read_json(&file, json!({})).await?;
    let entry = doc.get_mut(id).ok_or_else(|| err(StatusCode::NOT_FOUND, "Artifact not found"))?;
    if entry.get("ownerId").and_then(|v| v.as_str()) != Some(owner) {
        return Err(err(StatusCode::NOT_FOUND, "Artifact not found"));
    }
    if let Some(title) = title {
        if title.trim().is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "Title must not be empty"));
        }
        entry["title"] = json!(title);
    }
    if let Some(bytes) = bytes {
        let filename = entry
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("artifact.md")
            .to_string();
        let dir = artifact_dir(state, owner, id);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Could not save the artifact: {e}"),
            )
        })?;
        tokio::fs::write(dir.join(&filename), &bytes)
            .await
            .map_err(|e| {
                err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Could not save the artifact: {e}"),
                )
            })?;
        entry["size"] = json!(bytes.len());
        entry["workspacePath"] = json!(workspace_rel(owner, id, &filename));
    }
    entry["updatedAt"] = json!(now_iso());
    let out = entry.clone();
    write_json(&file, &doc).await?;
    Ok(out)
}

/// Shared delete used by the HTTP route and the agent tool.
pub async fn delete_artifact_record(
    state: &AppState,
    owner: &str,
    id: &str,
) -> Result<(), ApiError> {
    let file = store_path(state);
    let _guard = state.store.lock().await;
    let mut doc = read_json(&file, json!({})).await?;
    let entry = doc.get(id).ok_or_else(|| err(StatusCode::NOT_FOUND, "Artifact not found"))?;
    if entry.get("ownerId").and_then(|v| v.as_str()) != Some(owner) {
        return Err(err(StatusCode::NOT_FOUND, "Artifact not found"));
    }
    if let Some(map) = doc.as_object_mut() {
        map.remove(id);
    }
    write_json(&file, &doc).await?;
    drop(_guard);
    let dir = artifact_dir(state, owner, id);
    let _ = tokio::fs::remove_dir_all(&dir).await;
    Ok(())
}

async fn list_artifacts(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let doc = read_json(&store_path(&state), json!({})).await?;
    let mut items: Vec<Value> = doc
        .as_object()
        .map(|m| {
            m.values()
                .filter(|e| e.get("ownerId").and_then(|v| v.as_str()) == Some(&uid))
                .map(summary_of)
                .collect()
        })
        .unwrap_or_default();
    items.sort_by(|a, b| {
        b.get("createdAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(a.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(Json(Value::Array(items)))
}

async fn post_artifact(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let bytes = decode_body(&body)?;
    let entry = create_artifact_record(
        &state,
        &uid,
        body.title,
        body.kind,
        body.language,
        body.filename,
        body.mime,
        body.thread_id,
        bytes,
    )
    .await?;
    Ok(Json(summary_of(&entry)))
}

async fn get_artifact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let doc = read_json(&store_path(&state), json!({})).await?;
    let entry = doc.get(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "Artifact not found"))?;
    if entry.get("ownerId").and_then(|v| v.as_str()) != Some(&uid) {
        return Err(err(StatusCode::NOT_FOUND, "Artifact not found"));
    }
    let mut out = summary_of(entry);
    let kind = entry.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let mime = entry.get("mime").and_then(|v| v.as_str()).unwrap_or("");
    let size = entry.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    if is_text_kind(kind, mime) && size <= INLINE_TEXT_LIMIT {
        let rel = entry
            .get("workspacePath")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let abs = state.workspace.join(rel);
        match tokio::fs::read(&abs).await {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => out["contentText"] = json!(text),
                Err(_) => out["contentText"] = Value::Null,
            },
            Err(_) => out["contentText"] = Value::Null,
        }
    }
    Ok(Json(out))
}

async fn put_artifact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let bytes = decode_update(&body)?;
    if body.title.is_none() && bytes.is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "Nothing to update"));
    }
    let entry = update_artifact_record(&state, &uid, &id, body.title, bytes).await?;
    Ok(Json(summary_of(&entry)))
}

async fn delete_artifact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    delete_artifact_record(&state, &uid, &id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn download_artifact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(query): Query<DownloadQuery>,
) -> Result<Response, ApiError> {
    let uid = user_id_of(&user);
    let doc = read_json(&store_path(&state), json!({})).await?;
    let entry = doc.get(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "Artifact not found"))?;
    if entry.get("ownerId").and_then(|v| v.as_str()) != Some(&uid) {
        return Err(err(StatusCode::NOT_FOUND, "Artifact not found"));
    }
    let rel = entry
        .get("workspacePath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if rel.is_empty() || rel.contains("..") {
        return Err(err(StatusCode::NOT_FOUND, "Artifact file is missing"));
    }
    let abs = state.workspace.join(rel);
    let data = tokio::fs::read(&abs)
        .await
        .map_err(|_| err(StatusCode::NOT_FOUND, "Artifact file is missing"))?;
    let mime = entry
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();
    let filename = entry
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("artifact");
    let inline = query.inline.as_deref() == Some("1") || query.inline.as_deref() == Some("true");
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(CONTENT_TYPE, v);
    }
    let disposition = format!(
        "{}; filename=\"{}\"",
        if inline { "inline" } else { "attachment" },
        filename.replace(['\r', '\n', '"'], "_")
    );
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        headers.insert(CONTENT_DISPOSITION, v);
    }
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox allow-downloads; default-src 'none'"),
    );
    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(CONTENT_LENGTH, HeaderValue::from(data.len()));
    Ok((StatusCode::OK, headers, Bytes::from(data)).into_response())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/artifacts", get(list_artifacts).post(post_artifact))
        .route(
            "/api/artifacts/{id}",
            get(get_artifact).put(put_artifact).delete(delete_artifact),
        )
        .route("/api/artifacts/{id}/download", get(download_artifact))
        // Back-compat: some clients address the singleton path without an id.
        .route("/api/artifact", post(post_artifact))
        // Wide clients (axum 0.7): keep the trailing-slash form working too.
        .route("/api/artifacts/", get(list_artifacts).post(post_artifact))
        // The UI streams uploads under /api/artifacts/upload for symmetry with /storage.
        .route("/api/artifacts/upload", post(post_artifact))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_strips_paths() {
        assert_eq!(safe_filename("../../etc/passwd"), "passwd");
        assert_eq!(safe_filename("a/b\\c.md"), "b_c.md");
        assert_eq!(safe_filename(""), "artifact");
    }

    #[test]
    fn kind_inference_covers_office_shapes() {
        assert_eq!(infer_kind("doc.pdf", "application/octet-stream"), "pdf");
        assert_eq!(
            infer_kind(
                "report.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ),
            "docx"
        );
        assert_eq!(infer_kind("notes.md", "text/plain"), "markdown");
        assert_eq!(infer_kind("app.ts", "text/plain"), "text");
    }

    #[test]
    fn empty_optionals_note() {
        let v = json!({"language": "", "threadId": ""});
        assert!(v["language"].as_str() == Some(""));
    }

    #[test]
    fn compat_route_names() {
        let _r: Router<AppState> = routes();
    }
}
