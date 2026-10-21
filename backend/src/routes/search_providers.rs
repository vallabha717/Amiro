use amiro_config_types::{CustomWebSearchConfig, CustomWebSearchMethod};
use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path as FilePath, PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::routes::agents::AgentState;
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const STORE: &str = "search-providers.json";
const MIGRATION: &str = "search-providers-free-seed-v1.json";
const REGISTRY: &str = "search-providers-runtime.json";

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn bad_request(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    Ok(())
}

/// Amiro keeps its search providers in `home/store`; a team agent keeps its
/// own in its private folder (outside its workspace, so its tools cannot read
/// the keys), so choosing one agent's engine never changes another's.
fn store_path(state: &AppState, key: &str) -> PathBuf {
    match state.agent_scope() {
        Some(agent) => crate::state::agent_private_root(&state.home, &agent)
            .join("store")
            .join(key),
        None => state.home.join("store").join(key),
    }
}

// Only providers whose protocol we actually implement are advertised. Old records
// for removed offerings (including Vellum) remain in storage, but are not eligible.
pub fn search_catalog() -> Vec<Value> {
    vec![
        json!({"kind":"duckduckgo","label":"DuckDuckGo","extracts":false,"freeTier":"Free HTML search, no API key required","docs":"https://duckduckgo.com","keyless":true}),
        json!({"kind":"bing","label":"Bing Search","extracts":false,"freeTier":"Free HTML search, optional API key","docs":"https://www.bing.com","keyless":true}),
        json!({"kind":"brave","label":"Brave Search","extracts":false,"freeTier":"Search API","docs":"https://brave.com/search/api/"}),
        json!({"kind":"tavily","label":"Tavily","extracts":true,"freeTier":"Search API with free tier","docs":"https://app.tavily.com/"}),
        json!({"kind":"exa","label":"Exa","extracts":true,"freeTier":"Search API","docs":"https://exa.ai"}),
        json!({"kind":"serper","label":"Serper","extracts":false,"freeTier":"Google search API","docs":"https://serper.dev"}),
        json!({"kind":"firecrawl","label":"Firecrawl","extracts":true,"freeTier":"Search API","docs":"https://www.firecrawl.dev","supportsApiBase":true,"defaultApiBase":"https://api.firecrawl.dev"}),
        json!({"kind":"searxng","label":"SearXNG","extracts":false,"freeTier":"Self-hosted / public metasearch","docs":"https://docs.searxng.org","supportsApiBase":true,"keyless":true}),
        json!({"kind":"custom","label":"Custom HTTP JSON Search","extracts":true,"freeTier":"Connect a configured HTTP JSON search API","docs":"https://github.com/1jehuang/jcode/blob/main/docs/custom-web-search.md","supportsApiBase":true,"supportsCustomConfig":true,"keyless":true}),
        json!({"kind":"inference-provider-native","label":"Provider Native","extracts":true,"freeTier":"Model provider's native web search","docs":"https://docs.anthropic.com","keyless":true}),
    ]
}

fn text<'a>(record: &'a Value, key: &str) -> &'a str {
    record.get(key).and_then(Value::as_str).unwrap_or("")
}

fn custom_value(record: &Value) -> Option<&Value> {
    record
        .get("custom")
        .filter(|v| !v.is_null())
        .or_else(|| record.get("customConfig").filter(|v| !v.is_null()))
}

fn supported(record: &Value) -> bool {
    search_catalog()
        .iter()
        .any(|spec| text(spec, "kind") == text(record, "provider"))
}

fn validate_url(endpoint: &str) -> Result<(), ApiError> {
    let url = url::Url::parse(endpoint)
        .map_err(|_| bad_request("search endpoint must be an absolute HTTP(S) URL"))?;
    if url.fragment().is_some() {
        return Err(bad_request("search endpoint must not contain a fragment"));
    }
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(bad_request(
            "search endpoint must be an absolute HTTP(S) URL without embedded credentials",
        ));
    }
    Ok(())
}

fn custom_config(record: &Value) -> Result<CustomWebSearchConfig, ApiError> {
    let kind = text(record, "provider");
    let key = text(record, "apiKey");
    let mut config = CustomWebSearchConfig::default();
    match kind {
        "brave" => {
            config.endpoint = "https://api.search.brave.com/res/v1/web/search".into();
            config.count_param = Some("count".into());
            config.results_pointer = "/web/results".into();
            config.snippet_pointer = "/description".into();
            config
                .headers
                .insert("X-Subscription-Token".into(), key.into());
            config
                .headers
                .insert("Accept".into(), "application/json".into());
        }
        "tavily" => {
            config.endpoint = "https://api.tavily.com/search".into();
            config.method = CustomWebSearchMethod::Post;
            config.query_param = "query".into();
            config.count_param = Some("max_results".into());
            config.snippet_pointer = "/content".into();
            // Tavily authenticates in the POST JSON body, not an api_key header.
            config.body = json!({"api_key":key});
        }
        "exa" => {
            config.endpoint = "https://api.exa.ai/search".into();
            config.method = CustomWebSearchMethod::Post;
            config.query_param = "query".into();
            config.count_param = Some("numResults".into());
            config.snippet_pointer = "/text".into();
            config.body = json!({"contents":{"text":true}});
            config.headers.insert("x-api-key".into(), key.into());
        }
        "serper" => {
            config.endpoint = "https://google.serper.dev/search".into();
            config.method = CustomWebSearchMethod::Post;
            config.count_param = Some("num".into());
            config.results_pointer = "/organic".into();
            config.url_pointer = "/link".into();
            config.headers.insert("X-API-KEY".into(), key.into());
        }
        "firecrawl" => {
            let base = text(record, "baseUrl");
            config.endpoint = format!(
                "{}/v2/search",
                if base.is_empty() {
                    "https://api.firecrawl.dev"
                } else {
                    base.trim_end_matches('/')
                }
            );
            config.method = CustomWebSearchMethod::Post;
            config.query_param = "query".into();
            config.count_param = Some("limit".into());
            config.results_pointer = "/data/web".into();
            config.snippet_pointer = "/description".into();
            config
                .headers
                .insert("Authorization".into(), format!("Bearer {key}"));
        }
        "custom" => {
            let mut value = custom_value(record).cloned().unwrap_or_else(|| json!({}));
            let map = value
                .as_object_mut()
                .ok_or_else(|| bad_request("custom search config must be a JSON object"))?;
            // Accept existing UI camelCase keys, export the runtime snake_case type.
            for (old, new) in [
                ("apiBase", "endpoint"),
                ("queryParam", "query_param"),
                ("countParam", "count_param"),
                ("headerEnv", "header_env"),
                ("resultsPointer", "results_pointer"),
                ("titlePointer", "title_pointer"),
                ("urlPointer", "url_pointer"),
                ("snippetPointer", "snippet_pointer"),
            ] {
                if let Some(v) = map.remove(old) {
                    map.entry(new).or_insert(v);
                }
            }
            if !map.contains_key("endpoint") && !text(record, "baseUrl").is_empty() {
                map.insert("endpoint".into(), json!(text(record, "baseUrl")));
            }
            config = serde_json::from_value(value)
                .map_err(|_| bad_request("invalid custom search config field types"))?;
            if !key.is_empty()
                && !config
                    .headers
                    .keys()
                    .chain(config.header_env.keys())
                    .any(|name| name.eq_ignore_ascii_case("authorization"))
            {
                config
                    .headers
                    .insert("Authorization".into(), format!("Bearer {key}"));
            }
        }
        "searxng" => {
            // Keyed SearXNG uses the custom adapter so its authentication is preserved.
            config.endpoint = format!("{}/search", text(record, "baseUrl").trim_end_matches('/'));
            config.params.insert("format".into(), "json".into());
            config.snippet_pointer = "/content".into();
            config
                .headers
                .insert("Authorization".into(), format!("Bearer {key}"));
        }
        _ => return Err(bad_request("unsupported search provider protocol")),
    }
    validate_url(&config.endpoint)?;
    if !config.body.is_object()
        || config.query_param.trim().is_empty()
        || config
            .count_param
            .as_deref()
            .is_some_and(|count| count.trim().is_empty() || count == config.query_param)
    {
        return Err(bad_request(
            "custom body must be a JSON object and query/count parameter names must be nonempty and distinct",
        ));
    }
    for pointer in [
        &config.results_pointer,
        &config.title_pointer,
        &config.url_pointer,
        &config.snippet_pointer,
    ] {
        let mut chars = pointer.chars();
        let mut valid = pointer.is_empty() || pointer.starts_with('/');
        while let Some(character) = chars.next() {
            if character == '~' && !matches!(chars.next(), Some('0' | '1')) {
                valid = false;
            }
        }
        if !valid {
            return Err(bad_request(
                "custom result pointers must use RFC 6901 syntax",
            ));
        }
    }
    for (name, value) in &config.headers {
        axum::http::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| bad_request("invalid custom header name"))?;
        axum::http::HeaderValue::from_str(value)
            .map_err(|_| bad_request("invalid custom header value"))?;
    }
    Ok(config)
}

fn runtime_record(record: &Value) -> Result<Option<Value>, ApiError> {
    if !supported(record) {
        return Ok(None);
    }
    let kind = text(record, "provider");
    let key = text(record, "apiKey");
    if matches!(kind, "brave" | "tavily" | "exa" | "serper" | "firecrawl") && key.is_empty() {
        return Ok(None);
    }
    let mut result = json!({"id":text(record,"id"),"label":text(record,"name"),"engine":"custom"});
    match kind {
        "duckduckgo" | "bing" => {
            result["engine"] = json!(kind);
            if kind == "bing" && !key.is_empty() {
                result["bing_api_key"] = json!(key);
            }
        }
        "inference-provider-native" => result["engine"] = json!("native"),
        "searxng" if key.is_empty() => {
            if text(record, "baseUrl").is_empty() {
                return Ok(None);
            }
            validate_url(text(record, "baseUrl"))?;
            result["engine"] = json!("searxng");
            result["searxng_url"] = json!(text(record, "baseUrl"));
        }
        "custom" if custom_value(record).is_none() && text(record, "baseUrl").is_empty() => {
            return Ok(None)
        }
        _ => result["custom"] = serde_json::to_value(custom_config(record)?)?,
    }
    Ok(Some(result))
}

fn build_registry(doc: &Value) -> Result<Value, ApiError> {
    let map = doc.as_object().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "search provider store must be a JSON object".into(),
        )
    })?;
    let mut providers = Vec::new();
    let mut default = None;
    for (id, record) in map {
        if id.trim().is_empty() || !record.is_object() {
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "search provider store contains an invalid record".into(),
            ));
        }
        if let Some(mut exported) = runtime_record(record)? {
            // The map key is the canonical record ID, including for older stores.
            exported["id"] = json!(id);
            if record.get("isActive").and_then(Value::as_bool) == Some(true) && default.is_none() {
                default = Some(id.clone());
            }
            providers.push(exported);
        }
    }
    let default = default.or_else(|| providers.first().map(|p| text(p, "id").to_string()));
    Ok(json!({"default_provider":default,"providers":providers}))
}

fn normalize_default(doc: &mut Value) -> Result<(), ApiError> {
    let registry = build_registry(doc)?;
    let default = registry.get("default_provider").and_then(Value::as_str);
    for (id, record) in doc.as_object_mut().unwrap() {
        record["isActive"] = json!(Some(id.as_str()) == default);
    }
    Ok(())
}

fn export_config(
    contents: &str,
    registry_path: &FilePath,
    registry: &Value,
) -> Result<String, ApiError> {
    let mut config: toml::Value = toml::from_str(contents).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime config.toml is invalid TOML".into(),
        )
    })?;
    let root = config.as_table_mut().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime config must be a TOML table".into(),
        )
    })?;
    let websearch = root
        .entry("websearch")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "runtime websearch config must be a table".into(),
            )
        })?;
    let default = registry.get("default_provider").and_then(Value::as_str);
    let engine = registry["providers"]
        .as_array()
        .and_then(|providers| providers.iter().find(|p| Some(text(p, "id")) == default))
        .map(|p| text(p, "engine"))
        .unwrap_or("duckduckgo");
    for key in ["custom", "bing_api_key", "searxng_url"] {
        websearch.remove(key);
    }
    websearch.insert(
        "configured_providers_file".into(),
        toml::Value::String(registry_path.to_string_lossy().into_owned()),
    );
    websearch.insert("engine".into(), toml::Value::String(engine.into()));
    websearch.insert(
        "prefer_native".into(),
        toml::Value::Boolean(default.is_some() && engine == "native"),
    );
    websearch.insert("fallback_engines".into(), toml::Value::Array(vec![]));
    toml::to_string_pretty(&config).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot serialize runtime search config".into(),
        )
    })
}

async fn atomic_write(path: &FilePath, contents: &[u8]) -> Result<(), ApiError> {
    let parent = path.parent().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime config path has no parent".into(),
        )
    })?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = parent.join(format!(".search-{}.tmp", Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(contents).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        Ok::<(), ApiError>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

// Caller holds state.store across read, mutation, validation and both exports.
// The registry is a single atomic snapshot; config is written last. Errors are
// propagated so callers can retry. Startup also repairs interrupted exports.
async fn sync_search_to_runtime_config(state: &AppState, doc: &Value) -> Result<(), ApiError> {
    let registry = build_registry(doc)?;
    tokio::fs::create_dir_all(&state.runtime_home).await?;
    let runtime_home = tokio::fs::canonicalize(&state.runtime_home).await?;
    let config_path = runtime_home.join("config.toml");
    let registry_path = runtime_home.join(REGISTRY);
    let contents = match tokio::fs::read_to_string(&config_path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let config = export_config(&contents, &registry_path, &registry)?;
    write_json(&registry_path, &registry).await?;
    atomic_write(&config_path, config.as_bytes()).await?;
    Ok(())
}

fn seed_free_providers(doc: &mut Value) -> Result<(), ApiError> {
    let map = doc.as_object_mut().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "search provider store must be a JSON object".into(),
        )
    })?;
    for (kind, label) in [
        ("inference-provider-native", "Provider Native"),
        ("duckduckgo", "DuckDuckGo"),
        ("bing", "Bing Search"),
    ] {
        if !map.values().any(|record| text(record, "provider") == kind) {
            let id = Uuid::new_v4().to_string();
            map.insert(id.clone(), json!({"id":id,"name":label,"provider":kind,"apiKey":"","isActive":false,"updatedAt":now_iso()}));
        }
    }
    // First migration prefers native if no supported default was already selected.
    if !map.values().any(|record| {
        supported(record) && record.get("isActive").and_then(Value::as_bool) == Some(true)
    }) {
        if let Some(record) = map
            .values_mut()
            .find(|record| text(record, "provider") == "inference-provider-native")
        {
            record["isActive"] = json!(true);
        }
    }
    normalize_default(doc)
}

pub async fn initialize(state: &AppState) -> Result<(), ApiError> {
    let _lock = state.store.lock().await;
    let mut doc = read_json(&store_path(state, STORE), json!({})).await?;
    let marker = store_path(state, MIGRATION);
    let migration_done = read_json(&marker, Value::Null)
        .await?
        .get("version")
        .and_then(Value::as_u64)
        == Some(1);
    if !migration_done {
        seed_free_providers(&mut doc)?;
    } else {
        normalize_default(&mut doc)?;
    }
    sync_search_to_runtime_config(state, &doc).await?;
    write_json(&store_path(state, STORE), &doc).await?;
    if !migration_done {
        write_json(&marker, &json!({"version":1,"completedAt":now_iso()})).await?;
    }
    Ok(())
}

fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "•".repeat(chars.len());
    }
    format!(
        "{}...{}",
        chars[..3].iter().collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
}

pub async fn active_search_payload(state: &AppState) -> Result<Value, ApiError> {
    let doc = read_json(&store_path(state, STORE), json!({})).await?;
    let registry = build_registry(&doc)?;
    if let Some(id) = registry.get("default_provider").and_then(Value::as_str) {
        let active = &doc[id];
        let kind = text(active, "provider");
        let spec = search_catalog()
            .into_iter()
            .find(|spec| text(spec, "kind") == kind)
            .unwrap();
        return Ok(
            json!({"configured":true,"id":id,"name":active["name"],"provider":kind,"label":spec["label"],"extracts":spec["extracts"]}),
        );
    }
    Ok(json!({"configured":false}))
}

async fn get_search_active(
    AgentState(state): AgentState,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(active_search_payload(&state).await?))
}

async fn get_search_catalog(user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(Value::Array(search_catalog())))
}

pub async fn list_search_providers_payload(state: &AppState) -> Result<Vec<Value>, ApiError> {
    let doc = read_json(&store_path(state, STORE), json!({})).await?;
    let mut result = Vec::new();
    for (id, record) in doc.as_object().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "search provider store must be a JSON object".into(),
        )
    })? {
        let is_supported = supported(record);
        let configured = runtime_record(record)?.is_some();
        let spec = search_catalog()
            .into_iter()
            .find(|spec| text(spec, "kind") == text(record, "provider"));
        result.push(json!({
            "id":id,"name":record["name"],"provider":record["provider"],"configured":configured,
            "supported":is_supported,"unsupportedReason":if is_supported { Value::Null } else { json!("This legacy provider has no supported search protocol. Configure a supported provider or a custom HTTP JSON endpoint.") },
            "apiKeyHint":mask_key(text(record,"apiKey")),"isActive":configured && record.get("isActive").and_then(Value::as_bool).unwrap_or(false),
            "extracts":spec.map(|s|s["extracts"].clone()).unwrap_or(json!(false)),"baseUrl":record["baseUrl"],"custom":custom_value(record).cloned().unwrap_or(Value::Null),
        }));
    }
    Ok(result)
}

async fn get_search_providers(
    AgentState(state): AgentState,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(Value::Array(list_search_providers_payload(&state).await?)))
}

async fn save_and_sync(state: &AppState, mut doc: Value) -> Result<(), ApiError> {
    normalize_default(&mut doc)?;
    // Persist desired state first for startup repair, never report success when export fails.
    // Validate TOML before persisting to avoid changes on a known corrupt config.
    let contents = match tokio::fs::read_to_string(state.runtime_home.join("config.toml")).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    export_config(
        &contents,
        &state.runtime_home.join(REGISTRY),
        &build_registry(&doc)?,
    )?;
    write_json(&store_path(state, STORE), &doc).await?;
    sync_search_to_runtime_config(state, &doc).await
}

pub async fn upsert_search_provider(
    state: &AppState,
    body: &Value,
) -> Result<Value, ApiError> {
    let name = text(body, "name").trim();
    let kind = text(body, "provider").trim();
    if name.is_empty() {
        return Err(bad_request("name is required"));
    }
    if !search_catalog()
        .iter()
        .any(|spec| text(spec, "kind") == kind)
    {
        return Err(bad_request("unknown or unsupported search provider"));
    }
    let id = if text(body, "id").trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        text(body, "id").into()
    };
    let _lock = state.store.lock().await;
    let mut doc = read_json(&store_path(state, STORE), json!({})).await?;
    let existing = doc.get(&id);
    let key = if text(body, "apiKey").trim().is_empty() {
        existing.map(|record| text(record, "apiKey")).unwrap_or("")
    } else {
        text(body, "apiKey").trim()
    };
    let record = json!({
        "id":id,"name":name,"provider":kind,"apiKey":key,
        "baseUrl":body.get("baseUrl").cloned().or_else(||existing.and_then(|r|r.get("baseUrl")).cloned()).unwrap_or(Value::Null),
        "custom":body.get("custom").or_else(||body.get("customConfig")).cloned().or_else(||existing.and_then(custom_value).cloned()).unwrap_or(Value::Null),
        "isActive":existing.and_then(|r|r.get("isActive")).cloned().unwrap_or(json!(false)),"updatedAt":now_iso(),
    });
    if runtime_record(&record)?.is_none() {
        return Err(bad_request(
            "provider requires an API key or endpoint configuration",
        ));
    }
    doc.as_object_mut()
        .ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "search provider store must be a JSON object".into(),
            )
        })?
        .insert(id.clone(), record);
    save_and_sync(state, doc).await?;
    Ok(json!({"id":id}))
}

async fn post_search_provider(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(upsert_search_provider(&state, &body).await?))
}

pub async fn remove_search_provider(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let _lock = state.store.lock().await;
    let mut doc = read_json(&store_path(state, STORE), json!({})).await?;
    let map = doc.as_object_mut().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "search provider store must be a JSON object".into(),
        )
    })?;
    if map.remove(id).is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "provider not found".into()));
    }
    save_and_sync(state, doc).await?;
    Ok(json!({"success":true}))
}

async fn delete_search_provider(
    AgentState(state): AgentState,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(remove_search_provider(&state, &id).await?))
}

pub async fn set_active_search_provider(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let _lock = state.store.lock().await;
    let mut doc = read_json(&store_path(state, STORE), json!({})).await?;
    // Allow matching either by record ID or by provider kind / name if unique
    let resolved_id = if doc.get(id).is_some() {
        id.to_string()
    } else {
        doc.as_object()
            .and_then(|map| {
                map.iter()
                    .find(|(_, r)| {
                        text(r, "provider").eq_ignore_ascii_case(id)
                            || text(r, "name").eq_ignore_ascii_case(id)
                    })
                    .map(|(k, _)| k.clone())
            })
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "provider not found".into()))?
    };
    let record = doc
        .get(&resolved_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "provider not found".into()))?;
    if runtime_record(record)?.is_none() {
        return Err(bad_request("provider is unsupported or not configured"));
    }
    for (key, record) in doc.as_object_mut().unwrap() {
        record["isActive"] = json!(key == &resolved_id);
    }
    save_and_sync(state, doc).await?;
    Ok(json!({"success":true, "id": resolved_id}))
}

async fn activate_search_provider(
    AgentState(state): AgentState,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(set_active_search_provider(&state, &id).await?))
}

fn custom_request(
    client: &reqwest::Client,
    config: &CustomWebSearchConfig,
) -> Result<reqwest::RequestBuilder, ApiError> {
    let mut request = match config.method {
        CustomWebSearchMethod::Get => client.get(&config.endpoint),
        CustomWebSearchMethod::Post => client.post(&config.endpoint),
    }
    .query(&config.params);
    let mut dynamic = serde_json::Map::new();
    dynamic.insert(config.query_param.clone(), json!("amiro"));
    if let Some(name) = &config.count_param {
        dynamic.insert(name.clone(), json!(3));
    }
    request = match config.method {
        CustomWebSearchMethod::Get => request.query(
            &dynamic
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        value
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| value.to_string()),
                    )
                })
                .collect::<Vec<_>>(),
        ),
        CustomWebSearchMethod::Post => {
            let mut body = config
                .body
                .as_object()
                .cloned()
                .ok_or_else(|| bad_request("custom body must be a JSON object"))?;
            body.extend(dynamic);
            request.json(&body)
        }
    };
    for (name, value) in &config.headers {
        request = request.header(name, value);
    }
    for (name, env) in &config.header_env {
        let value = std::env::var(env)
            .map_err(|_| bad_request("custom header environment variable is unavailable"))?;
        request = request.header(name, value);
    }
    Ok(request)
}

async fn execute_provider_test(record: &Value) -> Result<(bool, usize, Option<String>), ApiError> {
    let exported = runtime_record(record)?
        .ok_or_else(|| bad_request("provider is unsupported or not configured"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot build search HTTP client".into(),
            )
        })?;
    let engine = text(&exported, "engine");
    let (request, pointer) = match engine {
        "duckduckgo" => (client.get("https://html.duckduckgo.com/html/").query(&[("q","amiro")]),None),
        "bing" if text(record,"apiKey").is_empty() => (client.get("https://www.bing.com/search").query(&[("q","amiro")]),None),
        "bing" => (client.get("https://api.bing.microsoft.com/v7.0/search").query(&[("q","amiro"),("count","3")]).header("Ocp-Apim-Subscription-Key",text(record,"apiKey")),Some("/webPages/value".into())),
        "searxng" => (client.get(format!("{}/search",text(record,"baseUrl").trim_end_matches('/'))).query(&[("q","amiro"),("format","json")]),Some("/results".into())),
        "custom" => {
            let config = custom_config(record)?;
            (custom_request(&client,&config)?,Some(config.results_pointer))
        }
        "native" => return Ok((false,0,Some("Provider-native search can only be verified during a model request when selected as default".into()))),
        _ => return Err(bad_request("unsupported search provider protocol")),
    };
    let response = match request.send().await {
        Ok(response) => response,
        // Do not return reqwest errors containing URLs, which may carry query credentials.
        Err(_) => return Ok((false, 0, Some("Search request failed or timed out".into()))),
    };
    if !response.status().is_success() {
        return Ok((
            false,
            0,
            Some(format!(
                "Search endpoint returned HTTP {}",
                response.status()
            )),
        ));
    }
    if let Some(pointer) = pointer {
        let body = match response.json::<Value>().await {
            Ok(body) => body,
            Err(_) => {
                return Ok((
                    false,
                    0,
                    Some("Search endpoint returned invalid JSON".into()),
                ))
            }
        };
        match body.pointer(&pointer).and_then(Value::as_array) {
            Some(results) => Ok((true, results.len(), None)),
            None => Ok((
                false,
                0,
                Some("Search response does not contain the configured results array".into()),
            )),
        }
    } else {
        // HTML transport success is not a claim that any result was extracted.
        Ok((true, 0, None))
    }
}

pub async fn run_search_provider_test(state: &AppState, id: &str) -> Result<Value, ApiError> {
    let doc = read_json(&store_path(state, STORE), json!({})).await?;
    let resolved_id = if doc.get(id).is_some() {
        id.to_string()
    } else {
        doc.as_object()
            .and_then(|map| {
                map.iter()
                    .find(|(_, r)| {
                        text(r, "provider").eq_ignore_ascii_case(id)
                            || text(r, "name").eq_ignore_ascii_case(id)
                    })
                    .map(|(k, _)| k.clone())
            })
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "provider not found".into()))?
    };
    let record = doc
        .get(&resolved_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "provider not found".into()))?;
    let start = std::time::Instant::now();
    let (ok, count, error) = execute_provider_test(record).await?;
    Ok(json!({"ok":ok,"provider":record["provider"],"latencyMs":start.elapsed().as_millis() as u64,"count":count,"error":error}))
}

async fn test_search_provider(
    AgentState(state): AgentState,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(run_search_provider_test(&state, &id).await?))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search/active", get(get_search_active))
        .route("/api/search/catalog", get(get_search_catalog))
        .route(
            "/api/search/providers",
            get(get_search_providers).post(post_search_provider),
        )
        .route("/api/search/providers/{id}", delete(delete_search_provider))
        .route(
            "/api/search/providers/{id}/activate",
            post(activate_search_provider),
        )
        .route(
            "/api/search/providers/{id}/test",
            post(test_search_provider),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    fn record(kind: &str) -> Value {
        json!({"id":kind,"name":kind,"provider":kind,"apiKey":"test-secret","baseUrl":"http://127.0.0.1:8080","isActive":false})
    }

    fn state() -> AppState {
        let root = std::env::var_os("JCODE_SCRATCH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("search-test-{}", Uuid::new_v4()));
        AppState {
            home: root.clone(),
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("socket"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("bin"),
            token: "sidecar-secret".into(),
            store: Arc::new(Mutex::new(())),
        }
    }

    fn admin() -> AuthUser {
        AuthUser(json!({"role":"admin"}))
    }

    #[tokio::test]
    async fn custom_validation_matches_runtime_and_rejects_before_persisting() {
        let state = state();
        initialize(&state).await.unwrap();
        let before = read_json(&store_path(&state, STORE), Value::Null)
            .await
            .unwrap();
        for custom in [
            json!({"endpoint":"https://example.org/search?key=secret#fragment"}),
            json!({"endpoint":"https://example.org/search","query_param":" \t"}),
            json!({"endpoint":"https://example.org/search","count_param":" \t"}),
            json!({"endpoint":"https://example.org/search","query_param":"q","count_param":"q"}),
            json!({"endpoint":"https://example.org/search","results_pointer":"/bad~2escape"}),
            json!({"endpoint":"https://example.org/search","title_pointer":"/bad~"}),
            json!({"endpoint":"https://example.org/search","url_pointer":"not/a/pointer"}),
            json!({"endpoint":"https://example.org/search","snippet_pointer":"/bad~x"}),
        ] {
            let error = post_search_provider(
                AgentState(state.clone()),
                admin(),
                Json(json!({"name":"Invalid custom", "provider":"custom", "custom":custom})),
            )
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
            assert!(!error.1.contains("secret"));
            assert_eq!(
                read_json(&store_path(&state, STORE), Value::Null)
                    .await
                    .unwrap(),
                before
            );
        }
        for pointer in ["", "/valid~0tilde~1slash", "/~01", "/unicode-é"] {
            custom_config(&json!({"provider":"custom","custom":{"endpoint":"https://example.org/search","results_pointer":pointer}})).unwrap();
        }
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[tokio::test]
    async fn fresh_install_seeds_native_default_and_all_free_engines() {
        let state = state();
        initialize(&state).await.unwrap();
        let registry =
            amiro_config_types::ConfiguredSearchRegistry::load(&state.runtime_home.join(REGISTRY))
                .unwrap();
        assert_eq!(registry.providers.len(), 3);
        assert_eq!(
            registry.default_provider().unwrap().engine,
            amiro_config_types::WebSearchEngine::Native
        );
        for engine in [
            amiro_config_types::WebSearchEngine::Native,
            amiro_config_types::WebSearchEngine::Duckduckgo,
            amiro_config_types::WebSearchEngine::Bing,
        ] {
            assert!(registry
                .providers
                .iter()
                .any(|provider| provider.engine == engine));
        }
        assert_eq!(
            get_search_active(AgentState(state.clone()), AuthUser(json!({"role":"user"})))
                .await
                .unwrap()
                .0["provider"],
            "inference-provider-native"
        );
        let config: toml::Value = toml::from_str(
            &tokio::fs::read_to_string(state.runtime_home.join("config.toml"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(config["websearch"]["prefer_native"].as_bool(), Some(true));
        assert!(FilePath::new(
            config["websearch"]["configured_providers_file"]
                .as_str()
                .unwrap()
        )
        .is_absolute());
        tokio::fs::remove_dir_all(&state.home).await.unwrap();

        let mut saved =
            json!({"chosen":{"name":"Existing Bing","provider":"bing","isActive":true}});
        seed_free_providers(&mut saved).unwrap();
        assert_eq!(
            build_registry(&saved).unwrap()["default_provider"],
            "chosen"
        );
        assert_eq!(saved.as_object().unwrap().len(), 3);
    }

    #[test]
    fn registry_exports_all_configured_records_and_excludes_legacy() {
        let doc = json!({"active":{"id":"wrong","name":"DDG","provider":"duckduckgo","isActive":true},"other":record("tavily"),"old":record("vellum"),"missing":{"provider":"brave"}});
        let registry = build_registry(&doc).unwrap();
        let shared: amiro_config_types::ConfiguredSearchRegistry =
            serde_json::from_value(registry.clone()).unwrap();
        assert_eq!(shared.default_provider().unwrap().id, "active");
        assert_eq!(registry["default_provider"], "active");
        assert_eq!(registry["providers"].as_array().unwrap().len(), 2);
        assert_eq!(registry["providers"][0]["id"], "active");
        assert_eq!(
            build_registry(&json!({})).unwrap(),
            json!({"default_provider":null,"providers":[]})
        );
    }

    #[test]
    fn every_advertised_provider_has_valid_mapping() {
        for spec in search_catalog() {
            let kind = text(&spec, "kind");
            let mut saved = record(kind);
            if kind == "custom" {
                saved["custom"] = json!({"endpoint":"https://example.org/search"});
            }
            let exported = runtime_record(&saved).unwrap().unwrap();
            assert!(matches!(
                text(&exported, "engine"),
                "duckduckgo" | "bing" | "searxng" | "custom" | "native"
            ));
            if let Some(config) = exported.get("custom") {
                let config: CustomWebSearchConfig = serde_json::from_value(config.clone()).unwrap();
                validate_url(&config.endpoint).unwrap();
            }
        }
        assert!(!search_catalog()
            .iter()
            .any(|spec| text(spec, "kind") == "vellum"));
        assert_eq!(
            custom_config(&record("firecrawl")).unwrap().results_pointer,
            "/data/web"
        );
        assert_eq!(
            runtime_record(&record("bing")).unwrap().unwrap()["bing_api_key"],
            "test-secret"
        );
        let searx = runtime_record(&record("searxng")).unwrap().unwrap();
        assert_eq!(searx["engine"], "custom");
        assert_eq!(
            searx["custom"]["headers"]["Authorization"],
            "Bearer test-secret"
        );
    }

    #[test]
    fn tavily_auth_and_custom_static_configuration_survive_export_and_request() {
        let tavily = custom_config(&record("tavily")).unwrap();
        assert_eq!(tavily.body, json!({"api_key":"test-secret"}));
        assert!(!tavily.headers.contains_key("api_key"));
        let request = custom_request(&reqwest::Client::new(), &tavily)
            .unwrap()
            .build()
            .unwrap();
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"api_key":"test-secret","query":"amiro","max_results":3})
        );
        let saved = json!({"provider":"custom","apiKey":"do-not-overwrite","custom":{"endpoint":"https://example.org/search","method":"POST","queryParam":"query","countParam":"limit","params":{"lang":"en"},"body":{"options":{"extract":true}},"headers":{"Authorization":"Special secret","X-Extra":"a\"b\\c"},"headerEnv":{"X-Env":"SEARCH_TOKEN"},"resultsPointer":"/data/items"}});
        let config = custom_config(&saved).unwrap();
        assert_eq!(config.params["lang"], "en");
        assert_eq!(config.body, json!({"options":{"extract":true}}));
        assert_eq!(config.headers["Authorization"], "Special secret");
        assert_eq!(config.header_env["X-Env"], "SEARCH_TOKEN");
        assert_eq!(config.results_pointer, "/data/items");
    }

    #[test]
    fn toml_export_preserves_unrelated_tables_and_only_default_native_preference() {
        let contents = "[websearch]\nengine = 'custom'\nprefer_native = true\n[websearch.custom]\nendpoint = 'old'\n[websearch.custom.headers]\nAuthorization = 'old-secret'\n[other]\nname = 'keep'\n[[other.items]]\nvalue = 1\n";
        let path = FilePath::new("/runtime with spaces/search-\"providers.json");
        let local = json!({"default_provider":"d","providers":[{"id":"d","engine":"duckduckgo"},{"id":"n","engine":"native"}]});
        let result: toml::Value =
            toml::from_str(&export_config(contents, path, &local).unwrap()).unwrap();
        assert_eq!(result["other"]["name"].as_str(), Some("keep"));
        assert_eq!(result["other"]["items"][0]["value"].as_integer(), Some(1));
        assert_eq!(
            result["websearch"]["configured_providers_file"].as_str(),
            path.to_str()
        );
        assert_eq!(result["websearch"]["prefer_native"].as_bool(), Some(false));
        assert!(result["websearch"].get("custom").is_none());
        assert!(result["websearch"]["fallback_engines"]
            .as_array()
            .unwrap()
            .is_empty());
        let native = json!({"default_provider":"n","providers":[{"id":"n","engine":"native"}]});
        let result: toml::Value =
            toml::from_str(&export_config("", path, &native).unwrap()).unwrap();
        assert_eq!(result["websearch"]["prefer_native"].as_bool(), Some(true));
        assert!(export_config("[broken", path, &native).is_err());
    }

    #[tokio::test]
    async fn migration_seeds_once_preserves_existing_default_and_deletions() {
        let state = state();
        let mut native = record("inference-provider-native");
        native["isActive"] = json!(true);
        write_json(
            &store_path(&state, STORE),
            &json!({"native":native,"old":record("vellum")}),
        )
        .await
        .unwrap();
        initialize(&state).await.unwrap();
        let doc = read_json(&store_path(&state, STORE), Value::Null)
            .await
            .unwrap();
        assert_eq!(doc.as_object().unwrap().len(), 4);
        assert_eq!(build_registry(&doc).unwrap()["default_provider"], "native");
        assert_eq!(doc["old"]["apiKey"], "test-secret");
        let mut removed = doc.clone();
        removed
            .as_object_mut()
            .unwrap()
            .retain(|_, record| text(record, "provider") == "vellum");
        write_json(&store_path(&state, STORE), &removed)
            .await
            .unwrap();
        initialize(&state).await.unwrap();
        let registry = read_json(&state.runtime_home.join(REGISTRY), Value::Null)
            .await
            .unwrap();
        assert_eq!(registry, json!({"default_provider":null,"providers":[]}));
        assert_eq!(
            read_json(&store_path(&state, STORE), Value::Null)
                .await
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            1
        );
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[tokio::test]
    async fn add_activate_delete_sync_all_entries_and_propagate_export_errors() {
        let state = state();
        initialize(&state).await.unwrap();
        let added = post_search_provider(
            AgentState(state.clone()),
            admin(),
            Json(json!({"name":"Tavily","provider":"tavily","apiKey":"secret"})),
        )
        .await
        .unwrap()
        .0;
        let id = text(&added, "id");
        let registry = read_json(&state.runtime_home.join(REGISTRY), Value::Null)
            .await
            .unwrap();
        assert_eq!(registry["providers"].as_array().unwrap().len(), 4);
        let _ = activate_search_provider(AgentState(state.clone()), admin(), Path(id.into()))
            .await
            .unwrap();
        assert_eq!(
            read_json(&state.runtime_home.join(REGISTRY), Value::Null)
                .await
                .unwrap()["default_provider"],
            id
        );
        let _ = delete_search_provider(AgentState(state.clone()), admin(), Path(id.into()))
            .await
            .unwrap();
        let registry = read_json(&state.runtime_home.join(REGISTRY), Value::Null)
            .await
            .unwrap();
        assert_eq!(registry["providers"].as_array().unwrap().len(), 3);
        assert_ne!(registry["default_provider"], id);
        amiro_config_types::ConfiguredSearchRegistry::load(&state.runtime_home.join(REGISTRY))
            .unwrap();
        tokio::fs::write(state.runtime_home.join("config.toml"), "[broken")
            .await
            .unwrap();
        let before = read_json(&store_path(&state, STORE), Value::Null)
            .await
            .unwrap();
        assert!(post_search_provider(
            AgentState(state.clone()),
            admin(),
            Json(json!({"name":"extra","provider":"bing"}))
        )
        .await
        .is_err());
        assert_eq!(
            read_json(&store_path(&state, STORE), Value::Null)
                .await
                .unwrap(),
            before
        );
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_mutations_keep_registry_consistent_and_private() {
        let state = state();
        initialize(&state).await.unwrap();
        let mut tasks = Vec::new();
        for index in 0..8 {
            let state = state.clone();
            tasks.push(tokio::spawn(async move {
                let _ = post_search_provider(
                    AgentState(state),
                    admin(),
                    Json(json!({"name":format!("DDG {index}"),"provider":"duckduckgo"})),
                )
                .await
                .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        let doc = read_json(&store_path(&state, STORE), Value::Null)
            .await
            .unwrap();
        let registry = read_json(&state.runtime_home.join(REGISTRY), Value::Null)
            .await
            .unwrap();
        assert_eq!(registry, build_registry(&doc).unwrap());
        assert_eq!(registry["providers"].as_array().unwrap().len(), 11);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for file in [REGISTRY, "config.toml"] {
                assert_eq!(
                    tokio::fs::metadata(state.runtime_home.join(file))
                        .await
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[tokio::test]
    async fn public_routes_enforce_auth_admin_and_keyless_validation() {
        let state = state();
        initialize(&state).await.unwrap();
        write_json(
            &state.home.join("users.json"),
            &json!({"users":[{"id":"a","role":"admin"},{"id":"u","role":"user"}]}),
        )
        .await
        .unwrap();
        write_json(&state.home.join("sessions.json"),&json!({"sessions":{"admin":{"userId":"a","createdAt":now_iso()},"user":{"userId":"u","createdAt":now_iso()}}})).await.unwrap();
        let app = routes().with_state(state.clone());
        for path in ["/api/search/catalog", "/api/search/providers"] {
            assert_eq!(
                app.clone()
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                app.clone()
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header("Authorization", "Bearer user")
                            .body(Body::empty())
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/search/active")
                    .header("Authorization", "Bearer user")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec()
        )
        .unwrap()
        .contains("apiKey"));
        for (body, status) in [
            (json!({"name":"keyless","provider":"bing"}), StatusCode::OK),
            (
                json!({"name":"removed","provider":"vellum"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"id":"new-id","name":"missing key","provider":"brave"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"name":"bad custom","provider":"custom","custom":{"endpoint":"file:///etc/passwd"}}),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/search/providers")
                        .header("Authorization", "Bearer admin")
                        .header("Content-Type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            if status == StatusCode::OK {
                let response: Value = serde_json::from_slice(
                    &response.into_body().collect().await.unwrap().to_bytes(),
                )
                .unwrap();
                let id = text(&response, "id");
                assert_eq!(
                    amiro_config_types::ConfiguredSearchRegistry::load(
                        &state.runtime_home.join(REGISTRY)
                    )
                    .unwrap()
                    .providers
                    .len(),
                    4
                );
                let activated = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(format!("/api/search/providers/{id}/activate"))
                            .header("Authorization", "Bearer admin")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(activated.status(), StatusCode::OK);
                assert_eq!(
                    amiro_config_types::ConfiguredSearchRegistry::load(
                        &state.runtime_home.join(REGISTRY)
                    )
                    .unwrap()
                    .default_provider()
                    .unwrap()
                    .id,
                    id
                );
                let deleted = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method("DELETE")
                            .uri(format!("/api/search/providers/{id}"))
                            .header("Authorization", "Bearer admin")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(deleted.status(), StatusCode::OK);
                let registry = amiro_config_types::ConfiguredSearchRegistry::load(
                    &state.runtime_home.join(REGISTRY),
                )
                .unwrap();
                assert_eq!(registry.providers.len(), 3);
                assert_ne!(registry.default_provider().unwrap().id, id);
            }
        }
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[tokio::test]
    async fn endpoint_test_preserves_body_headers_params_and_rejects_invalid_results() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/search",
            post(
                |axum::extract::Query(params): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >,
                 headers: axum::http::HeaderMap,
                 Json(body): Json<Value>| async move {
                    assert_eq!(params["lang"], "en");
                    assert_eq!(headers["X-Custom"], "secret");
                    assert_eq!(
                        body,
                        json!({"query":"amiro","count":3,"options":{"extract":true}})
                    );
                    Json(json!({"results":[{"title":"result","url":"https://example.org"}]}))
                },
            ),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let saved = json!({"provider":"custom","custom":{"endpoint":format!("http://{address}/search"),"method":"POST","query_param":"query","count_param":"count","params":{"lang":"en"},"headers":{"X-Custom":"secret"},"body":{"options":{"extract":true}}}});
        assert_eq!(
            execute_provider_test(&saved).await.unwrap(),
            (true, 1, None)
        );
        let mut invalid = saved.clone();
        invalid["custom"]["results_pointer"] = json!("/missing");
        assert!(!execute_provider_test(&invalid).await.unwrap().0);
        assert!(
            !execute_provider_test(&record("inference-provider-native"))
                .await
                .unwrap()
                .0
        );
        assert!(execute_provider_test(&record("vellum")).await.is_err());
        server.abort();
    }
}
