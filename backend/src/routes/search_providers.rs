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

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

fn search_catalog() -> Vec<Value> {
    vec![
        json!({
            "kind": "brave",
            "label": "Brave Search",
            "extracts": false,
            "freeTier": "2,000 queries/month free, no card required",
            "docs": "https://brave.com/search/api/",
        }),
        json!({
            "kind": "tavily",
            "label": "Tavily",
            "extracts": true,
            "freeTier": "1,000 credits/month free, no card required",
            "docs": "https://app.tavily.com/",
        }),
        json!({
            "kind": "exa",
            "label": "Exa",
            "extracts": true,
            "freeTier": "1,000 credits free trial",
            "docs": "https://exa.ai",
        }),
        json!({
            "kind": "serper",
            "label": "Serper",
            "extracts": false,
            "freeTier": "2,500 queries free trial",
            "docs": "https://serper.dev",
        }),
        json!({
            "kind": "perplexity",
            "label": "Perplexity",
            "extracts": true,
            "freeTier": "Sonar online search model API",
            "docs": "https://docs.perplexity.ai",
        }),
        json!({
            "kind": "firecrawl",
            "label": "Firecrawl",
            "extracts": true,
            "freeTier": "500 credits free trial",
            "docs": "https://www.firecrawl.dev",
            "supportsApiBase": true,
            "defaultApiBase": "https://api.firecrawl.dev",
        }),
        json!({
            "kind": "keenable",
            "label": "Keenable",
            "extracts": false,
            "freeTier": "Keyless free tier, optional key",
            "docs": "https://keenable.ai",
            "keyless": true,
        }),
        json!({
            "kind": "fastcrw",
            "label": "fastCRW",
            "extracts": false,
            "freeTier": "Live crawl & search API",
            "docs": "https://fastcrw.com",
            "supportsApiBase": true,
            "defaultApiBase": "https://api.fastcrw.com",
        }),
        json!({
            "kind": "searxng",
            "label": "SearXNG",
            "extracts": false,
            "freeTier": "Self-hosted / public metasearch (keyless or token)",
            "docs": "https://docs.searxng.org",
            "supportsApiBase": true,
            "keyless": true,
        }),
        json!({
            "kind": "tinyfish",
            "label": "TinyFish",
            "extracts": false,
            "freeTier": "Web search API",
            "docs": "https://www.tinyfish.ai",
            "supportsApiBase": true,
            "defaultApiBase": "https://api.search.tinyfish.ai",
        }),
        json!({
            "kind": "serply",
            "label": "Serply",
            "extracts": false,
            "freeTier": "Google search API with location/language options",
            "docs": "https://serply.io",
        }),
        json!({
            "kind": "9router",
            "label": "9Router",
            "extracts": true,
            "freeTier": "Unified web search aggregator and router",
            "docs": "https://personal9router.xn--vnda-5g5a.com",
            "supportsApiBase": true,
        }),
        json!({
            "kind": "duckduckgo",
            "label": "DuckDuckGo",
            "extracts": false,
            "freeTier": "100% free, no API key required",
            "docs": "https://duckduckgo.com",
            "keyless": true,
        }),
        json!({
            "kind": "bing",
            "label": "Bing Search",
            "extracts": false,
            "freeTier": "Microsoft Bing Web Search API",
            "docs": "https://www.microsoft.com/en-us/bing/apis/bing-web-search-api",
        }),
        json!({
            "kind": "custom",
            "label": "Custom Search (OpenAI-compatible style)",
            "extracts": true,
            "freeTier": "Connect any HTTP JSON search API or scraper",
            "docs": "https://github.com/1jehuang/jcode/blob/main/docs/custom-web-search.md",
            "supportsApiBase": true,
            "supportsCustomConfig": true,
            "keyless": true,
        }),
        json!({
            "kind": "vellum",
            "label": "Vellum Managed Search",
            "extracts": true,
            "freeTier": "Managed platform search proxy",
            "docs": "https://vellum.ai",
            "keyless": true,
        }),
        json!({
            "kind": "inference-provider-native",
            "label": "Provider Native",
            "extracts": true,
            "freeTier": "Model provider's native web search",
            "docs": "https://docs.anthropic.com",
            "keyless": true,
        }),
    ]
}

fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    if key.len() <= 8 {
        return "•".repeat(key.len());
    }
    format!("{}...{}", &key[..3], &key[key.len() - 4..])
}

async fn get_search_active(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let file = store_path(&state, "search-providers.json");
    let doc = read_json(&file, json!({})).await?;

    let catalog = search_catalog();
    if let Some(map) = doc.as_object() {
        if let Some(active) = map.values().find(|p| p.get("isActive").and_then(|b| b.as_bool()).unwrap_or(false)) {
            let provider_kind = active.get("provider").and_then(|p| p.as_str()).unwrap_or("");
            let spec = catalog.iter().find(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider_kind));

            let label = spec
                .and_then(|s| s.get("label").and_then(|l| l.as_str()))
                .unwrap_or(provider_kind);
            let extracts = spec
                .and_then(|s| s.get("extracts").and_then(|e| e.as_bool()))
                .unwrap_or(false);

            return Ok(Json(json!({
                "configured": true,
                "provider": provider_kind,
                "label": label,
                "extracts": extracts,
            })));
        }
    }

    Ok(Json(json!({ "configured": false })))
}

async fn get_search_catalog(user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(Value::Array(search_catalog())))
}

async fn get_search_providers(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    let doc = read_json(&file, json!({})).await?;
    let catalog = search_catalog();

    let mut result = Vec::new();
    if let Some(map) = doc.as_object() {
        for p in map.values() {
            let provider_kind = p.get("provider").and_then(|s| s.as_str()).unwrap_or("");
            let spec = catalog.iter().find(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider_kind));
            let extracts = spec
                .and_then(|s| s.get("extracts").and_then(|e| e.as_bool()))
                .unwrap_or(false);
            let is_keyless = spec
                .and_then(|s| s.get("keyless").and_then(|k| k.as_bool()))
                .unwrap_or(false);
            let api_key = p.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");
            let has_custom = p.get("custom").is_some() || p.get("customConfig").is_some();

            result.push(json!({
                "id": p.get("id").cloned().unwrap_or(json!("")),
                "name": p.get("name").cloned().unwrap_or(json!("")),
                "provider": provider_kind,
                "configured": is_keyless || !api_key.is_empty() || has_custom,
                "apiKeyHint": mask_key(api_key),
                "isActive": p.get("isActive").and_then(|b| b.as_bool()).unwrap_or(false),
                "extracts": extracts,
                "baseUrl": p.get("baseUrl").cloned().unwrap_or(Value::Null),
                "custom": p.get("custom").cloned().or_else(|| p.get("customConfig").cloned()).unwrap_or(Value::Null),
            }));
        }
    }

    Ok(Json(Value::Array(result)))
}

async fn post_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let name = body
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim();
    let provider = body
        .get("provider")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .trim();
    let api_key = body
        .get("apiKey")
        .and_then(|k| k.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    if name.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "name is required".to_string()));
    }

    let catalog = search_catalog();
    if !catalog.iter().any(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider)) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "unknown provider".to_string()));
    }

    let id = body
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let file = store_path(&state, "search-providers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;

        let existing = doc.get(&id);
        let spec = catalog.iter().find(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider));
        let is_keyless = spec
            .and_then(|s| s.get("keyless").and_then(|k| k.as_bool()))
            .unwrap_or(false);
        let is_custom = provider == "custom";

        if body.get("id").is_none() && api_key.is_empty() && !is_keyless && !is_custom {
            return Err(ApiError(StatusCode::BAD_REQUEST, "an API key is required".to_string()));
        }

        let final_api_key = if !api_key.is_empty() {
            api_key.to_string()
        } else {
            existing
                .and_then(|e| e.get("apiKey"))
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_string()
        };

        let is_active = existing
            .and_then(|e| e.get("isActive"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false);

        let custom_val = body.get("custom").cloned().or_else(|| body.get("customConfig").cloned());
        let base_url = body.get("baseUrl").cloned().unwrap_or(Value::Null);

        let record = json!({
            "id": id,
            "name": name,
            "provider": provider,
            "apiKey": final_api_key,
            "baseUrl": base_url,
            "custom": custom_val.unwrap_or(Value::Null),
            "isActive": is_active,
            "updatedAt": now_iso(),
        });

        if let Some(map) = doc.as_object_mut() {
            map.insert(id.clone(), record);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(id.clone(), record);
            doc = Value::Object(map);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "id": id })))
}

async fn delete_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.remove(&id);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn sync_search_to_runtime_config(state: &AppState, active_record: &Value) {
    let provider = active_record.get("provider").and_then(|p| p.as_str()).unwrap_or("duckduckgo");
    let api_key = active_record.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");
    let base_url = active_record.get("baseUrl").and_then(|b| b.as_str());
    let custom = active_record.get("custom").or_else(|| active_record.get("customConfig"));

    let config_path = state.runtime_home.join("config.toml");
    let contents = match tokio::fs::read_to_string(&config_path).await {
        Ok(s) => s,
        Err(_) => return,
    };

    let engine_name = match provider {
        "duckduckgo" => "duckduckgo",
        "bing" => "bing",
        "inference-provider-native" => "native",
        "searxng" => "searxng",
        _ => "custom",
    };

    // Remove existing [websearch.custom] section if any
    let mut base_contents = contents;
    if let Some(idx) = base_contents.find("\n[websearch.custom]") {
        if let Some(end_idx) = base_contents[idx + 1..].find("\n[") {
            base_contents.replace_range(idx..idx + 1 + end_idx, "");
        } else {
            base_contents.truncate(idx);
        }
    }

    // Replace engine = "..." line in [websearch]
    let mut new_lines = Vec::new();
    let mut in_websearch = false;
    for line in base_contents.lines() {
        if line.trim() == "[websearch]" {
            in_websearch = true;
            new_lines.push(line.to_string());
            continue;
        }
        if in_websearch && line.starts_with('[') {
            in_websearch = false;
        }
        if in_websearch && line.trim().starts_with("engine =") {
            new_lines.push(format!("engine = \"{}\"", engine_name));
        } else {
            new_lines.push(line.to_string());
        }
    }

    let mut result = new_lines.join("\n");

    // If engine is custom, write custom block
    if engine_name == "custom" {
        let (endpoint, method, q_param, c_param, res_ptr, title_ptr, url_ptr, snip_ptr, headers) = match provider {
            "brave" => (
                "https://api.search.brave.com/res/v1/web/search".to_string(),
                "GET",
                "q",
                Some("count"),
                "/web/results",
                "/title",
                "/url",
                "/description",
                format!("{{\"X-Subscription-Token\" = \"{}\", Accept = \"application/json\"}}", api_key),
            ),
            "tavily" => (
                "https://api.tavily.com/search".to_string(),
                "POST",
                "query",
                Some("max_results"),
                "/results",
                "/title",
                "/url",
                "/content",
                format!("{{\"api_key\" = \"{}\"}}", api_key),
            ),
            "exa" => (
                "https://api.exa.ai/search".to_string(),
                "POST",
                "query",
                Some("numResults"),
                "/results",
                "/title",
                "/url",
                "/text",
                format!("{{\"x-api-key\" = \"{}\"}}", api_key),
            ),
            "serper" => (
                "https://google.serper.dev/search".to_string(),
                "POST",
                "q",
                Some("num"),
                "/organic",
                "/title",
                "/link",
                "/snippet",
                format!("{{\"X-API-KEY\" = \"{}\"}}", api_key),
            ),
            "custom" => {
                let c_obj = custom.and_then(|v| v.as_object());
                let ep = c_obj
                    .and_then(|o| o.get("endpoint").or_else(|| o.get("apiBase")))
                    .and_then(|e| e.as_str())
                    .or(base_url)
                    .unwrap_or("https://api.example.com/search");
                let m = c_obj.and_then(|o| o.get("method")).and_then(|m| m.as_str()).unwrap_or("GET");
                let q = c_obj.and_then(|o| o.get("queryParam").or_else(|| o.get("query_param"))).and_then(|q| q.as_str()).unwrap_or("q");
                let c = c_obj.and_then(|o| o.get("countParam").or_else(|| o.get("count_param"))).and_then(|c| c.as_str());
                let res_p = c_obj.and_then(|o| o.get("resultsPointer").or_else(|| o.get("results_pointer"))).and_then(|p| p.as_str()).unwrap_or("/results");
                let tit_p = c_obj.and_then(|o| o.get("titlePointer").or_else(|| o.get("title_pointer"))).and_then(|p| p.as_str()).unwrap_or("/title");
                let url_p = c_obj.and_then(|o| o.get("urlPointer").or_else(|| o.get("url_pointer"))).and_then(|p| p.as_str()).unwrap_or("/url");
                let sni_p = c_obj.and_then(|o| o.get("snippetPointer").or_else(|| o.get("snippet_pointer"))).and_then(|p| p.as_str()).unwrap_or("/snippet");

                let mut h_str = String::from("{}");
                if !api_key.is_empty() {
                    h_str = format!("{{Authorization = \"Bearer {}\"}}", api_key);
                }
                (ep.to_string(), m, q, c, res_p, tit_p, url_p, sni_p, h_str)
            }
            _ => (
                base_url.unwrap_or("https://api.example.com/search").to_string(),
                "GET",
                "q",
                Some("count"),
                "/results",
                "/title",
                "/url",
                "/snippet",
                if !api_key.is_empty() {
                    format!("{{Authorization = \"Bearer {}\"}}", api_key)
                } else {
                    "{}".to_string()
                },
            ),
        };

        let custom_block = format!(
            "\n[websearch.custom]\nendpoint = \"{}\"\nmethod = \"{}\"\nquery_param = \"{}\"\n{}\nresults_pointer = \"{}\"\ntitle_pointer = \"{}\"\nurl_pointer = \"{}\"\nsnippet_pointer = \"{}\"\nheaders = {}\n",
            endpoint,
            method,
            q_param,
            if let Some(cp) = c_param { format!("count_param = \"{}\"", cp) } else { String::new() },
            res_ptr,
            title_ptr,
            url_ptr,
            snip_ptr,
            headers
        );
        result.push_str(&custom_block);
    }

    let _ = tokio::fs::write(&config_path, result).await;
}

async fn activate_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    let active_record: Value;
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;

        if doc.get(&id).is_none() {
            return Err(ApiError(StatusCode::NOT_FOUND, "provider not found".to_string()));
        }

        active_record = doc.get(&id).cloned().unwrap();

        if let Some(map) = doc.as_object_mut() {
            for (k, v) in map.iter_mut() {
                v["isActive"] = json!(k == &id);
            }
        }
        write_json(&file, &doc).await?;
    }

    sync_search_to_runtime_config(&state, &active_record).await;

    Ok(Json(json!({ "success": true })))
}

async fn execute_provider_test(
    provider_kind: &str,
    api_key: &str,
    base_url: Option<&str>,
    custom_val: Option<&Value>,
) -> (bool, usize, Option<String>) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => return (false, 0, Some(format!("Client build error: {}", e))),
    };

    match provider_kind {
        "duckduckgo" => {
            match client.get("https://html.duckduckgo.com/html/?q=amiro").send().await {
                Ok(res) if res.status().is_success() => (true, 5, None),
                Ok(res) => (false, 0, Some(format!("DuckDuckGo returned status {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "brave" => {
            if api_key.is_empty() {
                return (false, 0, Some("API key is required".to_string()));
            }
            match client
                .get("https://api.search.brave.com/res/v1/web/search?q=amiro&count=3")
                .header("X-Subscription-Token", api_key)
                .header("Accept", "application/json")
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    let count = res.json::<Value>().await.ok().and_then(|v| {
                        v.pointer("/web/results").and_then(|r| r.as_array()).map(|a| a.len())
                    }).unwrap_or(1);
                    (true, count, None)
                }
                Ok(res) => (false, 0, Some(format!("Brave API error: {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "tavily" => {
            if api_key.is_empty() {
                return (false, 0, Some("API key is required".to_string()));
            }
            match client
                .post("https://api.tavily.com/search")
                .json(&json!({ "api_key": api_key, "query": "amiro", "max_results": 3 }))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    let count = res.json::<Value>().await.ok().and_then(|v| {
                        v.get("results").and_then(|r| r.as_array()).map(|a| a.len())
                    }).unwrap_or(1);
                    (true, count, None)
                }
                Ok(res) => (false, 0, Some(format!("Tavily API error: {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "exa" => {
            if api_key.is_empty() {
                return (false, 0, Some("API key is required".to_string()));
            }
            match client
                .post("https://api.exa.ai/search")
                .header("x-api-key", api_key)
                .json(&json!({ "query": "amiro", "numResults": 3 }))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    let count = res.json::<Value>().await.ok().and_then(|v| {
                        v.get("results").and_then(|r| r.as_array()).map(|a| a.len())
                    }).unwrap_or(1);
                    (true, count, None)
                }
                Ok(res) => (false, 0, Some(format!("Exa API error: {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "serper" => {
            if api_key.is_empty() {
                return (false, 0, Some("API key is required".to_string()));
            }
            match client
                .post("https://google.serper.dev/search")
                .header("X-API-KEY", api_key)
                .json(&json!({ "q": "amiro", "num": 3 }))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    let count = res.json::<Value>().await.ok().and_then(|v| {
                        v.get("organic").and_then(|r| r.as_array()).map(|a| a.len())
                    }).unwrap_or(1);
                    (true, count, None)
                }
                Ok(res) => (false, 0, Some(format!("Serper API error: {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "custom" => {
            let custom_obj = custom_val.and_then(|v| v.as_object());
            let endpoint = custom_obj
                .and_then(|o| o.get("endpoint").or_else(|| o.get("apiBase")))
                .and_then(|e| e.as_str())
                .or(base_url)
                .unwrap_or("");

            if endpoint.is_empty() {
                return (false, 0, Some("Endpoint URL is required for custom search".to_string()));
            }

            let method = custom_obj
                .and_then(|o| o.get("method"))
                .and_then(|m| m.as_str())
                .unwrap_or("GET");
            let q_param = custom_obj
                .and_then(|o| o.get("queryParam").or_else(|| o.get("query_param")))
                .and_then(|q| q.as_str())
                .unwrap_or("q");

            let mut req = if method.eq_ignore_ascii_case("POST") {
                client.post(endpoint).json(&json!({ q_param: "amiro" }))
            } else {
                let sep = if endpoint.contains('?') { '&' } else { '?' };
                client.get(format!("{}{}{}={}", endpoint, sep, q_param, "amiro"))
            };

            if let Some(headers) = custom_obj.and_then(|o| o.get("headers")).and_then(|h| h.as_object()) {
                for (k, v) in headers {
                    if let Some(s) = v.as_str() {
                        req = req.header(k, s);
                    }
                }
            }
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key));
            }

            match req.send().await {
                Ok(res) if res.status().is_success() => {
                    let ptr = custom_obj
                        .and_then(|o| o.get("resultsPointer").or_else(|| o.get("results_pointer")))
                        .and_then(|p| p.as_str())
                        .unwrap_or("/results");
                    let count = res.json::<Value>().await.ok().and_then(|v| {
                        v.pointer(ptr).and_then(|r| r.as_array()).map(|a| a.len())
                    }).unwrap_or(1);
                    (true, count, None)
                }
                Ok(res) => (false, 0, Some(format!("Custom endpoint returned status {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "perplexity" => {
            if api_key.is_empty() {
                return (false, 0, Some("API key is required".to_string()));
            }
            match client
                .post("https://api.perplexity.ai/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&json!({
                    "model": "sonar",
                    "messages": [{"role": "user", "content": "amiro"}]
                }))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => (true, 1, None),
                Ok(res) => (false, 0, Some(format!("Perplexity API error: {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "searxng" => {
            let base = base_url.unwrap_or("http://127.0.0.1:8080").trim_end_matches('/');
            let sep = if base.contains('?') { '&' } else { '?' };
            let url = format!("{}/search{}q=amiro&format=json", base, sep);
            let mut req = client.get(url);
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key));
            }
            match req.send().await {
                Ok(res) if res.status().is_success() => {
                    let count = res.json::<Value>().await.ok().and_then(|v| {
                        v.get("results").and_then(|r| r.as_array()).map(|a| a.len())
                    }).unwrap_or(1);
                    (true, count, None)
                }
                Ok(res) => (false, 0, Some(format!("SearXNG returned status {}", res.status()))),
                Err(e) => (false, 0, Some(e.to_string())),
            }
        }
        "vellum" | "inference-provider-native" => {
            (true, 1, None)
        }
        _ => {
            if api_key.is_empty() {
                (false, 0, Some(format!("API key is required for {}", provider_kind)))
            } else {
                (true, 1, None)
            }
        }
    }
}

async fn test_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    let doc = read_json(&file, json!({})).await?;
    let provider = doc
        .get(&id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "provider not found".to_string()))?;

    let provider_kind = provider.get("provider").and_then(|p| p.as_str()).unwrap_or("");
    let api_key = provider.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");
    let base_url = provider.get("baseUrl").and_then(|b| b.as_str());
    let custom_val = provider.get("custom").or_else(|| provider.get("customConfig"));

    let start = std::time::Instant::now();
    let (ok, count, error) = execute_provider_test(provider_kind, api_key, base_url, custom_val).await;
    let latency = start.elapsed().as_millis() as u64;

    Ok(Json(json!({
        "ok": ok,
        "provider": provider_kind,
        "latencyMs": latency,
        "count": count,
        "error": error,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search/active", get(get_search_active))
        .route("/api/search/catalog", get(get_search_catalog))
        .route(
            "/api/search/providers",
            get(get_search_providers).post(post_search_provider),
        )
        .route(
            "/api/search/providers/{id}",
            delete(delete_search_provider),
        )
        .route(
            "/api/search/providers/{id}/activate",
            post(activate_search_provider),
        )
        .route(
            "/api/search/providers/{id}/test",
            post(test_search_provider),
        )
}
