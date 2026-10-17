use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
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

async fn list_mcp_servers(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let servers_file = store_path(&state, "mcp-servers.json");
    let doc = read_json(&servers_file, json!({})).await?;

    let mut result = Vec::new();
    if let Some(map) = doc.as_object() {
        for s in map.values() {
            let server_uid = s.get("userId").and_then(|u| u.as_str()).unwrap_or("");
            let visibility = s.get("visibility").and_then(|v| v.as_str()).unwrap_or("private");

            if server_uid == uid || visibility == "public" {
                let mut item = json!({
                    "id": s.get("id").cloned().unwrap_or(json!("")),
                    "name": s.get("name").cloned().unwrap_or(json!("")),
                    "status": s.get("status").cloned().unwrap_or(json!("connected")),
                    "toolInfo": s.get("toolInfo").cloned().unwrap_or(json!([])),
                    "error": s.get("error").cloned().unwrap_or(Value::Null),
                    "visibility": visibility,
                    "userId": server_uid,
                });
                if server_uid == uid {
                    if let Some(cfg) = s.get("config") {
                        item["config"] = cfg.clone();
                    }
                }
                result.push(item);
            }
        }
    }

    Ok(Json(Value::Array(result)))
}

async fn create_or_update_mcp_server(
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

    let id = body
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let now = now_iso();
    let config = body.get("config").cloned().unwrap_or(json!({}));
    let visibility = body
        .get("visibility")
        .and_then(|v| v.as_str())
        .unwrap_or("private");

    let server = json!({
        "id": id,
        "name": name,
        "config": config,
        "visibility": visibility,
        "userId": uid,
        "status": "connected",
        "toolInfo": [],
        "createdAt": now,
        "updatedAt": now,
    });

    let servers_file = store_path(&state, "mcp-servers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&servers_file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.insert(id.clone(), server);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(id.clone(), server);
            doc = Value::Object(map);
        }
        write_json(&servers_file, &doc).await?;
    }

    Ok(Json(json!({ "success": true, "id": id })))
}

async fn get_mcp_server_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let servers_file = store_path(&state, "mcp-servers.json");
    let doc = read_json(&servers_file, json!({})).await?;

    let server = doc
        .get(&id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "MCP server not found".to_string()))?;

    let server_uid = server.get("userId").and_then(|u| u.as_str()).unwrap_or("");
    let visibility = server.get("visibility").and_then(|v| v.as_str()).unwrap_or("private");

    if server_uid != uid && visibility != "public" {
        return Err(ApiError(StatusCode::FORBIDDEN, "Unauthorized".to_string()));
    }

    let mut item = server.clone();
    if server_uid != uid {
        if let Some(obj) = item.as_object_mut() {
            obj.remove("config");
        }
    }

    Ok(Json(item))
}

async fn delete_mcp_server_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");

    let servers_file = store_path(&state, "mcp-servers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&servers_file, json!({})).await?;

        let map = doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "MCP server not found".to_string()))?;

        let server = map
            .get(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "MCP server not found".to_string()))?;

        let server_uid = server.get("userId").and_then(|u| u.as_str()).unwrap_or("");
        if server_uid != uid && role != "admin" {
            return Err(ApiError(StatusCode::FORBIDDEN, "Unauthorized".to_string()));
        }

        map.remove(&id);
        write_json(&servers_file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn refresh_mcp_server(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let servers_file = store_path(&state, "mcp-servers.json");
    let doc = read_json(&servers_file, json!({})).await?;

    if doc.get(&id).is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "MCP server not found".to_string()));
    }

    Ok(Json(json!({ "success": true })))
}

async fn share_mcp_server(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");

    let servers_file = store_path(&state, "mcp-servers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&servers_file, json!({})).await?;

        let map = doc
            .as_object_mut()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "MCP server not found".to_string()))?;

        let server = map
            .get_mut(&id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "MCP server not found".to_string()))?;

        let server_uid = server.get("userId").and_then(|u| u.as_str()).unwrap_or("");
        if server_uid != uid && role != "admin" {
            return Err(ApiError(StatusCode::FORBIDDEN, "Unauthorized".to_string()));
        }

        let visibility = if body.get("visibility").and_then(|v| v.as_str()) == Some("public") {
            "public"
        } else {
            "private"
        };

        server["visibility"] = json!(visibility);
        write_json(&servers_file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn call_mcp_tool(
    _user: AuthUser,
    Path((id, tool)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "tool": tool,
        "server": id,
        "result": format!("Tool {tool} called on {id}"),
        "input": body,
    })))
}

async fn oauth_authorize(
    _user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let encoded = url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
    let url = format!("/api/mcp/oauth/callback?server={encoded}");
    Ok(Json(json!({ "authorizationUrl": url })))
}

async fn oauth_callback() -> Response {
    let html = r#"<!DOCTYPE html>
<html>
<head><title>MCP OAuth Connected</title></head>
<body>
  <h2>Authentication Successful</h2>
  <p>You can close this window now.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-success' }, '*');
    }
    setTimeout(function() { window.close(); }, 1500);
  </script>
</body>
</html>"#;
    Html(html).into_response()
}

async fn get_server_customization(
    State(state): State<AppState>,
    user: AuthUser,
    Path(server): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = format!("{uid}:{server}");
    let file = store_path(&state, "mcp-server-customizations.json");
    let doc = read_json(&file, json!({})).await?;
    let cust = doc.get(&key).cloned().unwrap_or(Value::Null);
    Ok(Json(cust))
}

async fn post_server_customization(
    State(state): State<AppState>,
    user: AuthUser,
    Path(server): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = format!("{uid}:{server}");
    let prompt = body
        .get("prompt")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);

    let now = now_iso();
    let entry = json!({
        "id": Uuid::new_v4().to_string(),
        "userId": uid,
        "mcpServerId": server,
        "prompt": prompt,
        "createdAt": now,
        "updatedAt": now,
    });

    let file = store_path(&state, "mcp-server-customizations.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.insert(key, entry.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(key, entry.clone());
            doc = Value::Object(map);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(entry))
}

async fn delete_server_customization(
    State(state): State<AppState>,
    user: AuthUser,
    Path(server): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = format!("{uid}:{server}");
    let file = store_path(&state, "mcp-server-customizations.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.remove(&key);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn list_tool_customizations(
    State(state): State<AppState>,
    user: AuthUser,
    Path(server): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let file = store_path(&state, "mcp-tool-customizations.json");
    let doc = read_json(&file, json!({})).await?;

    let mut result = Vec::new();
    if let Some(map) = doc.as_object() {
        for c in map.values() {
            if c.get("userId").and_then(|u| u.as_str()) == Some(&uid)
                && c.get("server").and_then(|s| s.as_str()) == Some(&server)
            {
                result.push(c.clone());
            }
        }
    }

    Ok(Json(Value::Array(result)))
}

async fn get_tool_customization(
    State(state): State<AppState>,
    user: AuthUser,
    Path((server, tool)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = format!("{uid}:{server}:{tool}");
    let file = store_path(&state, "mcp-tool-customizations.json");
    let doc = read_json(&file, json!({})).await?;
    let cust = doc.get(&key).cloned().unwrap_or(Value::Null);
    Ok(Json(cust))
}

async fn post_tool_customization(
    State(state): State<AppState>,
    user: AuthUser,
    Path((server, tool)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = format!("{uid}:{server}:{tool}");
    let prompt = body
        .get("prompt")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);

    let now = now_iso();
    let entry = json!({
        "id": Uuid::new_v4().to_string(),
        "userId": uid,
        "server": server,
        "tool": tool,
        "prompt": prompt,
        "createdAt": now,
        "updatedAt": now,
    });

    let file = store_path(&state, "mcp-tool-customizations.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.insert(key, entry.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(key, entry.clone());
            doc = Value::Object(map);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(entry))
}

async fn delete_tool_customization(
    State(state): State<AppState>,
    user: AuthUser,
    Path((server, tool)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = format!("{uid}:{server}:{tool}");
    let file = store_path(&state, "mcp-tool-customizations.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.remove(&key);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/mcp/list", get(list_mcp_servers))
        .route("/api/mcp", post(create_or_update_mcp_server))
        .route(
            "/api/mcp/servers/{id}",
            get(get_mcp_server_by_id).delete(delete_mcp_server_by_id),
        )
        .route("/api/mcp/servers/{id}/refresh", post(refresh_mcp_server))
        .route("/api/mcp/servers/{id}/share", post(share_mcp_server))
        .route(
            "/api/mcp/servers/{id}/tools/{tool}/call",
            post(call_mcp_tool),
        )
        .route(
            "/api/mcp/servers/{id}/oauth/authorize",
            post(oauth_authorize),
        )
        .route("/api/mcp/oauth/callback", get(oauth_callback))
        .route(
            "/api/mcp/server-customizations/{server}",
            get(get_server_customization)
                .post(post_server_customization)
                .delete(delete_server_customization),
        )
        .route(
            "/api/mcp/tool-customizations/{server}",
            get(list_tool_customizations),
        )
        .route(
            "/api/mcp/tool-customizations/{server}/{tool}",
            get(get_tool_customization)
                .post(post_tool_customization)
                .delete(delete_tool_customization),
        )
}
