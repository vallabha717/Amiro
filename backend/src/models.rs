//! Model catalog routes: `/api/chat/models` (the chat model picker) and
//! `/api/ai/providers` (the admin providers page).
//!
//! Both read one shared catalog of *connected* providers and their models.
//! The runtime is the owner of that data, and it exposes it through more than
//! one view:
//!
//! * `amiro model list -p <id> --json` -> `models` (the names the model picker
//!   offers) and `routes` (the engine's full route catalog, which can name
//!   models the filtered `models` array leaves out);
//! * the per-provider catalogs the runtime caches on disk after a successful
//!   `/models` fetch. These matter because `model list` *degrades silently*:
//!   when the live refresh fails (offline, gateway 5xx, expired or
//!   rate-limited key) it prints a warning on stderr, still exits 0, and
//!   returns only its static fallback -- one or two entries -- even though the
//!   runtime itself still has the whole fetched catalog on disk and in its
//!   picker.
//!
//! Reading only the first source is what made the providers page show a
//! fraction of the models the runtime has (e.g. one entry instead of the 78
//! models of an OpenAI-compatible gateway). The catalog below is therefore the
//! union of every source, and a provider is never dropped just because one of
//! them failed.

use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::time::{Duration, Instant};

use crate::state::{ApiError, AppState, AuthUser};

/// Marker the runtime writes to stderr when it could not refresh a provider's
/// live catalog and is answering from its static fallback while still exiting
/// 0 (see `runtime/src/cli/commands.rs`'s `run_model_command`).
const REFRESH_FAILED: &str = "failed to refresh dynamic model list";

/// How long one built catalog is reused before the runtime is asked again.
const CATALOG_TTL: Duration = Duration::from_secs(60);

/// Directories under the runtime home that hold the runtime's own model
/// catalogs. `cache` is where the provider runtimes write the catalogs they
/// fetch; `config/jcode` holds the same data for providers that keep their
/// catalog next to their credentials (Antigravity, OpenAI, Bedrock).
const CATALOG_DIRS: &[&str] = &["cache", "config/jcode"];

/// Per-provider catalog file names: `<id>_models.json` (every
/// OpenAI-compatible profile, OpenRouter, OpenCode) and `<id>_models_cache.json`
/// (Antigravity, Bedrock, OpenAI's API-key catalog).
const CATALOG_SUFFIXES: &[&str] = &["_models.json", "_models_cache.json"];

#[derive(Clone)]
struct Catalog {
    at: Instant,
    data: Value,
}

static CATALOG: OnceLock<Arc<Mutex<Option<Catalog>>>> = OnceLock::new();

fn catalog_lock() -> Arc<Mutex<Option<Catalog>>> {
    CATALOG.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

/// Drop the cached catalog so the next read reflects a credentials change.
///
/// Called whenever a provider key is stored or removed: without it a provider
/// connected a moment ago stays invisible (and its models unlisted) for up to
/// [`CATALOG_TTL`], which reads as "Amiro lost my models".
pub fn invalidate_catalog() {
    let lock = catalog_lock();
    let mut guard = lock.lock().unwrap();
    *guard = None;
}

/// Adds one model entry to `names`, if it names something.
///
/// Catalog entries are either a bare model id or an object carrying `id`
/// (occasionally only `name`); anything else is ignored rather than guessed at.
fn push_model(names: &mut Vec<String>, entry: &Value) {
    let name = match entry {
        Value::String(text) => text.trim().to_string(),
        Value::Object(fields) => fields
            .get("id")
            .or_else(|| fields.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        _ => String::new(),
    };
    // The runtime's own placeholders for "the whole catalog" are not models.
    if name.is_empty() || matches!(name.as_str(), "copilot models" | "openrouter models") {
        return;
    }
    if !names.iter().any(|existing| existing == &name) {
        names.push(name);
    }
}

fn push_from_models_field(names: &mut Vec<String>, document: &Value) {
    if let Some(list) = document.get("models").and_then(Value::as_array) {
        for entry in list {
            push_model(names, entry);
        }
    }
}

/// Model names in one runtime catalog document.
///
/// Two shapes exist: a flat `{"models": [...]}` (every provider that caches a
/// single catalog) and OpenAI's `{"scopes": {"<account>": {"models": [...]}}}`,
/// which keeps one catalog per signed-in account. Both are read.
fn collect_model_names(document: &Value, names: &mut Vec<String>) {
    push_from_models_field(names, document);
    if let Some(scopes) = document.get("scopes").and_then(Value::as_object) {
        for scope in scopes.values() {
            push_from_models_field(names, scope);
        }
    }
}

/// One model catalog the runtime has on disk for a provider.
struct CachedCatalog {
    /// The endpoint the catalog was fetched from, when the file records one.
    /// The runtime writes this as its own proof of which endpoint the models
    /// belong to, and it is what makes the catalog attributable.
    source_api_base: Option<String>,
    models: Vec<String>,
}

/// Reads the catalogs the runtime keeps on disk for `provider`.
///
/// These survive a failed live refresh, so they are what keeps a provider's
/// model list complete when `model list` falls back to its static stub. Each
/// file is returned on its own because attribution (see
/// [`catalog_belongs_to_provider`]) has to be decided per file: a file's
/// endpoint is part of the catalog, not of the provider.
async fn cached_provider_catalogs(state: &AppState, provider: &str) -> Vec<CachedCatalog> {
    let mut catalogs: Vec<CachedCatalog> = Vec::new();
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for dir in CATALOG_DIRS {
        for suffix in CATALOG_SUFFIXES {
            paths.push(
                state
                    .runtime_home
                    .join(dir)
                    .join(format!("{provider}{suffix}")),
            );
        }
    }
    // The OpenAI catalog is cached once per account rather than per provider
    // id, so it is named after the file instead of the provider.
    if provider == "openai" || provider == "openai-api" {
        paths.push(
            state
                .runtime_home
                .join("config/jcode/openai_model_catalog_cache.json"),
        );
    }
    for path in paths {
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(document) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let mut models: Vec<String> = Vec::new();
        collect_model_names(&document, &mut models);
        if models.is_empty() {
            continue;
        }
        catalogs.push(CachedCatalog {
            source_api_base: document
                .get("source_api_base")
                .and_then(Value::as_str)
                .map(|base| base.trim().to_string())
                .filter(|base| !base.is_empty()),
            models,
        });
    }
    catalogs
}

/// Two endpoints that name the same service: equal, or one of them a path
/// prefix of the other (`https://host` and `https://host/v1`), which is the
/// shape difference the runtime's own base normalisation produces.
fn same_endpoint(left: &str, right: &str) -> bool {
    let normalise = |value: &str| value.trim().trim_end_matches('/').to_ascii_lowercase();
    let (left, right) = (normalise(left), normalise(right));
    !left.is_empty()
        && !right.is_empty()
        && (left == right
            || left.starts_with(&format!("{right}/"))
            || right.starts_with(&format!("{left}/")))
}

/// The endpoint `provider` is configured to talk to, when the deployment
/// declares one somewhere Amiro can read it.
///
/// The OpenAI-compatible profile takes its base from the process override
/// first, exactly as the runtime's own resolution does; otherwise the base is
/// read from the provider's env file, where the login flow stores a custom
/// endpoint. Amiro's own `AMIRO_*` binding wins over the pre-rename aliases in
/// the same file.
async fn provider_api_base(state: &AppState, provider: &str) -> Option<String> {
    if provider == "openai-compatible" {
        if let Some(value) = std::env::var("AMIRO_OPENAI_COMPAT_API_BASE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Some(value);
        }
    }
    let file = state
        .runtime_home
        .join("config/jcode")
        .join(format!("{provider}.env"));
    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return None;
    };
    let mut declared: Option<(bool, String)> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !key.ends_with("_API_BASE") {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            continue;
        }
        let preferred = key.starts_with("AMIRO_");
        // Keep the first `AMIRO_*` binding; a legacy alias only fills in when
        // no Amiro-namespaced one exists.
        if declared.is_none() || (preferred && !declared.as_ref().is_some_and(|(had, _)| *had)) {
            declared = Some((preferred, value.to_string()));
        }
    }
    declared.map(|(_, value)| value)
}

/// Whether a cached catalog can be attributed to `provider`.
///
/// The runtime names these files after the provider, but a namespace collision
/// (or a file left behind by an older endpoint) can leave a *different*
/// endpoint's models in one -- a real case is a `meta-muse` cache holding an
/// OpenCode Go catalog, whose base URL still says `opencode.ai`. Two checks
/// decide, and a catalog that passes neither is ignored rather than shown as
/// this provider's models:
///
/// * the catalog records the endpoint it came from and that endpoint is the
///   one this provider is configured for; or
/// * the catalog agrees with the provider's live list on at least one model,
///   which is what a truncated live list still shares with its own catalog.
fn catalog_belongs_to_provider(
    catalog: &CachedCatalog,
    live_models: &[String],
    expected_api_base: Option<&str>,
) -> bool {
    if let (Some(cached), Some(expected)) = (
        catalog.source_api_base.as_deref(),
        expected_api_base,
    ) {
        if same_endpoint(cached, expected) {
            return true;
        }
    }
    catalog
        .models
        .iter()
        .any(|model| live_models.iter().any(|live| live == model))
}

async fn build_catalog(state: &AppState) -> Value {
    {
        let lock = catalog_lock();
        let guard = lock.lock().unwrap();
        if let Some(cached) = guard.as_ref() {
            if cached.at.elapsed() < CATALOG_TTL {
                return cached.data.clone();
            }
        }
    }
    // fetch fresh
    let mut providers: Vec<Value> = vec![];
    let auth = match crate::runtime::auth_status(state).await {
        Ok(value) => value,
        Err(_) => json!({"providers":[]}),
    };
    let available: Vec<Value> = auth
        .get("providers")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("available"))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for p in available {
        let id = p
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let mut models: Vec<String> = vec![];
        let mut selected = String::new();
        // A live catalog and the runtime's static fallback look the same in the
        // payload; only the CLI's stderr distinguishes them. Every branch below
        // sets this, so the fallback for a reading that says nothing about it is
        // "trust the live list".
        let live_is_complete;
        match crate::runtime::model_list_with_diagnostics(state, &id).await {
            Ok(read) => {
                let res = &read.json;
                if let Some(list) = res.get("models").and_then(Value::as_array) {
                    for entry in list {
                        push_model(&mut models, entry);
                    }
                }
                // The route catalog is the runtime's own list of models this
                // session can switch to. It can name models the chat-filtered
                // `models` array leaves out (e.g. Antigravity's image model).
                if let Some(routes) = res.get("routes").and_then(Value::as_array) {
                    for route in routes {
                        if let Some(model) = route.get("model") {
                            push_model(&mut models, model);
                        }
                    }
                }
                if let Some(value) = res.get("selected_model").and_then(Value::as_str) {
                    selected = value.to_string();
                }
                live_is_complete = !read.stderr.contains(REFRESH_FAILED);
            }
            Err(error) => {
                // One provider's listing failing must not hide that provider or
                // its models: the on-disk catalogs below still hold whatever the
                // runtime fetched last time, and the warning says why the list
                // may be short.
                eprintln!(
                    "amiro model catalog: `model list -p {id}` failed ({}); using the runtime's cached catalog",
                    error.1
                );
                live_is_complete = false;
            }
        }
        // The runtime's cached catalogs stand in for a live listing it could not
        // refresh, but only the catalogs that can be attributed to this provider
        // (a mismatched file would advertise another endpoint's models). They are
        // deliberately *not* merged while the live listing is complete: that
        // list is the runtime's curated view, and the cached files hold the raw
        // endpoint catalog, which includes models the runtime filters out of the
        // picker (embeddings, speech, ...).
        if !live_is_complete {
            let expected_api_base = provider_api_base(state, &id).await;
            for catalog in cached_provider_catalogs(state, &id).await {
                if !catalog_belongs_to_provider(&catalog, &models, expected_api_base.as_deref()) {
                    continue;
                }
                for name in &catalog.models {
                    push_model(&mut models, &Value::String(name.clone()));
                }
            }
        }
        if selected.is_empty() || !models.contains(&selected) {
            selected = models.first().cloned().unwrap_or_default();
        }
        // Keep the provider even when every source came back empty: a connected
        // provider whose models cannot be listed is a state the UI must show,
        // not one it should hide.
        providers.push(json!({
            "id": id,
            "name": p.get("display_name").and_then(|v| v.as_str()).unwrap_or(&id).to_string(),
            "models": models,
            "selectedModel": selected,
        }));
    }
    let data = json!({"providers": providers, "rawStatus": auth});
    // store
    {
        let lock = catalog_lock();
        let mut guard = lock.lock().unwrap();
        *guard = Some(Catalog {
            at: Instant::now(),
            data: data.clone(),
        });
    }
    data
}

fn allowed_refs(_state: &AppState) -> Option<std::collections::HashSet<String>> {
    if let Ok(raw) = std::env::var("AMIRO_PINNED_MODELS") {
        let trimmed = raw.trim().to_string();
        if !trimmed.is_empty() {
            let set: std::collections::HashSet<String> = trimmed
                .split(',')
                .map(|s| s.trim().replace("openai-compatible:", ""))
                .filter(|s| !s.is_empty())
                .collect();
            return Some(set);
        }
    }
    None
}

async fn get_chat_models(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let catalog = build_catalog(&state).await;
    let pinned = allowed_refs(&state);
    let is_pinned = pinned.is_some();
    let pinned_set = pinned.unwrap_or_default();
    let mut result: Vec<Value> = vec![];
    if let Some(arr) = catalog.get("providers").and_then(|v| v.as_array()) {
        for p in arr {
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or(id);
            let models: Vec<String> = p
                .get("models")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let mut filtered = models.clone();
            if is_pinned {
                filtered = filtered
                    .into_iter()
                    .filter(|m| {
                        let r = format!("{}:{}", id, m);
                        pinned_set.contains(&r)
                            || pinned_set.contains(&r.replace("openai-compatible:", ""))
                            || pinned_set.contains(m)
                    })
                    .collect();
                if filtered.is_empty() {
                    continue;
                }
            }
            result.push(json!({"provider": id, "providerName": name, "providerType": id, "hasAPIKey": true, "models": filtered.into_iter().map(|name| json!({"name": name})).collect::<Vec<_>>() }));
        }
    }
    // preferred ordering
    let preferred = std::env::var("AMIRO_DEFAULT_MODEL")
        .unwrap_or_default()
        .trim()
        .replace("openai-compatible:", "");
    if !preferred.is_empty() {
        let pref_provider = preferred.split(':').next().unwrap_or("").to_string();
        if let Some(pos) = result
            .iter()
            .position(|r| r.get("provider").and_then(|v| v.as_str()) == Some(&pref_provider))
        {
            let item = result.remove(pos);
            result.insert(0, item);
        }
    }
    Ok(Json(json!(result)))
}

async fn get_ai_providers(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let catalog = build_catalog(&state).await;
    let providers: Vec<Value> = catalog
        .get("providers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    // The providers page spreads these rows straight into `ProviderCard`, whose
    // contract is `{id, name, provider, configured, models}` (see
    // src/lib/backend/provider-api.ts). `provider` is the connection's own id
    // here -- each row is one connection -- and only connected providers reach
    // this list, so `configured` is always true.
    Ok(Json(json!(providers
        .iter()
        .map(|p| json!({
            "id": p.get("id").cloned().unwrap_or(json!("")),
            "name": p.get("name").cloned().unwrap_or(json!("")),
            "provider": p.get("id").cloned().unwrap_or(json!("")),
            "configured": true,
            "models": p.get("models").cloned().unwrap_or(json!([])),
            "selectedModel": p.get("selectedModel").cloned().unwrap_or(json!("")),
        }))
        .collect::<Vec<_>>())))
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "admin required".to_string()));
    }
    Ok(())
}

/// `POST /api/ai/providers/models` -- the model list for a connection the
/// provider editor may not have saved yet (`{id?, provider?, apiKey?, baseUrl?}`
/// in, `{models: string[]}` out).
///
/// The editor's suggestion box is the only place a user can pick from a
/// provider's catalog, so this answers with the same catalog `/api/ai/providers`
/// serves. A connection with no catalog entry yet (a brand-new custom endpoint)
/// answers with an empty list rather than an error: the editor lets the user
/// type ids by hand in that case.
async fn post_provider_models(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let requested = body
        .get("id")
        .or_else(|| body.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let catalog = build_catalog(&state).await;
    let models = catalog
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers.iter().find(|p| {
                p.get("id")
                    .and_then(Value::as_str)
                    .map(|id| id.eq_ignore_ascii_case(&requested))
                    .unwrap_or(false)
            })
        })
        .and_then(|p| p.get("models"))
        .cloned()
        .unwrap_or(json!([]));
    Ok(Json(json!({ "models": models })))
}

async fn provider_status(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({"status": "ok"}))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat/models", get(get_chat_models))
        .route("/api/ai/providers", get(get_ai_providers))
        .route("/api/ai/providers/models", post(post_provider_models))
        .route("/api/ai/providers/status", get(provider_status))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(root: &std::path::Path) -> AppState {
        AppState {
            home: root.join("home"),
            workspace: root.join("workspace"),
            runtime_home: root.to_path_buf(),
            runtime_socket: root.join("run/amiro-api.sock"),
            runtime_bin: root.join("stub-runtime"),
            token: "test-token".to_string(),
            store: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn names_of(document: Value) -> Vec<String> {
        let mut names = Vec::new();
        collect_model_names(&document, &mut names);
        names
    }

    #[test]
    fn flat_catalogs_contribute_object_and_string_entries() {
        let document = json!({
            "cached_at": 1,
            "source_api_base": "https://example.test/v1",
            "models": [
                {"id": "anthropic/claude-sonnet-4", "name": ""},
                {"name": "gpt-5.6-luna"},
                "muse-spark-1.2",
                {"id": "  "},
                {"id": "anthropic/claude-sonnet-4"},
            ],
        });
        assert_eq!(
            names_of(document),
            vec![
                "anthropic/claude-sonnet-4".to_string(),
                "gpt-5.6-luna".to_string(),
                "muse-spark-1.2".to_string(),
            ]
        );
    }

    #[test]
    fn account_scoped_catalogs_contribute_every_account() {
        let document = json!({
            "scopes": {
                "openai-otter": {"models": ["gpt-6-astra", "gpt-5.6-luna"]},
                "openai-otter-2": {"models": [{"id": "gpt-6-sol"}]},
            }
        });
        assert_eq!(
            names_of(document),
            vec![
                "gpt-6-astra".to_string(),
                "gpt-5.6-luna".to_string(),
                "gpt-6-sol".to_string(),
            ]
        );
    }

    #[test]
    fn endpoint_shape_differences_still_match_one_service() {
        assert!(same_endpoint(
            "https://gateway.test/v1",
            "https://gateway.test/v1"
        ));
        assert!(same_endpoint(
            "https://gateway.test/v1/",
            "https://gateway.test/v1"
        ));
        assert!(same_endpoint(
            "https://gateway.test",
            "https://gateway.test/v1"
        ));
        assert!(!same_endpoint(
            "https://opencode.ai/zen/go/v1",
            "https://gateway.test/v1"
        ));
        assert!(!same_endpoint("", "https://gateway.test/v1"));
    }

    /// A catalog is only this provider's if its recorded endpoint matches what
    /// the provider is configured for, or it agrees with the live list. The
    /// negative case is a real file: a `meta-muse` cache holding an OpenCode Go
    /// catalog (its base URL still says `opencode.ai`).
    #[test]
    fn foreign_catalogs_are_rejected_and_matching_ones_accepted() {
        let live = vec!["muse-spark-1.2".to_string()];
        let foreign = CachedCatalog {
            source_api_base: Some("https://opencode.ai/zen/go/v1".to_string()),
            models: vec!["deepseek-v4.1-flash".to_string()],
        };
        assert!(!catalog_belongs_to_provider(&foreign, &live, None));
        assert!(!catalog_belongs_to_provider(
            &foreign,
            &live,
            Some("https://api.meta.ai/v1")
        ));
        // Same file, now with the endpoint the provider is configured for.
        assert!(catalog_belongs_to_provider(
            &foreign,
            &live,
            Some("https://opencode.ai/zen/go/v1")
        ));
        // Or with a live list that still shares a model with it.
        let agreeing = CachedCatalog {
            source_api_base: Some("https://opencode.ai/zen/go/v1".to_string()),
            models: vec!["deepseek-v4.1-flash".to_string(), "muse-spark-1.2".to_string()],
        };
        assert!(catalog_belongs_to_provider(&agreeing, &live, None));
    }

    #[tokio::test]
    async fn cached_catalogs_are_read_from_every_runtime_catalog_file() {
        let root = std::env::temp_dir().join(format!("amiro-models-{}", uuid::Uuid::new_v4()));
        let state = test_state(&root);
        let cache = root.join("cache");
        let config = root.join("config/jcode");
        tokio::fs::create_dir_all(&cache).await.unwrap();
        tokio::fs::create_dir_all(&config).await.unwrap();
        tokio::fs::write(
            cache.join("openai-compatible_models.json"),
            json!({"source_api_base": "https://gateway.test/v1", "models": [{"id": "ag/gemini-3.8-flash"}, "muse-spark-1.2"]}).to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            config.join("antigravity_models_cache.json"),
            json!({"models": [{"id": "gemini-3-flash"}]}).to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            config.join("openai_model_catalog_cache.json"),
            json!({"scopes": {"openai-otter": {"models": ["gpt-6-astra"]}}}).to_string(),
        )
        .await
        .unwrap();

        let catalogs = cached_provider_catalogs(&state, "openai-compatible").await;
        assert_eq!(catalogs.len(), 1);
        assert_eq!(
            catalogs[0].models,
            vec!["ag/gemini-3.8-flash".to_string(), "muse-spark-1.2".to_string()]
        );
        assert_eq!(
            catalogs[0].source_api_base.as_deref(),
            Some("https://gateway.test/v1")
        );
        assert_eq!(
            cached_provider_catalogs(&state, "antigravity").await[0].models,
            vec!["gemini-3-flash".to_string()]
        );
        // The OpenAI catalog is account-scoped, so it is attributed to the
        // OpenAI provider id only.
        assert_eq!(
            cached_provider_catalogs(&state, "openai").await[0].models,
            vec!["gpt-6-astra".to_string()]
        );
        assert!(cached_provider_catalogs(&state, "openrouter").await.is_empty());

        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    #[tokio::test]
    async fn provider_api_base_reads_the_providers_own_env_file() {
        let root = std::env::temp_dir().join(format!("amiro-models-{}", uuid::Uuid::new_v4()));
        let state = test_state(&root);
        tokio::fs::create_dir_all(root.join("config/jcode"))
            .await
            .unwrap();
        tokio::fs::write(
            root.join("config/jcode/openai-compatible.env"),
            "AMIRO_OPENAI_COMPAT_API_BASE=https://gateway.test/v1\nJCODE_OPENAI_COMPAT_API_BASE=https://old.test/v1\nOPENAI_COMPAT_API_KEY=secret\n",
        )
        .await
        .unwrap();
        assert_eq!(
            provider_api_base(&state, "openai-compatible").await.as_deref(),
            Some("https://gateway.test/v1")
        );
        assert_eq!(provider_api_base(&state, "opencode-go").await, None);

        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    /// A runtime CLI stub driven by files in the runtime home, so parallel
    /// tests cannot race on shared state:
    ///
    /// * `stub-auth.json` -- what `auth status --json` answers;
    /// * `stub-models.json` -- what `model list -p <id> --json` answers (a
    ///   static, one-entry fallback is exactly what the real CLI returns when
    ///   its live `/models` refresh fails);
    /// * `stub-refresh-failed` -- when present, the CLI also warns on stderr
    ///   that it could not refresh the dynamic catalog, still exiting 0.
    #[cfg(unix)]
    fn write_stub_runtime(state: &AppState) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = state.runtime_home.join("stub-runtime");
        let body = r#"#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "auth" ]; then
  cat "$here/stub-auth.json"
  exit 0
fi
if [ "$1" = "model" ]; then
  [ -f "$here/stub-refresh-failed" ] && echo 'Warning: failed to refresh dynamic model list' >&2
  cat "$here/stub-models.json"
  exit 0
fi
exit 1
"#;
        std::fs::create_dir_all(&state.runtime_home).unwrap();
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// Writes a runtime home whose live catalog refresh fails, with the cached
    /// catalogs of the real deployment: an OpenAI-compatible gateway plus a
    /// `meta-muse` file that actually holds another endpoint's models.
    #[cfg(unix)]
    async fn degraded_fixture() -> (std::path::PathBuf, AppState) {
        let root = std::env::temp_dir().join(format!("amiro-models-{}", uuid::Uuid::new_v4()));
        let mut state = test_state(&root);
        state.runtime_bin = write_stub_runtime(&state);
        tokio::fs::create_dir_all(root.join("cache")).await.unwrap();
        tokio::fs::create_dir_all(root.join("config/jcode"))
            .await
            .unwrap();
        // The gateway Amiro is connected to, declared where the login flow puts it.
        tokio::fs::write(
            root.join("config/jcode/openai-compatible.env"),
            "OPENAI_COMPAT_API_KEY=secret\nAMIRO_OPENAI_COMPAT_API_BASE=https://gateway.test/v1\n",
        )
        .await
        .unwrap();
        // Its cached catalog: 3 models, none of them the CLI's static fallback.
        tokio::fs::write(
            root.join("cache/openai-compatible_models.json"),
            json!({
                "source_api_base": "https://gateway.test/v1",
                "models": [{"id": "ag/gemini-3.8-flash"}, {"id": "zai/glm-5"}, {"id": "kimi-k3"}],
            })
            .to_string(),
        )
        .await
        .unwrap();
        // A cache for another provider that holds yet another endpoint's models.
        tokio::fs::write(
            root.join("cache/meta-muse_models.json"),
            json!({
                "source_api_base": "https://opencode.ai/zen/go/v1",
                "models": [{"id": "deepseek-v4.1-flash"}, {"id": "glm-5.3"}],
            })
            .to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            root.join("stub-auth.json"),
            json!({"providers":[
                {"id":"openai-compatible","display_name":"OpenAI-compatible","status":"available"},
                {"id":"meta-muse","display_name":"Meta Model API","status":"available"}
            ]})
            .to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            root.join("stub-models.json"),
            json!({
                "provider": "x",
                "selected_model": "static-one",
                "models": ["static-one"],
                "routes": [{"model": "static-one", "available": true}],
            })
            .to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(root.join("stub-refresh-failed"), "")
            .await
            .unwrap();
        (root, state)
    }

    /// Reads one provider's model list out of a built catalog.
    fn models_of(catalog: &Value, id: &str) -> Vec<String> {
        catalog
            .get("providers")
            .and_then(Value::as_array)
            .and_then(|providers| {
                providers
                    .iter()
                    .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
            })
            .and_then(|p| p.get("models"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|entry| entry.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The regression this file exists for: a provider whose live refresh
    /// failed must still report every model the runtime has cached, instead of
    /// the CLI's one-entry fallback -- and must not report a catalog that
    /// belongs to a different endpoint.
    #[cfg(unix)]
    #[tokio::test]
    async fn catalog_keeps_the_runtime_cache_when_the_live_listing_degrades() {
        let (root, state) = degraded_fixture().await;

        invalidate_catalog();
        let catalog = build_catalog(&state).await;
        invalidate_catalog();

        // The degraded provider keeps the fallback *and* everything the runtime
        // fetched last time, live entry first.
        assert_eq!(
            models_of(&catalog, "openai-compatible"),
            vec![
                "static-one".to_string(),
                "ag/gemini-3.8-flash".to_string(),
                "zai/glm-5".to_string(),
                "kimi-k3".to_string(),
            ]
        );
        // The other provider only reports its own live list: its cache file
        // belongs to a different endpoint and is not evidence about it.
        assert_eq!(models_of(&catalog, "meta-muse"), vec!["static-one".to_string()]);

        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    /// While the live listing is complete it is the runtime's curated view, so
    /// the raw cached catalog (which also holds models the runtime filters out
    /// of the picker) must not be added on top of it.
    #[cfg(unix)]
    #[tokio::test]
    async fn catalog_does_not_add_cached_models_over_a_complete_live_listing() {
        let (root, state) = degraded_fixture().await;
        tokio::fs::remove_file(root.join("stub-refresh-failed"))
            .await
            .unwrap();

        invalidate_catalog();
        let catalog = build_catalog(&state).await;
        invalidate_catalog();

        assert_eq!(
            models_of(&catalog, "openai-compatible"),
            vec!["static-one".to_string()]
        );

        tokio::fs::remove_dir_all(&root).await.unwrap();
    }
}
