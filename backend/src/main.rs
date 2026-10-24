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

/// First entry of a possibly comma-separated forwarded header value
/// (`X-Forwarded-Host: a.example, b.example`), trimmed. Empty when absent.
fn first_forwarded(value: Option<&HeaderValue>) -> String {
    value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_default()
}

/// Is `entry` from `AMIRO_ALLOWED_ORIGIN` a match for `origin`?
/// `*` allows every origin; anything else is an exact, case-insensitive URL.
fn allowed_origin_entry_matches(entry: &str, origin: &str) -> bool {
    let entry = entry.trim();
    if entry.is_empty() {
        return false;
    }
    if entry == "*" {
        return true;
    }
    entry.eq_ignore_ascii_case(origin.trim())
}

/// `true` when `origin` may talk to this listener.
///
/// - Dev origins (the Tauri webview and the two dev ports) always pass.
/// - `AMIRO_ALLOWED_ORIGIN` accepts `*` (wildcard, useful behind an
///   authenticated reverse proxy) or a comma-separated list of exact URLs.
/// - Otherwise the origin must name this listener itself. `host` is the
///   host the request reached this process with -- the `Host` header, or the
///   `X-Forwarded-Host` a reverse proxy in front of Amiro set -- and `proto`
///   is the scheme the browser actually used (`X-Forwarded-Proto` when a
///   proxy terminated TLS, `http` otherwise). So `https://amiro.example`
///   reached through a proxy that forwards to `127.0.0.1:8787` compares
///   equal, and a random local page cannot drive the API.
fn origin_allowed(origin: &str, host: &str, proto: &str) -> bool {
    if DEV_ORIGINS.contains(&origin) {
        return true;
    }
    if let Ok(extra) = std::env::var("AMIRO_ALLOWED_ORIGIN") {
        if extra
            .split(',')
            .any(|entry| allowed_origin_entry_matches(entry, origin))
        {
            return true;
        }
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    // A same-origin page request sends Origin only for some methods; when it
    // does, it must name this listener exactly.
    let scheme = if proto.eq_ignore_ascii_case("https") {
        "https"
    } else if proto.eq_ignore_ascii_case("http") {
        "http"
    } else {
        url.scheme()
    };
    let Ok(host_url) = url::Url::parse(&format!("{scheme}://{host}")) else {
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

/// How the browser reached this listener: `(host, proto, origin)`.
///
/// `host` is the Host header, corrected by a reverse proxy's
/// X-Forwarded-Host/X-Forwarded-Proto when one is in front (an nginx/caddy TLS
/// proxy forwards to 127.0.0.1:<port> while the browser's origin names the
/// public host, so the raw Host would never match).
fn request_view(headers: &axum::http::HeaderMap) -> (String, String, Option<String>) {
    let forwarded_host = first_forwarded(headers.get("x-forwarded-host"));
    let forwarded_proto = first_forwarded(headers.get("x-forwarded-proto"));
    let host = if forwarded_host.is_empty() {
        headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string()
    } else {
        forwarded_host
    };
    let proto = if forwarded_proto.is_empty() {
        "http".to_string()
    } else {
        forwarded_proto
    };
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    (host, proto, origin)
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
async fn sidecar_and_origin_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();
    let uri = req.uri().clone();
    let (host, proto, origin) = request_view(&headers);

    if let Some(origin) = origin.as_deref() {
        if !origin_allowed(origin, &host, &proto) {
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

    // The built-in agent MCP endpoint authenticates with its own token. Exactly
    // `POST /agent-mcp` with a valid agent token skips the sidecar secret; any
    // other request (including a bad/missing agent token) takes the normal path.
    let agent_mcp_ok = backend::agent_mcp::bypasses_sidecar(&state, &method, &path, &headers);

    if needs_secret && !agent_mcp_ok {
        let token = std::env::var("AMIRO_TOKEN").unwrap_or_default();
        // A paired device (phone, or a desktop app connected to this server)
        // cannot know the sidecar secret; its own session stands in for it.
        if !token.is_empty()
            && !constant_time_eq(&token, &request_token(&headers, &uri))
            && !backend::devices::bypasses_sidecar(&state, &method, &path, &headers, &uri).await
        {
            return add_cors(
                unauthorized("invalid or missing sidecar token").into_response(),
                origin.as_deref(),
            );
        }
    }

    let response = next.run(req).await;
    add_cors(response, origin.as_deref())
}

/// Boundary for the phone-access listener (`backend::devices`).
///
/// It faces the local network, so it is stricter than the loopback listener:
/// the static UI, the auth-status read and the device's two steps of the
/// device code flow are public (the device code is the credential), and
/// everything else needs a paired device's session. Password sign-in, and so
/// approving at `/device`, is not accepted here: on Wi-Fi the owner approves on
/// the computer itself, so no password ever crosses the network in plain HTTP.
async fn remote_device_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let (host, proto, origin) = request_view(req.headers());
    if let Some(origin) = origin.as_deref() {
        if !origin_allowed(origin, &host, &proto) {
            return forbidden("origin not allowed").into_response();
        }
    }
    if method == Method::OPTIONS {
        return add_cors(StatusCode::NO_CONTENT.into_response(), origin.as_deref());
    }
    let is_read = matches!(method, Method::GET | Method::HEAD);
    let public = (is_read && !path.starts_with("/api") && path != "/health" && path != "/agent-mcp")
        || (is_read && path == "/api/auth/status")
        || backend::devices::is_device_flow(&method, &path);
    if !public && !backend::devices::is_device_request(&state, req.headers(), req.uri()).await {
        return add_cors(
            unauthorized("pair this device with Amiro first").into_response(),
            origin.as_deref(),
        );
    }
    let response = next.run(req).await;
    add_cors(response, origin.as_deref())
}

/// Hand a page served by this backend the same two globals Tauri injects:
/// the listener's port and the sidecar secret. The frontend then talks to this
/// backend with the same authenticated path it uses inside the desktop shell,
/// instead of falling back to the development port.
async fn inject_backend_origin(req: Request, next: Next) -> Response {
    let secret = std::env::var("AMIRO_TOKEN").unwrap_or_default();
    inject_bootstrap(req, next, secret).await
}

/// The phone-access listener's pages get the same bootstrap with no sidecar
/// secret: they are served to anyone on the network.
async fn inject_remote_origin(req: Request, next: Next) -> Response {
    inject_bootstrap(req, next, String::new()).await
}

async fn inject_bootstrap(req: Request, next: Next, secret: String) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:8787")
        .to_string();
    let configured_port = std::env::var("AMIRO_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok());
    // The port the browser actually used: the Host header's port when it
    // carries one (http://<vm-ip>:3000), the configured AMIRO_PORT when it
    // does not (a proxy on port 80 sends `Host: amiro.example` bare).
    let port = host
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .or(configured_port)
        .unwrap_or(8787);
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
            if let Some(target) = static_route_target(&state.out_dir(), &path) {
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
    next.run(req).await
}

/// The exported file to serve for `path`, or `None` to let `ServeDir` handle it
/// as is. An agent-scoped path (`/amiro/...`, `/<agentId>/...`) serves the
/// export of the bare route, and that includes its RSC payloads (`.txt`):
/// Next's client router fetches `/amiro/admin/providers.txt` when navigating
/// there, and answering that with HTML turns every in-app navigation inside an
/// agent's space into a full page load.
fn static_route_target(out_dir: &std::path::Path, path: &str) -> Option<String> {
    const RESERVED: &[&str] = &[
        "api", "team", "setup", "sign-in", "onboarding", "export", "_next", "storage", "health",
        "favicon.ico", "agent",
    ];
    let trimmed = path.trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") {
        return None;
    }
    // An existing static asset (image, font, RSC payload...): ServeDir has it.
    if out_dir.join(trimmed).is_file() {
        return None;
    }
    let exported = |route: &str| {
        [
            route.to_string(),
            format!("{route}.html"),
            format!("{route}/index.html"),
        ]
        .into_iter()
        .find(|candidate| out_dir.join(candidate).is_file())
        .map(|candidate| format!("/{candidate}"))
    };
    let index_html = || out_dir.join("index.html").is_file().then(|| "/index.html".to_string());

    if let Some(target) = exported(trimmed) {
        return Some(target);
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    if RESERVED.contains(&segments[0]) {
        return None;
    }
    let sub_path = segments[1..].join("/");
    if sub_path.is_empty() {
        // `/amiro.txt` is the agent space root's RSC payload: the root's is `index.txt`.
        if segments[0].ends_with(".txt") && out_dir.join("index.txt").is_file() {
            return Some("/index.txt".to_string());
        }
        return index_html();
    }
    exported(&sub_path).or_else(index_html)
}

const USAGE: &str = "\
Amiro server

USAGE:
    amiro-backend [--config <amiro.toml>]      start the server
    amiro-backend init-config [<path>]         write a commented amiro.toml
                                               (default: ~/.amiro/amiro.toml)
    amiro-backend reset-password [--login <email-or-username>]
                                               set a new owner password (read
                                               from stdin) and sign out everywhere
    amiro-backend --help

Settings come from the environment, then .env files, then amiro.toml.
See docs/SETUP.md.
";

enum Command {
    Serve,
    InitConfig(Option<PathBuf>),
    ResetPassword(Option<String>),
}

fn parse_args() -> anyhow::Result<(Command, Option<PathBuf>)> {
    let mut args = std::env::args().skip(1);
    let mut config = None;
    let mut command = Command::Serve;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" | "help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "-c" | "--config" => {
                config = Some(PathBuf::from(
                    args.next().ok_or_else(|| anyhow::anyhow!("--config needs a path"))?,
                ));
            }
            "init-config" => command = Command::InitConfig(args.next().map(PathBuf::from)),
            "reset-password" => {
                let mut login = None;
                while let Some(flag) = args.next() {
                    match flag.as_str() {
                        "--login" | "--email" => login = args.next(),
                        other => anyhow::bail!("unknown reset-password option {other}"),
                    }
                }
                command = Command::ResetPassword(login);
            }
            other => anyhow::bail!("unknown argument {other}\n\n{USAGE}"),
        }
    }
    Ok((command, config))
}

/// Reads a password from stdin. Hidden when stdin is a terminal (the echo is
/// switched off with `stty` where available).
fn read_password(prompt: &str) -> anyhow::Result<String> {
    use std::io::{BufRead, IsTerminal, Write};
    let tty = std::io::stdin().is_terminal();
    let hide = |on: bool| {
        if tty && cfg!(unix) {
            let _ = std::process::Command::new("stty")
                .arg(if on { "-echo" } else { "echo" })
                .stdin(std::process::Stdio::inherit())
                .status();
        }
    };
    if tty {
        eprint!("{prompt}");
        std::io::stderr().flush().ok();
    }
    hide(true);
    let mut line = String::new();
    let result = std::io::stdin().lock().read_line(&mut line);
    hide(false);
    if tty {
        eprintln!();
    }
    result?;
    Ok(line.trim_end_matches(['\n', '\r']).to_string())
}

fn main() -> anyhow::Result<()> {
    let (command, config) = parse_args()?;
    // Before any thread exists: this sets process environment variables.
    backend::config::apply(config);

    match command {
        Command::InitConfig(path) => {
            let path = path.unwrap_or_else(|| AppState::from_env().home.join("amiro.toml"));
            if backend::config::write_sample(&path)? {
                println!("wrote {}", path.display());
            } else {
                println!("{} already exists; left it unchanged", path.display());
            }
            return Ok(());
        }
        Command::ResetPassword(login) => {
            let password = read_password("New owner password: ")?;
            let confirm = if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                read_password("Repeat it: ")?
            } else {
                password.clone()
            };
            if password != confirm {
                anyhow::bail!("the passwords do not match");
            }
            let runtime = tokio::runtime::Runtime::new()?;
            let state = AppState::from_env();
            let login = runtime
                .block_on(auth::reset_owner_password(&state, login.as_deref(), &password))
                .map_err(|error| anyhow::anyhow!(error.1))?;
            println!(
                "Password updated for \"{login}\" in {}. Every session was signed out; sign in again.",
                state.home.display()
            );
            return Ok(());
        }
        Command::Serve => {}
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}

async fn serve() -> anyhow::Result<()> {
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

    // Export vault secrets to the runtime's credential-env.json so `${VAR}`
    // placeholders in mcp.json resolve without a runtime restart.
    // The agent MCP token must exist before the first env sync.
    if let Err(error) = backend::agent_mcp::ensure_token(&state) {
        tracing::warn!(%error, "agent MCP token unavailable");
    }
    backend::credentials::sync_runtime_credential_env_logged(&state);
    // Ship the agent's built-in skills (agent-skills/) into the runtime.
    backend::routes::skills::install_bundled_skills(&state);

    // Keep the runtime alive while the app is open and recover it if its daemon
    // exits after the idle timeout, so the first chat after a pause still works.
    backend::runtime::spawn_supervisor(state.clone());

    // The owner's agent home (SOUL/USER/NOW/HEARTBEAT, first-run BOOTSTRAP).
    backend::agent_home::seed(&state).await;
    backend::agent::ensure_owner_identity_file(&state).await;
    backend::schedules::load_last_chat_model(&state).await;
    // Existing installs are already set up; only fresh ones see the wizard.
    backend::onboarding::migrate_existing(&state).await;
    // amiro.toml / .env: agent look and provider keys (needs the owner).
    {
        let state = state.clone();
        tokio::spawn(async move { backend::onboarding::apply_config(&state).await });
    }

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
        .merge(backend::heartbeat::router())
        .merge(backend::onboarding::router())
        .merge(backend::devices::router())
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

    let remote_app = app
        .clone()
        .layer(middleware::from_fn_with_state(
            state.clone(),
            resolve_static_route,
        ))
        .layer(middleware::from_fn(inject_remote_origin))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            remote_device_middleware,
        ))
        .with_state(state.clone());
    let app = app
        .layer(middleware::from_fn_with_state(
            state.clone(),
            resolve_static_route,
        ))
        .layer(middleware::from_fn(inject_backend_origin))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            sidecar_and_origin_middleware,
        ))
        .with_state(state.clone());

    let port: u16 = std::env::var("AMIRO_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let host = std::env::var("AMIRO_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let addr = format!("{host}:{port}");
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !loopback && std::env::var("AMIRO_TOKEN").unwrap_or_default().is_empty() {
        tracing::warn!(
            addr = %addr,
            "bound to a non-loopback address without AMIRO_TOKEN; put TLS and a network boundary in front of Amiro before exposing it"
        );
    }
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    // Register the built-in `amiro` MCP server for the port actually bound.
    if let Ok(bound) = listener.local_addr() {
        let wiring_state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = backend::agent_mcp::wire(&wiring_state, bound.port()).await {
                tracing::warn!(error=%error.1, "could not register the amiro agent MCP server");
            }
        });
    }
    // A process that cannot bind its listener must never start background work.
    backend::devices::load_remote_access(&state).await;
    let remote = spawn_remote_access(remote_app);
    let heartbeat = backend::heartbeat::spawn_heartbeat(state.clone());
    let scheduler = backend::schedules::spawn_scheduler(state);
    tracing::info!(addr=%addr, "listening");
    // Peer addresses feed the device approval screen (backend::devices).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    scheduler.abort();
    heartbeat.abort();
    remote.abort();
    Ok(())
}

/// Run the phone-access listener while the owner has it switched on, and move
/// it when they change the port. Each bind result is reported back so
/// Settings → Devices can say whether it worked.
fn spawn_remote_access(app: Router) -> tokio::task::JoinHandle<()> {
    use backend::devices::{remote_access_config, report_remote_status, RemoteStatus};
    let mut config = remote_access_config();
    tokio::spawn(async move {
        let mut running: Option<(u16, tokio::task::JoinHandle<()>)> = None;
        loop {
            let wanted = config.borrow_and_update().clone();
            let target = wanted.enabled.then_some(wanted.port);
            if running.as_ref().map(|(port, _)| *port) != target {
                if let Some((_, task)) = running.take() {
                    task.abort();
                }
                match target {
                    None => report_remote_status(RemoteStatus::default()),
                    Some(port) => match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                        Ok(listener) => {
                            tracing::info!(port, "phone access listening on the local network");
                            let app = app.clone();
                            running = Some((
                                port,
                                tokio::spawn(async move {
                                    let app = app
                                        .into_make_service_with_connect_info::<std::net::SocketAddr>();
                                    if let Err(error) = axum::serve(listener, app).await {
                                        tracing::warn!(%error, "phone access listener stopped");
                                    }
                                }),
                            ));
                            report_remote_status(RemoteStatus {
                                listening: Some(port),
                                error: None,
                            });
                        }
                        Err(error) => report_remote_status(RemoteStatus {
                            listening: None,
                            error: Some(format!("could not listen on port {port}: {error}")),
                        }),
                    },
                }
            }
            if config.changed().await.is_err() {
                break;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::static_route_target;

    #[test]
    fn agent_scoped_routes_serve_the_bare_routes_export() {
        let out = std::env::temp_dir().join(format!("amiro-static-{}", uuid::Uuid::new_v4()));
        for file in [
            "index.html",
            "index.txt",
            "__next._tree.txt",
            "admin/providers.html",
            "admin/providers.txt",
            "admin/providers/__next._tree.txt",
        ] {
            let path = out.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        let at = |path: &str| static_route_target(&out, path);

        assert_eq!(at("/admin/providers").as_deref(), Some("/admin/providers.html"));
        assert_eq!(at("/admin/providers.txt"), None);
        assert_eq!(at("/amiro/admin/providers").as_deref(), Some("/admin/providers.html"));
        assert_eq!(at("/abc/admin/providers.txt").as_deref(), Some("/admin/providers.txt"));
        assert_eq!(
            at("/amiro/admin/providers/__next._tree.txt").as_deref(),
            Some("/admin/providers/__next._tree.txt")
        );
        assert_eq!(at("/amiro/__next._tree.txt").as_deref(), Some("/__next._tree.txt"));
        assert_eq!(at("/amiro").as_deref(), Some("/index.html"));
        assert_eq!(at("/amiro.txt").as_deref(), Some("/index.txt"));
        assert_eq!(at("/amiro/nowhere").as_deref(), Some("/index.html"));
        assert_eq!(at("/team/x"), None);
        std::fs::remove_dir_all(&out).ok();
    }
}
