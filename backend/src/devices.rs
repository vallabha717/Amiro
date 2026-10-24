//! Paired devices: phones, tablets and other desktop apps that use this Amiro
//! from somewhere else.
//!
//! - **Connecting** is the device code flow GitHub and GitLab use (OAuth 2.0
//!   Device Authorization Grant, RFC 8628). The device asks for a code
//!   (`POST /api/devices/authorize`) and shows the short user code. The owner
//!   approves it, either at `/device` in any signed-in browser or from the
//!   pending requests in Settings → Devices. Meanwhile the device polls
//!   (`POST /api/devices/token`); after approval its next poll receives its own
//!   session token, stored in `sessions.json` with a `deviceId`, so every
//!   existing route authenticates it unchanged. Removing the device deletes
//!   that session. Only hashes of the codes are kept, and the token is minted
//!   when the device collects it, so it is never stored in the request.
//! - **Phone access.** A desktop install listens on loopback only. The owner can
//!   open a second listener on the local network
//!   (`PUT /api/devices/remote-access`); `main.rs` runs it from the
//!   [`remote_access_config`] watch, and it only answers paired devices.
//! - **Device requests skip the sidecar secret.** A device cannot know the
//!   per-launch `AMIRO_TOKEN`, so a request bearing a device session (and the
//!   two public steps of the flow) passes the sidecar check; the session is
//!   then checked by `AuthUser` like any other.

use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};
use axum::{
    extract::{FromRequestParts, Path, Query, State},
    http::{request::Parts, HeaderMap, Method, StatusCode, Uri},
    routing::{delete, get, post, put},
    Json, Router,
};
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::watch;

/// Port the phone-access listener uses unless the owner picks another.
pub const DEFAULT_REMOTE_PORT: u16 = 8790;
/// How long a device has to be approved after asking.
const REQUEST_TTL_SECONDS: i64 = 10 * 60;
/// How often a waiting device may ask whether it was approved.
const POLL_INTERVAL_SECONDS: i64 = 5;
/// Unambiguous characters (no 0/O, 1/I) so a code can be typed from a screen.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 8;
const MAX_DEVICE_NAME: usize = 64;
/// Wrong user codes typed at `/device` before lookups pause.
const LOOKUP_FAILURE_LIMIT: usize = 10;
/// Requests one address may start before it has to wait.
const REQUESTS_PER_ADDRESS: usize = 5;
/// Requests waiting at once, across every address.
const MAX_PENDING_REQUESTS: usize = 50;
const RATE_WINDOW_MS: i64 = 15 * 60 * 1000;

/// What the owner asked the phone-access listener to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteAccess {
    pub enabled: bool,
    pub port: u16,
}

/// What the phone-access listener is actually doing, reported by `main.rs`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteStatus {
    pub listening: Option<u16>,
    pub error: Option<String>,
}

struct Control {
    config: watch::Sender<RemoteAccess>,
    status: watch::Sender<RemoteStatus>,
}

fn control() -> &'static Control {
    static CONTROL: OnceLock<Control> = OnceLock::new();
    CONTROL.get_or_init(|| Control {
        config: watch::channel(RemoteAccess {
            enabled: false,
            port: default_port(),
        })
        .0,
        status: watch::channel(RemoteStatus::default()).0,
    })
}

fn default_port() -> u16 {
    std::env::var("AMIRO_REMOTE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_REMOTE_PORT)
}

/// The owner's phone-access setting; `main.rs` (re)binds the listener on change.
pub fn remote_access_config() -> watch::Receiver<RemoteAccess> {
    control().config.subscribe()
}

/// Called by the listener supervisor after each bind attempt.
pub fn report_remote_status(status: RemoteStatus) {
    control().status.send_replace(status);
}

fn store_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("devices.json")
}

async fn read_store(state: &AppState) -> Result<Value, ApiError> {
    let mut doc = read_json(&store_path(state), json!({})).await?;
    if !doc.is_object() {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid devices store".into(),
        ));
    }
    for key in ["devices", "requests"] {
        if !doc[key].is_array() {
            doc[key] = json!([]);
        }
    }
    // Requests nobody approved in time are simply forgotten.
    if let Some(requests) = doc["requests"].as_array_mut() {
        requests.retain(|request| request["expiresAt"].as_str().is_some_and(|at| !expired(at)));
    }
    Ok(doc)
}

fn remote_from(doc: &Value) -> RemoteAccess {
    RemoteAccess {
        enabled: doc["remoteAccess"]["enabled"].as_bool().unwrap_or(false),
        port: doc["remoteAccess"]["port"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or_else(default_port),
    }
}

/// Start the phone-access listener if the owner left it on. Call once at boot.
pub async fn load_remote_access(state: &AppState) {
    match read_store(state).await {
        Ok(doc) => {
            control().config.send_replace(remote_from(&doc));
        }
        Err(error) => tracing::warn!(error = %error.1, "devices store unreadable; phone access stays off"),
    }
}

/// `true` when the main listener already accepts connections from other
/// machines (a server or VM install), so no separate phone listener is needed.
fn main_listener_reachable() -> bool {
    crate::routes::system::is_remote_bind(&crate::routes::system::bind_host())
}

fn bearer_token(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(token) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim().to_string())
        .filter(|token| !token.is_empty())
    {
        return Some(token);
    }
    // EventSource and WebSocket cannot set headers; they pass the session as
    // `?bearer=` or `?token=` (the same two names `AuthUser` reads).
    uri.query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            ((key == "bearer" || key == "token") && !value.trim().is_empty())
                .then(|| value.trim().to_string())
        })
    })
}

/// `true` when the request carries the session of a paired device.
pub async fn is_device_request(state: &AppState, headers: &HeaderMap, uri: &Uri) -> bool {
    let Some(token) = bearer_token(headers, uri) else {
        return false;
    };
    let Ok(sessions) = read_json(&state.home.join("sessions.json"), json!({"sessions":{}})).await
    else {
        return false;
    };
    sessions["sessions"][&token]["deviceId"].is_string()
}

/// The two steps a device takes before it is connected: asking for a code and
/// collecting its token. Both are public; the device code is the credential.
pub fn is_device_flow(method: &Method, path: &str) -> bool {
    method == Method::POST && matches!(path, "/api/devices/authorize" | "/api/devices/token")
}

/// Whether the sidecar secret check can be skipped for this request: the
/// device flow itself, or any request from a paired device.
pub async fn bypasses_sidecar(
    state: &AppState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    uri: &Uri,
) -> bool {
    is_device_flow(method, path) || is_device_request(state, headers, uri).await
}

/// The address a request came from, for the approval screen and rate limits:
/// the first `X-Forwarded-For` hop when a reverse proxy set one, else the
/// socket's peer. Informational: a client without a proxy can claim any
/// forwarded address, so it is never used to grant anything.
pub struct ClientAddress(pub String);

impl<S: Send + Sync> FromRequestParts<S> for ClientAddress {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let forwarded = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let peer = parts
            .extensions
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|info| info.0.ip().to_string());
        Ok(Self(forwarded.or(peer).unwrap_or_default()))
    }
}

fn require_owner(user: &AuthUser) -> Result<(), ApiError> {
    if user.0["role"] != "admin" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only the owner can manage devices".into(),
        ));
    }
    Ok(())
}

fn hash_code(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}

/// Upper-case and drop separators, so `abcd-efgh` and `ABCDEFGH` match.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn new_user_code() -> String {
    let mut rng = rand::rngs::OsRng;
    (0..CODE_LENGTH)
        .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
        .collect()
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut value);
    hex::encode(value)
}

/// `ABCD-EFGH`, easier to read off a screen.
fn display_code(code: &str) -> String {
    let (left, right) = code.split_at(code.len() / 2);
    format!("{left}-{right}")
}

/// Timestamps of recent events per key, for the small in-memory rate limits.
fn rate_log() -> &'static Mutex<HashMap<String, Vec<i64>>> {
    static LOG: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `true` while `key` has had fewer than `limit` events in the window.
fn under_limit(key: &str, limit: usize, now_ms: i64) -> bool {
    let Ok(mut log) = rate_log().lock() else {
        return false;
    };
    let events = log.entry(key.to_string()).or_default();
    events.retain(|at| now_ms - at < RATE_WINDOW_MS);
    events.len() < limit
}

fn record_event(key: &str, now_ms: i64) {
    if let Ok(mut log) = rate_log().lock() {
        log.entry(key.to_string()).or_default().push(now_ms);
    }
}

/// A square QR code for `text` as an SVG document (dark modules on white, with
/// the quiet zone the spec requires so phone cameras find it).
fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    let width = code.width();
    let quiet = 4;
    let size = width + quiet * 2;
    let mut path = String::new();
    for (index, color) in code.to_colors().into_iter().enumerate() {
        if color == qrcode::Color::Dark {
            let (x, y) = (index % width + quiet, index / width + quiet);
            path.push_str(&format!("M{x} {y}h1v1h-1z"));
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><rect width=\"{size}\" height=\"{size}\" fill=\"#fff\"/><path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

/// Addresses another device can reach this Amiro at, best first.
fn reachable_urls(origin: Option<&str>) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut push = |url: String| {
        if !urls.contains(&url) {
            urls.push(url);
        }
    };
    // The address the owner is using right now, when it is a real network
    // address (a cloud server's https name). Loopback and the desktop webview
    // origins are useless to another device.
    if let Some(origin) = origin.and_then(|origin| url::Url::parse(origin).ok()) {
        let loopback = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            || origin.host_str() == Some("tauri.localhost");
        if matches!(origin.scheme(), "http" | "https") && !loopback {
            push(origin.origin().ascii_serialization());
        }
    }
    let status = control().status.borrow().clone();
    let port = if main_listener_reachable() {
        Some(crate::routes::system::bind_port())
    } else {
        status.listening
    };
    if let Some(port) = port {
        for ip in crate::routes::system::lan_ipv4_addresses() {
            push(format!("http://{ip}:{port}"));
        }
    }
    urls
}

fn remote_overview(doc: &Value) -> Value {
    let wanted = remote_from(doc);
    let status = control().status.borrow().clone();
    json!({
        // A server install is reachable already; only a loopback install
        // (the desktop app) needs the separate phone listener.
        "needed": !main_listener_reachable(),
        "enabled": wanted.enabled,
        "port": wanted.port,
        "listening": status.listening.is_some(),
        "error": status.error,
        "urls": reachable_urls(None),
    })
}

/// Paired devices that still hold a session. A device that signed itself out
/// has no session left and is not shown.
async fn live_devices(state: &AppState, doc: &Value) -> Result<Vec<Value>, ApiError> {
    let sessions = read_json(&state.home.join("sessions.json"), json!({"sessions":{}})).await?;
    let live: std::collections::HashSet<&str> = sessions["sessions"]
        .as_object()
        .map(|map| {
            map.values()
                .filter_map(|session| session["deviceId"].as_str())
                .collect()
        })
        .unwrap_or_default();
    Ok(doc["devices"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|device| device["id"].as_str().is_some_and(|id| live.contains(id)))
        .cloned()
        .collect())
}

fn expired(at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|at| at < chrono::Utc::now())
        .unwrap_or(true)
}

/// What the owner sees about a request: never its device code hash.
fn public_request(request: &Value) -> Value {
    json!({
        "id": request["id"],
        "userCode": request["userCode"],
        "name": request["name"],
        "platform": request["platform"],
        "address": request["address"],
        "status": request["status"],
        "createdAt": request["createdAt"],
        "expiresAt": request["expiresAt"],
    })
}

fn pending_requests(doc: &Value) -> Vec<Value> {
    doc["requests"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|request| request["status"] == "pending")
        .map(public_request)
        .collect()
}

async fn overview(state: &AppState, doc: &Value, origin: Option<&str>) -> Result<Value, ApiError> {
    let links: Vec<Value> = reachable_urls(origin)
        .into_iter()
        .map(|url| {
            let link = format!("{url}/pair");
            json!({ "url": url, "link": link, "qrSvg": qr_svg(&link) })
        })
        .collect();
    Ok(json!({
        "devices": live_devices(state, doc).await?,
        "requests": pending_requests(doc),
        "remoteAccess": remote_overview(doc),
        "links": links,
    }))
}

#[derive(serde::Deserialize, Default)]
struct OverviewQuery {
    origin: Option<String>,
}

/// `?origin=` is the address the Settings page was opened at, so a cloud
/// server's own https name is offered first.
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<OverviewQuery>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let doc = read_store(&state).await?;
    Ok(Json(overview(&state, &doc, query.origin.as_deref()).await?))
}

fn clean_name(value: Option<&str>) -> String {
    let name: String = value
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "Device".into()
    } else {
        name.to_string()
    }
}

fn clean_platform(value: Option<&str>) -> &'static str {
    match value.unwrap_or("") {
        "ios" => "ios",
        "android" => "android",
        "desktop" => "desktop",
        _ => "web",
    }
}

/// Step 1 (device, public): ask to connect. Answers the secret device code the
/// device keeps and the short user code it shows to the owner.
async fn authorize(
    State(state): State<AppState>,
    ClientAddress(address): ClientAddress,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let rate_key = format!("authorize:{address}");
    if !under_limit(&rate_key, REQUESTS_PER_ADDRESS, now_ms) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many connection requests from this address; try again in 15 minutes".into(),
        ));
    }
    let device_code = random_hex(32);
    let user_code = new_user_code();
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(REQUEST_TTL_SECONDS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    {
        let _guard = state.store.lock().await;
        let mut doc = read_store(&state).await?;
        let requests = doc["requests"].as_array_mut().expect("normalized by read_store");
        if requests.len() >= MAX_PENDING_REQUESTS {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "too many devices are waiting for approval; try again in a few minutes".into(),
            ));
        }
        requests.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "deviceCodeHash": hash_code(&device_code),
            "userCode": display_code(&user_code),
            "name": clean_name(body["name"].as_str()),
            "platform": clean_platform(body["platform"].as_str()),
            "address": address,
            "status": "pending",
            "createdAt": now_iso(),
            "expiresAt": expires_at,
        }));
        write_json(&store_path(&state), &doc).await?;
    }
    record_event(&rate_key, now_ms);
    Ok(Json(json!({
        "deviceCode": device_code,
        "userCode": display_code(&user_code),
        // Relative: the device knows the address it used to reach this Amiro.
        "verificationPath": "/device",
        "verificationPathComplete": format!("/device?code={}", display_code(&user_code)),
        "expiresIn": REQUEST_TTL_SECONDS,
        "interval": POLL_INTERVAL_SECONDS,
    })))
}

/// An RFC 8628 polling answer that is not a token yet. `error` is the bare
/// code (`authorization_pending`, `slow_down`, `expired_token`,
/// `access_denied`, `invalid_request`), as the RFC has it; clients word it.
fn poll_error(code: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, code.into())
}

/// Step 3 (device, public): has the owner approved? Answers the device's own
/// session once, then forgets the request.
async fn token(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let device_code = body["deviceCode"].as_str().unwrap_or("").trim();
    if device_code.is_empty() {
        return Err(poll_error("invalid_request"));
    }
    let hash = hash_code(device_code);
    let _guard = state.store.lock().await;
    let mut doc = read_store(&state).await?;
    let requests = doc["requests"].as_array_mut().expect("normalized by read_store");
    let Some(index) = requests
        .iter()
        .position(|request| request["deviceCodeHash"] == hash.as_str())
    else {
        return Err(poll_error("expired_token"));
    };
    match requests[index]["status"].as_str() {
        Some("approved") => {}
        Some("denied") => {
            requests.remove(index);
            write_json(&store_path(&state), &doc).await?;
            return Err(poll_error("access_denied"));
        }
        _ => {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let last = requests[index]["lastPollMs"].as_i64().unwrap_or(0);
            // A little slack so a client polling exactly on the interval is fine.
            let too_soon = now_ms - last < POLL_INTERVAL_SECONDS * 1000 - 500;
            requests[index]["lastPollMs"] = json!(now_ms);
            write_json(&store_path(&state), &doc).await?;
            return Err(if too_soon {
                poll_error("slow_down")
            } else {
                poll_error("authorization_pending")
            });
        }
    }

    let request = requests.remove(index);
    let user_id = request["approvedBy"].as_str().unwrap_or_default().to_string();
    let users = read_json(&state.home.join("users.json"), json!({"users":[]})).await?;
    let user = users["users"]
        .as_array()
        .and_then(|users| users.iter().find(|user| user["id"] == user_id.as_str()))
        .cloned()
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "the account that approved this device no longer exists".into(),
            )
        })?;
    let device = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": request["name"],
        "platform": request["platform"],
        "address": request["address"],
        "createdAt": now_iso(),
    });
    let token = random_hex(32);
    let sessions_file = state.home.join("sessions.json");
    let mut sessions = read_json(&sessions_file, json!({"sessions":{}})).await?;
    if !sessions["sessions"].is_object() {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid sessions database".into(),
        ));
    }
    sessions["sessions"][&token] = json!({
        "userId": user_id,
        "createdAt": now_iso(),
        "deviceId": device["id"],
    });
    write_json(&sessions_file, &sessions).await?;
    if let Some(devices) = doc["devices"].as_array_mut() {
        devices.push(device.clone());
    }
    write_json(&store_path(&state), &doc).await?;
    Ok(Json(json!({
        "token": token,
        "user": crate::auth::public_user(&user),
        "device": device,
    })))
}

#[derive(serde::Deserialize)]
struct LookupQuery {
    code: String,
}

/// Step 2a (owner, at `/device`): what is asking with this code? Wrong codes
/// are limited, so the page cannot be used to guess pending requests.
async fn lookup(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<LookupQuery>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    if !under_limit("lookup", LOOKUP_FAILURE_LIMIT, now_ms) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many wrong codes; try again in 15 minutes".into(),
        ));
    }
    let code = normalize_code(&query.code);
    let doc = read_store(&state).await?;
    let found = doc["requests"]
        .as_array()
        .and_then(|requests| {
            requests.iter().find(|request| {
                request["status"] == "pending"
                    && request["userCode"].as_str().map(normalize_code).as_deref() == Some(code.as_str())
            })
        })
        .map(public_request);
    match found {
        Some(request) => Ok(Json(request)),
        None => {
            record_event("lookup", now_ms);
            Err(ApiError(
                StatusCode::NOT_FOUND,
                "no device is waiting with that code; check it, or start again on the device".into(),
            ))
        }
    }
}

/// Step 2b (owner): approve or deny a waiting device.
async fn decide(state: &AppState, user: &AuthUser, id: &str, approve: bool) -> Result<Value, ApiError> {
    require_owner(user)?;
    let owner = user.0["id"].as_str().unwrap_or_default().to_string();
    let _guard = state.store.lock().await;
    let mut doc = read_store(state).await?;
    let request = doc["requests"]
        .as_array_mut()
        .and_then(|requests| {
            requests
                .iter_mut()
                .find(|request| request["id"] == id && request["status"] == "pending")
        })
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "that request expired or was already answered".into(),
            )
        })?;
    if approve {
        request["status"] = json!("approved");
        request["approvedBy"] = json!(owner);
    } else {
        request["status"] = json!("denied");
    }
    request["decidedAt"] = json!(now_iso());
    let answered = public_request(request);
    write_json(&store_path(state), &doc).await?;
    Ok(answered)
}

async fn approve(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(decide(&state, &user, &id, true).await?))
}

async fn deny(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(decide(&state, &user, &id, false).await?))
}

/// Unpair a device: its session stops working at once.
async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let _guard = state.store.lock().await;
    let mut doc = read_store(&state).await?;
    let before = doc["devices"].as_array().map_or(0, Vec::len);
    if let Some(devices) = doc["devices"].as_array_mut() {
        devices.retain(|device| device["id"] != id.as_str());
    }
    if doc["devices"].as_array().map_or(0, Vec::len) == before {
        return Err(ApiError(StatusCode::NOT_FOUND, "device not found".into()));
    }
    let sessions_file = state.home.join("sessions.json");
    let mut sessions = read_json(&sessions_file, json!({"sessions":{}})).await?;
    if let Some(map) = sessions["sessions"].as_object_mut() {
        map.retain(|_, session| session["deviceId"] != id.as_str());
    }
    write_json(&sessions_file, &sessions).await?;
    write_json(&store_path(&state), &doc).await?;
    drop(_guard);
    Ok(Json(overview(&state, &doc, None).await?))
}

/// Turn the phone-access listener on or off, or move it to another port.
async fn set_remote_access(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let enabled = body["enabled"].as_bool().ok_or_else(|| {
        ApiError(StatusCode::BAD_REQUEST, "enabled must be true or false".into())
    })?;
    let port = match body.get("port").filter(|port| !port.is_null()) {
        None => None,
        Some(port) => Some(
            port.as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port >= 1024)
                .ok_or_else(|| {
                    ApiError(
                        StatusCode::BAD_REQUEST,
                        "port must be a number from 1024 to 65535".into(),
                    )
                })?,
        ),
    };
    let doc = {
        let _guard = state.store.lock().await;
        let mut doc = read_store(&state).await?;
        let port = port.unwrap_or_else(|| remote_from(&doc).port);
        doc["remoteAccess"] = json!({ "enabled": enabled, "port": port });
        write_json(&store_path(&state), &doc).await?;
        doc
    };
    let wanted = remote_from(&doc);
    let mut status = control().status.subscribe();
    control().config.send_replace(wanted.clone());
    // Give the supervisor a moment to bind, so the answer says whether it worked.
    let settled = |status: &RemoteStatus| {
        if wanted.enabled {
            status.listening == Some(wanted.port) || status.error.is_some()
        } else {
            status.listening.is_none()
        }
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !settled(&status.borrow_and_update()) {
            if status.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
    Ok(Json(overview(&state, &doc, None).await?))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/devices", get(list))
        .route("/api/devices/authorize", post(authorize))
        .route("/api/devices/token", post(token))
        .route("/api/devices/requests/lookup", get(lookup))
        .route("/api/devices/requests/{id}/approve", post(approve))
        .route("/api/devices/requests/{id}/deny", post(deny))
        .route("/api/devices/remote-access", put(set_remote_access))
        .route("/api/devices/{id}", delete(revoke))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_typeable_and_normalize() {
        let code = new_user_code();
        assert_eq!(code.len(), CODE_LENGTH);
        assert!(code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        let shown = display_code(&code);
        assert_eq!(shown.len(), CODE_LENGTH + 1);
        assert_eq!(normalize_code(&shown.to_lowercase()), code);
    }

    #[test]
    fn qr_svg_is_a_square_svg() {
        let svg = qr_svg("http://192.168.1.5:8790/pair").unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("fill=\"#000\""));
    }

    #[test]
    fn loopback_and_webview_origins_are_not_offered_to_other_devices() {
        for origin in ["http://localhost:3000", "http://127.0.0.1:8787", "tauri://localhost", "http://tauri.localhost"] {
            assert!(!reachable_urls(Some(origin)).contains(&origin.to_string()), "{origin}");
        }
        assert_eq!(
            reachable_urls(Some("https://amiro.example.com/admin/devices")).first().map(String::as_str),
            Some("https://amiro.example.com")
        );
    }

    #[test]
    fn device_names_are_trimmed_and_bounded() {
        assert_eq!(clean_name(None), "Device");
        assert_eq!(clean_name(Some("  Pixel\n 9 ")), "Pixel 9");
        assert_eq!(clean_name(Some(&"x".repeat(200))).len(), MAX_DEVICE_NAME);
        assert_eq!(clean_platform(Some("ios")), "ios");
        assert_eq!(clean_platform(Some("symbian")), "web");
    }

    #[test]
    fn rate_limits_count_per_key() {
        let now = chrono::Utc::now().timestamp_millis();
        let key = format!("test:{}", uuid::Uuid::new_v4());
        for _ in 0..3 {
            assert!(under_limit(&key, 3, now));
            record_event(&key, now);
        }
        assert!(!under_limit(&key, 3, now));
        assert!(under_limit(&key, 3, now + RATE_WINDOW_MS + 1), "the window slides");
    }
}
