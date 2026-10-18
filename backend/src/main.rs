//! Native Amiro backend entry point.
//!
//! Serves the JSON API, the built UI (for browser and development use), and the
//! sidecar boundary in front of both. The desktop webview loads `out/` itself
//! and is given `__BACKEND_PORT__`/`__BACKEND_TOKEN__` by Tauri; when the
//! backend serves the page instead, it injects the same two globals.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

use backend::auth;
use backend::state::AppState;

/// Origins a development frontend may use. Everything else must match the
/// request's own Host, or be named in `AMIRO_ALLOWED_ORIGIN`.
const DEV_ORIGINS: &[&str] = &[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3210",
    "http://127.0.0.1:3210",
    "tauri://localhost",
    "http://tauri.localhost",
];

fn forbidden(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::FORBIDDEN, Json(json!({"error": msg})))
}
fn unauthorized(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::UNAUTHORIZED, Json(json!({"error": msg})))
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"status":"ok"}))
}

/// `host[:port]` of a URL, with the scheme's default port filled in so
/// `http://host` and `http://host:80` compare equal.
fn url_authority(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    match url.port_or_known_default() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host.to_string()),
    }
}

fn origin_allowed(origin: &str, host: &str) -> bool {
    if DEV_ORIGINS.contains(&origin) {
        return true;
    }
    if let Ok(extra) = std::env::var("AMIRO_ALLOWED_ORIGIN") {
        if extra.split(',').any(|entry| entry.trim() == origin) {
            return true;
        }
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    // A same-origin page request sends Origin only for some methods; when it
    // does, it must name this listener exactly.
    let Ok(host_url) = url::Url::parse(&format!("{}://{}", url.scheme(), host)) else {
        return false;
    };
    match (url_authority(&url), url_authority(&host_url)) {
        (Some(origin), Some(authority)) => origin.eq_ignore_ascii_case(&authority),
        _ => false,
    }
}

fn add_cors(mut response: Response, origin: Option<&str>) -> Response {
    if let Some(origin) = origin {
        if let Ok(value) = HeaderValue::from_str(origin) {
            response
                .headers_mut()
                .insert("access-control-allow-origin", value);
            response
                .headers_mut()
                .insert("vary", HeaderValue::from_static("Origin"));
        }
    }
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,POST,PUT,DELETE,PATCH,OPTIONS"),
    );
    response.headers_mut().insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Content-Type,Authorization,X-Amiro-Token"),
    );
    response
}

fn constant_time_eq(expected: &str, provided: &str) -> bool {
    use subtle::ConstantTimeEq;
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    expected.len() == provided.len() && bool::from(expected.ct_eq(provided))
}

fn request_token(headers: &axum::http::HeaderMap, uri: &axum::http::Uri) -> String {
    if let Some(value) = headers
        .get("x-amiro-token")
        .and_then(|value| value.to_str().ok())
    {
        return value.to_string();
    }
    uri.query()
        .and_then(|query| {
            query.split('&').find_map(|pair| {
                let (key, value) = pair.split_once('=')?;
                (key == "token").then(|| value.to_string())
            })
        })
        .unwrap_or_default()
}

/// Boundary for every request.
///
/// - Rejects an Origin that is neither this listener nor an allowlisted dev
///   origin, so a random local page cannot drive the API.
/// - Answers CORS preflight here, before routing: a preflight carries no
///   custom headers, and a catch-all OPTIONS route would otherwise shadow the
///   static UI for every GET.
/// - Requires the sidecar secret for every API call and every non-read request,
///   exactly as the desktop webview does. Static assets are public because a
///   browser navigation cannot attach `X-Amiro-Token`; they hold no secrets.
async fn sidecar_and_origin_middleware(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();
    let uri = req.uri().clone();
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if let Some(origin) = origin.as_deref() {
        if !origin_allowed(origin, &host) {
            return forbidden("origin not allowed").into_response();
        }
    }
    if method == Method::OPTIONS {
        return add_cors(StatusCode::NO_CONTENT.into_response(), origin.as_deref());
    }

    let is_read = matches!(method, Method::GET | Method::HEAD);
    // The static UI is public: a browser navigation cannot attach a custom
    // header. Everything that can change state, and every API call, carries the
    // sidecar secret exactly as it does inside the desktop webview.
    let needs_secret = path.starts_with("/api") || path == "/health" || !is_read;

    if needs_secret {
        let token = std::env::var("AMIRO_TOKEN").unwrap_or_default();
        if !token.is_empty() && !constant_time_eq(&token, &request_token(&headers, &uri)) {
            return add_cors(
                unauthorized("invalid or missing sidecar token").into_response(),
                origin.as_deref(),
            );
        }
    }

    let response = next.run(req).await;
    add_cors(response, origin.as_deref())
}

/// Hand a page served by this backend the same two globals Tauri injects:
/// the listener's port and the sidecar secret. The frontend then talks to this
/// backend with the same authenticated path it uses inside the desktop shell,
/// instead of falling back to the development port.
async fn inject_backend_origin(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:8787")
        .to_string();
    let port = host
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .unwrap_or(8787);
    let secret = std::env::var("AMIRO_TOKEN").unwrap_or_default();
    let response = next.run(req).await;
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("text/html"))
        .unwrap_or(false);
    if !is_html {
        return response;
    }
    let size = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if size > 8 * 1024 * 1024 {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 8 * 1024 * 1024).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let html = String::from_utf8_lossy(&bytes);
    if html.contains("__BACKEND_PORT__") {
        parts.headers.remove(header::CONTENT_LENGTH);
        return Response::from_parts(parts, Body::from(bytes));
    }
    // Same-origin first: this backend serves both the page and the API on one
    // listener, so the frontend must call relative /api URLs. Injecting only
    // __BACKEND_PORT__ made browsers on a public origin fetch
    // http://127.0.0.1:<public-port>, which Private Network Access blocks.
    // config.ts checks __BACKEND_ORIGIN__ (typeof string, "" = same origin)
    // before __BACKEND_PORT__, so the port stays for Tauri/dev readers.
    let bootstrap = format!(
        "<head><script>window.__BACKEND_ORIGIN__ = \"\";\nwindow.__BACKEND_PORT__ = {port};\nwindow.__BACKEND_TOKEN__ = {};</script>",
        serde_json::Value::String(secret)
    );
    let injected = html.replacen("<head>", &bootstrap, 1);
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(injected))
}

/// Map a client-side route onto the file Next exported for it.
///
/// `output: export` writes one `<route>.html` per page (plus an RSC payload
/// directory). A plain `ServeDir` cannot find `/agent/` or `/agent/workspace`,
/// so without this the SPA fallback would return the chat page for every route.
async fn resolve_static_route(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD) {
        let path = req.uri().path().to_string();
        if !path.starts_with("/api") && path != "/health" {
            let out_dir = state.out_dir();
            let trimmed = path.trim_start_matches('/').trim_end_matches('/');
            if !trimmed.is_empty() && !trimmed.contains("..") {
                let candidates = [format!("/{trimmed}.html"), format!("/{trimmed}/index.html")];
                if let Some(target) = candidates
                    .into_iter()
                    .find(|candidate| out_dir.join(candidate.trim_start_matches('/')).is_file())
                {
                    let (mut parts, body) = req.into_parts();
                    let rewritten = match parts.uri.query() {
                        Some(query) => format!("{target}?{query}"),
                        None => target,
                    };
                    if let Ok(uri) = rewritten.parse() {
                        parts.uri = uri;
                    }
                    req = Request::from_parts(parts, body);
                }
            }
        }
    }
    next.run(req).await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let state = AppState::from_env();
    tokio::fs::create_dir_all(&state.home).await.ok();
    tokio::fs::create_dir_all(&state.workspace).await.ok();
    tokio::fs::create_dir_all(&state.runtime_home).await.ok();

    if let Err(error) = auth::init(&state).await {
        // Auth init failures include an insecure admin check: never boot.
        eprintln!("auth init failed: {}", error.1);
        std::process::exit(1);
    }

    // Fold any legacy plaintext Composio key into the encrypted credential store
    // before the server accepts requests so the plaintext file is removed.
    if let Err(error) = backend::composio_config::migrate_legacy(&state).await {
        tracing::warn!("legacy Composio key migration failed: {}", error.1);
    }

    backend::routes::search_providers::initialize(&state)
        .await
        .map_err(|error| anyhow::anyhow!("search provider initialization failed: {}", error.1))?;

    // Keep the runtime alive while the app is open and recover it if its daemon
    // exits after the idle timeout, so the first chat after a pause still works.
    backend::runtime::spawn_supervisor(state.clone());

    let out_dir: PathBuf = state.out_dir();
    tracing::info!(
        home=%state.home.display(),
        runtime_home=%state.runtime_home.display(),
        runtime_bin=%state.runtime_bin.display(),
        out_dir=%out_dir.display(),
        "amiro-backend starting"
    );

    let mut app = Router::new()
        .route("/health", get(health))
        .merge(auth::router())
        .merge(backend::chat::router())
        .merge(backend::threads::router())
        .merge(backend::swarm::router())
        .merge(backend::models::router())
        .merge(backend::agent::router())
        .merge(backend::routes::router())
        // Unknown API paths answer as JSON, never as the UI shell.
        .route(
            "/api/{*path}",
            get(|| async { (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))) }),
        );

    if out_dir.is_dir() {
        let index = out_dir.join("index.html");
        if index.is_file() {
            // `fallback` (not `not_found_service`) so client-side routes such as
            // /agent/workspace answer 200 with the shell instead of a 404 body.
            app = app.fallback_service(ServeDir::new(&out_dir).fallback(ServeFile::new(index)));
        } else {
            app = app.fallback_service(ServeDir::new(&out_dir));
        }
    } else {
        tracing::warn!(out_dir=%out_dir.display(), "out dir missing, static serving disabled");
    }

    let app = app
        .layer(middleware::from_fn_with_state(
            state.clone(),
            resolve_static_route,
        ))
        .layer(middleware::from_fn(inject_backend_origin))
        .layer(middleware::from_fn(sidecar_and_origin_middleware))
        .with_state(state.clone());

    let port: u16 = std::env::var("AMIRO_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let host = std::env::var("AMIRO_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let addr = format!("{host}:{port}");
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if !loopback && std::env::var("AMIRO_TOKEN").unwrap_or_default().is_empty() {
        tracing::warn!(
            addr = %addr,
            "bound to a non-loopback address without AMIRO_TOKEN; put TLS and a network boundary in front of Amiro before exposing it"
        );
    }
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    // A process that cannot bind its listener must never start background work.
    let scheduler = backend::schedules::spawn_scheduler(state);
    tracing::info!(addr=%addr, "listening");
    axum::serve(listener, app).await?;
    scheduler.abort();
    Ok(())
}
