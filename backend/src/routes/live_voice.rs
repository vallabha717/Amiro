//! Live voice mode: server side of `src/lib/voice/protocol.ts`.
//!
//! One WebSocket per session. The browser captures the mic and plays audio;
//! this module does energy VAD, turn detection, barge-in, ElevenLabs Scribe
//! STT, sentence chunking / markdown sanitising and ElevenLabs streaming TTS.
//! VAD and the segmenter are ports of Vellum's `speech-energy`,
//! `room-noise-floor`, `speakable-segments` and `tts-text-sanitizer`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::task::{JoinHandle, JoinSet};

use super::voice::{load_settings, multipart_body, non_empty, resolve_key, resolve_saved_string, Part};
use crate::state::{ApiError, AppState, AuthUser};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER: &str = "elevenlabs";
pub const DEFAULT_VOICE_ID: &str = "EXAVITQu4vr4xnSDxMaL";
pub const TTS_MODEL: &str = "eleven_flash_v2_5";
pub const STT_MODEL: &str = "scribe_v1";
pub const TTS_SAMPLE_RATE: u32 = 24_000;
const INPUT_SAMPLE_RATE: u32 = 16_000;

const TICKET_TTL: Duration = Duration::from_secs(60);

const FRAME_SAMPLES: usize = 800;
const FRAME_MS: u32 = 50;
const BASE_THRESHOLD: f32 = 800.0;
const MAX_THRESHOLD: f32 = 3200.0;
const ONSET_MS: u32 = 150;
const PREROLL_FRAMES: usize = 25;
const MIN_VOICED_MS: u32 = 300;
const MAX_UTTERANCE_MS: u32 = 30_000;
const TAIL_SILENCE_FRAMES: u32 = 6;
const MANUAL_MAX_FRAMES: usize = 600;
const NOISE_BLOCK_MS: f32 = 1000.0;
const NOISE_BLOCK_COUNT: usize = 10;
/// EMA weight per 50 ms frame for a ~400 ms half-life.
const ECHO_ALPHA: f32 = 0.0830;

const MAX_OPEN_JOBS: usize = 2;
const TTS_CHUNK_MIN: usize = 4800;
const TTS_CHUNK_MAX: usize = 9600;
const TTS_TIMEOUT: Duration = Duration::from_secs(45);
const STT_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct TicketStore {
    map: HashMap<String, (String, Instant)>,
}

impl TicketStore {
    pub fn issue_at(&mut self, user_id: &str, now: Instant) -> String {
        self.map.retain(|_, (_, at)| now.duration_since(*at) < TICKET_TTL);
        let mut bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut bytes);
        let ticket = hex::encode(bytes);
        self.map.insert(ticket.clone(), (user_id.to_string(), now));
        ticket
    }

    /// One-time use: returns the owning user id and removes the ticket.
    pub fn consume_at(&mut self, ticket: &str, now: Instant) -> Option<String> {
        let (user, at) = self.map.remove(ticket)?;
        (now.saturating_duration_since(at) < TICKET_TTL).then_some(user)
    }
}

static TICKETS: LazyLock<Mutex<TicketStore>> = LazyLock::new(|| Mutex::new(TicketStore::default()));

fn user_id(user: &AuthUser) -> String {
    user.0.get("id").and_then(Value::as_str).unwrap_or("").to_string()
}

async fn issue_ticket(user: AuthUser) -> Json<Value> {
    let ticket = TICKETS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .issue_at(&user_id(&user), Instant::now());
    Json(json!({"ticket": ticket, "expiresInMs": TICKET_TTL.as_millis() as u64}))
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async fn preflight(State(state): State<AppState>, _user: AuthUser) -> Result<Json<Value>, ApiError> {
    let settings = load_settings(&state).await?;
    let stt = resolve_key(&state, "stt", PROVIDER, None).await?.is_some();
    let tts = resolve_key(&state, "tts", PROVIDER, None).await?.is_some();
    let voice = voice_from_settings(&settings);
    let mut out = json!({
        "ready": stt && tts,
        "stt": {"provider": PROVIDER, "configured": stt, "model": STT_MODEL},
        "tts": {"provider": PROVIDER, "configured": tts, "model": TTS_MODEL, "voiceId": voice},
    });
    if !(stt && tts) {
        out["message"] = json!(
            "Live voice needs an ElevenLabs API key (used for both speech-to-text and text-to-speech). Add it in Settings > Voice."
        );
    }
    Ok(Json(out))
}

fn voice_from_settings(settings: &Value) -> String {
    resolve_saved_string(settings, "ttsProviders", PROVIDER, "voiceId", DEFAULT_VOICE_ID)
}

fn language_from_settings(settings: &Value) -> Option<String> {
    non_empty(settings, "sttLanguage")
        .filter(|l| !l.eq_ignore_ascii_case("multi"))
        .map(str::to_string)
}

fn valid_voice_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/live-voice/ticket", post(issue_ticket))
        .route("/api/live-voice/preflight", get(preflight))
        .route("/api/live-voice", get(ws_upgrade))
}

// ---------------------------------------------------------------------------
// WAV + HTTP helpers
// ---------------------------------------------------------------------------

/// Wrap PCM16 LE mono samples in a 44-byte WAV header.
pub fn pcm16_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

fn http() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    &CLIENT
}

#[derive(Debug, Clone)]
pub struct UpstreamError {
    pub status: Option<u16>,
    pub message: String,
}

impl UpstreamError {
    fn describe(&self, what: &str) -> String {
        let label = if what.is_empty() { String::new() } else { format!("{what} ") };
        match self.status {
            Some(s) => format!("ElevenLabs {label}{s}: {}", self.message),
            None => format!("ElevenLabs {label}request failed: {}", self.message),
        }
    }
}

/// Best-effort short message from an ElevenLabs error body.
fn upstream_message(body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let msg = parsed.as_ref().and_then(|v| {
        let detail = v.get("detail")?;
        detail
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| detail.as_str())
            .map(str::to_string)
            .or_else(|| v.get("message").and_then(Value::as_str).map(str::to_string))
    });
    msg.unwrap_or_else(|| body.trim().to_string()).chars().take(240).collect()
}

fn net_error(e: reqwest::Error, key: &str) -> UpstreamError {
    let mut message = e.without_url().to_string();
    if !key.is_empty() {
        message = message.replace(key, "[REDACTED]");
    }
    UpstreamError { status: None, message }
}

async fn response_error(resp: reqwest::Response, key: &str) -> UpstreamError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let mut message = upstream_message(&body);
    if !key.is_empty() {
        message = message.replace(key, "[REDACTED]");
    }
    UpstreamError { status: Some(status), message }
}

/// Transcribe a WAV with ElevenLabs Scribe. Returns the raw transcript text.
pub async fn transcribe(key: &str, wav: &[u8], language: Option<&str>) -> Result<String, UpstreamError> {
    let boundary = format!("----amiro{}", uuid::Uuid::new_v4().simple());
    let mut parts = vec![Part {
        name: "model_id",
        filename: None,
        content_type: None,
        data: STT_MODEL.as_bytes(),
    }];
    if let Some(lang) = language {
        parts.push(Part { name: "language_code", filename: None, content_type: None, data: lang.as_bytes() });
    }
    parts.push(Part { name: "file", filename: Some("audio.wav"), content_type: Some("audio/wav"), data: wav });
    let body = multipart_body(&boundary, &parts);
    let resp = http()
        .post("https://api.elevenlabs.io/v1/speech-to-text")
        .header("xi-api-key", key)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .timeout(STT_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(|e| net_error(e, key))?;
    if !resp.status().is_success() {
        return Err(response_error(resp, key).await);
    }
    let value: Value = resp.json().await.map_err(|e| net_error(e, key))?;
    Ok(value.get("text").and_then(Value::as_str).unwrap_or("").to_string())
}

/// Drop sound-event annotations such as "(background noise)" or "[music]".
pub fn clean_transcript(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let close = match chars[i] {
            '(' => Some(')'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            if let Some(off) = chars[i + 1..].iter().take(60).position(|c| *c == close) {
                let inner = &chars[i + 1..i + 1 + off];
                if !inner.iter().any(|c| matches!(c, '(' | '[')) {
                    i += off + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().any(|c| c.is_alphanumeric()) {
        collapsed
    } else {
        String::new()
    }
}

/// Stream TTS as PCM16 24 kHz. `sink` receives even-length chunks of ~100-200 ms.
pub async fn tts_stream(
    key: &str,
    voice_id: &str,
    text: &str,
    sink: &mut (dyn FnMut(Vec<u8>) + Send),
) -> Result<(), UpstreamError> {
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_{TTS_SAMPLE_RATE}"
    );
    let body = json!({
        "text": text,
        "model_id": TTS_MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "speed": 1.0},
    });
    let mut resp = http()
        .post(url)
        .header("xi-api-key", key)
        .timeout(TTS_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|e| net_error(e, key))?;
    if !resp.status().is_success() {
        return Err(response_error(resp, key).await);
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| net_error(e, key))? {
        buf.extend_from_slice(&chunk);
        while buf.len() >= TTS_CHUNK_MIN {
            let take = buf.len().min(TTS_CHUNK_MAX) & !1;
            sink(buf.drain(..take).collect());
        }
    }
    let even = buf.len() & !1;
    if even > 0 {
        sink(buf[..even].to_vec());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Speakable segments (port of tts/speakable-segments.ts)
// ---------------------------------------------------------------------------

const DEFAULT_CHAR_THRESHOLD: usize = 180;
const EAGER_CHAR_THRESHOLD: usize = 60;
const EAGER_MIN_CLAUSE_PREFIX: usize = 24;

fn non_latin_ender(c: char) -> bool {
    matches!(c, '。' | '｡' | '！' | '？' | '．' | '।' | '॥' | '؟' | '۔')
}
fn ascii_ender(c: char) -> bool {
    matches!(c, '.' | '!' | '?')
}
fn ascii_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | ')' | ']')
}
fn non_latin_closer(c: char) -> bool {
    ascii_closer(c)
        || matches!(
            c,
            '」' | '｣' | '』' | '）' | '】' | '〕' | '〙' | '〗' | '〛' | '》' | '〉' | '］' | '｝' | '”' | '’' | '»'
        )
}
fn non_latin_clause(c: char) -> bool {
    matches!(c, '、' | '､' | '，' | '；' | '،')
}
fn clause_punct(c: char) -> bool {
    matches!(c, ',' | ';' | ':') || non_latin_clause(c)
}
fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || c == '_')
}
fn is_digit(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
}
fn is_ascii_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}
fn is_ws(c: Option<char>) -> bool {
    c.is_some_and(char::is_whitespace)
}

fn last_ws_boundary(t: &[char], max: usize) -> Option<usize> {
    let mut idx = max;
    while idx > max * 3 / 5 {
        if is_ws(t.get(idx).copied()) {
            return Some(idx + 1);
        }
        idx -= 1;
    }
    None
}

fn fullwidth_grouping_comma(t: &[char], i: usize) -> bool {
    t[i] == '，' && i > 0 && is_digit(Some(t[i - 1])) && (t.get(i + 1).is_none() || is_digit(t.get(i + 1).copied()))
}

/// Index (in chars) one past the first speakable boundary, if any.
fn find_boundary(t: &[char], threshold: usize, eager: bool) -> Option<usize> {
    let n = t.len();
    let (mut bt, mut bold, mut ital, mut und, mut skip) = (false, false, false, false, false);
    let mut url_depth = 0usize;
    let mut in_label = false;
    let mut suppressed: Option<usize> = None;
    let mut i = 0;
    while i < n {
        let ch = t[i];
        let next = t.get(i + 1).copied();
        let prev = if i > 0 { Some(t[i - 1]) } else { None };
        let in_span = bt || bold || ital || und;

        if ch == '\n' {
            url_depth = 0;
            in_label = false;
            if let Some(b) = suppressed {
                return Some(b);
            }
            if !in_span {
                return Some(i + 1);
            }
        }
        if url_depth > 0 {
            if ch == '(' {
                url_depth += 1;
            } else if ch == ')' {
                url_depth -= 1;
            }
            i += 1;
            continue;
        }
        if ch == ']' && in_label && next != Some('(') {
            if i + 1 == n {
                break;
            }
            in_label = false;
            if let Some(b) = suppressed {
                return Some(b);
            }
        }
        if ch == ']' && next == Some('(') {
            in_label = false;
            suppressed = None;
            url_depth = 1;
            i += 2;
            continue;
        }
        if ch == '[' && !in_label && !in_span {
            in_label = true;
        }

        if !in_span
            && eager
            && clause_punct(ch)
            && i >= EAGER_MIN_CLAUSE_PREFIX
            && (non_latin_clause(ch) || is_ws(next))
            && !fullwidth_grouping_comma(t, i)
        {
            if in_label {
                suppressed.get_or_insert(i + 1);
            } else {
                return Some(i + 1);
            }
        }

        if !in_span && (ascii_ender(ch) || non_latin_ender(ch)) {
            let nl = non_latin_ender(ch);
            let ambiguous = ch == '．' && (is_digit(next) || (is_ascii_word(prev) && is_ascii_word(next)));
            if nl && !ambiguous {
                let mut b = i + 1;
                while b < n && (non_latin_ender(t[b]) || non_latin_closer(t[b])) {
                    b += 1;
                }
                if b < n {
                    if in_label {
                        suppressed.get_or_insert(b);
                    } else {
                        return Some(b);
                    }
                }
            }
            if !nl {
                let mut b = i + 1;
                while b < n && ascii_closer(t[b]) {
                    b += 1;
                }
                if b == n || t[b].is_whitespace() {
                    if in_label {
                        suppressed.get_or_insert(b);
                    } else {
                        return Some(b);
                    }
                }
            }
        }

        if skip {
            skip = false;
        } else if ch == '`' {
            bt = !bt;
        } else if ch == '*' {
            if next == Some('*') {
                bold = !bold;
                skip = true;
            } else if ital {
                if prev.is_some_and(|p| !p.is_whitespace()) && !is_word(next) {
                    ital = false;
                }
            } else if !is_word(prev) && next.is_some_and(|x| !x.is_whitespace()) {
                ital = true;
            }
        } else if ch == '_' {
            if und {
                if prev.is_some_and(|p| !p.is_whitespace()) && !is_word(next) {
                    und = false;
                }
            } else if !is_word(prev) && next.is_some_and(|x| !x.is_whitespace()) {
                und = true;
            }
        }
        i += 1;
    }

    if n < threshold {
        return None;
    }
    if let Some(b) = suppressed {
        return Some(b);
    }
    if let Some(b) = last_ws_boundary(t, threshold) {
        return Some(b);
    }
    Some(threshold)
}

/// Split a growing buffer into complete speakable segments plus a remainder.
pub fn extract_speakable_segments(text: &str, force: bool, eager: bool) -> (Vec<String>, String) {
    let chars: Vec<char> = text.chars().collect();
    let mut eager = eager;
    let mut segments = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let threshold = if eager { EAGER_CHAR_THRESHOLD } else { DEFAULT_CHAR_THRESHOLD };
        let Some(b) = find_boundary(&chars[start..], threshold, eager) else { break };
        let seg: String = chars[start..start + b].iter().collect();
        let seg = seg.trim();
        if !seg.is_empty() {
            segments.push(seg.to_string());
            eager = false;
        }
        start += b;
    }
    let mut remainder: String = chars[start..].iter().collect();
    if force {
        let seg = remainder.trim();
        if !seg.is_empty() {
            segments.push(seg.to_string());
        }
        remainder.clear();
    }
    (segments, remainder)
}

// ---------------------------------------------------------------------------
// TTS text sanitizer (port of calls/tts-text-sanitizer.ts, regex-free)
// ---------------------------------------------------------------------------

fn match_link(c: &[char], open: usize) -> Option<(usize, usize, usize)> {
    // returns (label_start, label_end, link_end)
    let mut j = open + 1;
    while j < c.len() && c[j] != ']' {
        j += 1;
    }
    if j >= c.len() || j == open + 1 || c.get(j + 1) != Some(&'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut k = j + 1;
    while k < c.len() {
        match c[k] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((open + 1, j, k + 1));
                }
            }
            _ => {}
        }
        k += 1;
    }
    None
}

fn strip_links(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '[' {
            if let Some((ls, le, end)) = match_link(&c, i) {
                if out.ends_with('!') {
                    out.pop(); // image: drop entirely
                } else {
                    out.extend(&c[ls..le]);
                }
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn strip_paired(s: &str, d: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(d) {
        let after = &rest[i + d.len()..];
        match after.find(d) {
            Some(j) if j > 0 && !after[..j].contains('\n') => {
                out.push_str(&rest[..i]);
                out.push_str(&after[..j]);
                rest = &after[j + d.len()..];
            }
            _ => {
                out.push_str(&rest[..i + d.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_single(s: &str, m: char) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == m {
            let prev = if i > 0 { Some(c[i - 1]) } else { None };
            let next = c.get(i + 1).copied();
            if !is_word(prev) && next.is_some_and(|x| !x.is_whitespace() && x != m) {
                if let Some(off) = c[i + 1..].iter().position(|x| *x == m) {
                    let j = i + 1 + off;
                    if !c[j - 1].is_whitespace() && !is_word(c.get(j + 1).copied()) {
                        out.extend(&c[i + 1..j]);
                        i = j + 1;
                        continue;
                    }
                }
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn strip_line_markers(s: &str) -> String {
    s.split('\n')
        .map(|line| {
            let hashes = line.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hashes) && line[hashes..].starts_with(char::is_whitespace) {
                return line[hashes..].trim_start().to_string();
            }
            let t = line.trim_start();
            if (t.starts_with('-') || t.starts_with('*')) && t[1..].starts_with([' ', '\t']) {
                return t[1..].trim_start().to_string();
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_urls(s: &str) -> String {
    let mut out = String::new();
    let mut first = true;
    for tok in s.split_inclusive(char::is_whitespace) {
        let _ = first;
        first = false;
        let word = tok.trim_end();
        let ws = &tok[word.len()..];
        let lower = word.to_ascii_lowercase();
        let core = word.trim_start_matches(['(', '<', '"', '\'']);
        let lead = &word[..word.len() - core.len()];
        let lower_core = lower.trim_start_matches(['(', '<', '"', '\'']);
        if lower_core.starts_with("http://") || lower_core.starts_with("https://") || lower_core.starts_with("www.") {
            let trimmed = core.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '>', '"', '\'']);
            let tail = &core[trimmed.len()..];
            out.push_str(lead);
            out.push_str(tail);
            out.push_str(ws);
        } else {
            out.push_str(tok);
        }
    }
    out
}

fn is_emoji(c: char) -> bool {
    let u = c as u32;
    matches!(u,
        0x200D | 0xFE00..=0xFE0F | 0x1F3FB..=0x1F3FF | 0x1F1E6..=0x1F1FF
        | 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF
        | 0x00A9 | 0x00AE | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x3030 | 0x303D | 0x3297 | 0x3299)
}

/// Strip markdown, URLs and emoji so the text reads naturally aloud.
pub fn sanitize_for_tts(text: &str) -> String {
    let mut r = strip_links(text);
    for d in ["***", "___", "**", "__"] {
        r = strip_paired(&r, d);
    }
    r = strip_line_markers(&r);
    r = r.replace('`', "");
    r = strip_single(&r, '*');
    r = strip_single(&r, '_');
    r = strip_urls(&r);
    r = r.chars().filter(|c| !is_emoji(*c)).collect();
    r.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Drops fenced code across segment boundaries; announces it once per turn.
#[derive(Default)]
struct FenceFilter {
    in_fence: bool,
    announced: bool,
}

impl FenceFilter {
    fn filter(&mut self, seg: &str) -> String {
        let mut out = String::new();
        for (k, part) in seg.split("```").enumerate() {
            if k > 0 {
                self.in_fence = !self.in_fence;
                if self.in_fence && !self.announced {
                    self.announced = true;
                    out.push_str(" I've put the code in the chat. ");
                }
            }
            if !self.in_fence {
                out.push_str(part);
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// VAD (port of speech-energy.ts + room-noise-floor.ts)
// ---------------------------------------------------------------------------

pub fn mean_abs(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.iter().map(|s| (*s as i32).unsigned_abs() as f32).sum::<f32>() / samples.len() as f32
}

#[derive(Default)]
struct NoiseFloor {
    blocks: VecDeque<f32>,
    sum: f32,
    ms: f32,
}

impl NoiseFloor {
    fn observe(&mut self, mean: f32, ms: f32) {
        self.sum += mean * ms;
        self.ms += ms;
        if self.ms < NOISE_BLOCK_MS {
            return;
        }
        self.blocks.push_back(self.sum / self.ms);
        if self.blocks.len() > NOISE_BLOCK_COUNT {
            self.blocks.pop_front();
        }
        self.sum = 0.0;
        self.ms = 0.0;
    }
    fn interrupt(&mut self) {
        self.sum = 0.0;
        self.ms = 0.0;
    }
    fn floor(&self) -> Option<f32> {
        (self.blocks.len() >= NOISE_BLOCK_COUNT)
            .then(|| self.blocks.iter().copied().fold(f32::INFINITY, f32::min))
    }
}

#[derive(Debug, Clone)]
pub struct VadConfig {
    pub manual: bool,
    pub silence_ms: u32,
    pub barge_in_ms: u32,
}

#[derive(Debug, PartialEq)]
pub enum VadEvent {
    SpeechStarted { barge_in: bool },
    UtteranceEnd { reason: &'static str, pcm: Vec<i16>, duration_ms: u32 },
    Discarded { reason: &'static str },
}

struct Utt {
    pcm: Vec<i16>,
    frames: u32,
    voiced: u32,
    silence_run: u32,
}

pub struct Vad {
    cfg: VadConfig,
    pending: Vec<i16>,
    preroll: VecDeque<Vec<i16>>,
    floor: NoiseFloor,
    echo: f32,
    echo_primed: bool,
    onset_run: u32,
    utt: Option<Utt>,
    manual_buf: VecDeque<(Vec<i16>, bool)>,
    speaking: bool,
}

impl Vad {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            cfg,
            pending: Vec::new(),
            preroll: VecDeque::new(),
            floor: NoiseFloor::default(),
            echo: 0.0,
            echo_primed: false,
            onset_run: 0,
            utt: None,
            manual_buf: VecDeque::new(),
            speaking: false,
        }
    }

    pub fn threshold(&self) -> f32 {
        let floor = self.floor.floor().unwrap_or(0.0);
        (floor * 3.0).max(BASE_THRESHOLD).min(MAX_THRESHOLD)
    }

    /// Drop all in-flight state (mute). The learned noise floor is kept.
    pub fn reset(&mut self) {
        self.pending.clear();
        self.preroll.clear();
        self.onset_run = 0;
        self.utt = None;
        self.manual_buf.clear();
        self.speaking = false;
        self.echo = 0.0;
        self.echo_primed = false;
        self.floor.interrupt();
    }

    pub fn process(&mut self, samples: &[i16], assistant_active: bool) -> Vec<VadEvent> {
        self.pending.extend_from_slice(samples);
        let mut events = Vec::new();
        while self.pending.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = self.pending.drain(..FRAME_SAMPLES).collect();
            self.frame(frame, assistant_active, &mut events);
        }
        events
    }

    fn frame(&mut self, frame: Vec<i16>, active: bool, events: &mut Vec<VadEvent>) {
        let e = mean_abs(&frame);
        let in_speech = self.utt.is_some() || self.speaking;
        if active {
            self.floor.interrupt();
            if !in_speech && self.onset_run == 0 {
                self.echo = if self.echo_primed { self.echo + ECHO_ALPHA * (e - self.echo) } else { e };
                self.echo_primed = true;
            }
        } else {
            self.floor.observe(e, FRAME_MS as f32);
            self.echo = 0.0;
            self.echo_primed = false;
        }
        let thr = self.threshold();
        let onset_thr = if active { thr.max(self.echo * 1.5) } else { thr };
        let voiced = e > thr;
        let need = if active { self.cfg.barge_in_ms.div_ceil(FRAME_MS).max(1) } else { ONSET_MS / FRAME_MS };

        if self.cfg.manual {
            self.manual_buf.push_back((frame, voiced));
            if self.manual_buf.len() > MANUAL_MAX_FRAMES {
                self.manual_buf.pop_front();
            }
            self.onset_run = if e > onset_thr { self.onset_run + 1 } else { 0 };
            if !self.speaking && self.onset_run >= need {
                self.speaking = true;
                events.push(VadEvent::SpeechStarted { barge_in: active });
            }
            return;
        }

        if let Some(u) = self.utt.as_mut() {
            u.pcm.extend_from_slice(&frame);
            u.frames += 1;
            if voiced {
                u.voiced += 1;
                u.silence_run = 0;
            } else {
                u.silence_run += 1;
            }
            if u.silence_run * FRAME_MS >= self.cfg.silence_ms {
                events.push(self.finish("silence"));
            } else if u.frames * FRAME_MS >= MAX_UTTERANCE_MS {
                events.push(self.finish("max-duration"));
            }
            return;
        }

        self.preroll.push_back(frame);
        if self.preroll.len() > PREROLL_FRAMES {
            self.preroll.pop_front();
        }
        self.onset_run = if e > onset_thr { self.onset_run + 1 } else { 0 };
        if self.onset_run >= need {
            let pcm: Vec<i16> = self.preroll.drain(..).flatten().collect();
            let frames = (pcm.len() / FRAME_SAMPLES) as u32;
            self.utt = Some(Utt { pcm, frames, voiced: self.onset_run, silence_run: 0 });
            self.onset_run = 0;
            events.push(VadEvent::SpeechStarted { barge_in: active });
        }
    }

    fn finish(&mut self, reason: &'static str) -> VadEvent {
        let Some(mut u) = self.utt.take() else {
            return VadEvent::Discarded { reason: "too_short" };
        };
        self.onset_run = 0;
        if u.voiced * FRAME_MS < MIN_VOICED_MS {
            return VadEvent::Discarded { reason: "too_short" };
        }
        if reason == "silence" && u.silence_run > TAIL_SILENCE_FRAMES {
            let drop = (u.silence_run - TAIL_SILENCE_FRAMES) as usize * FRAME_SAMPLES;
            u.pcm.truncate(u.pcm.len() - drop);
        }
        let duration_ms = (u.pcm.len() as u64 * 1000 / INPUT_SAMPLE_RATE as u64) as u32;
        VadEvent::UtteranceEnd { reason, pcm: u.pcm, duration_ms }
    }

    /// Push-to-talk release: close the open utterance (or the manual buffer).
    pub fn ptt_release(&mut self) -> Vec<VadEvent> {
        if self.cfg.manual {
            let buf: Vec<(Vec<i16>, bool)> = self.manual_buf.drain(..).collect();
            self.speaking = false;
            self.onset_run = 0;
            let voiced = buf.iter().filter(|(_, v)| *v).count() as u32;
            if voiced * FRAME_MS < MIN_VOICED_MS {
                return vec![VadEvent::Discarded { reason: "too_short" }];
            }
            let pcm: Vec<i16> = buf.into_iter().flat_map(|(f, _)| f).collect();
            let duration_ms = (pcm.len() as u64 * 1000 / INPUT_SAMPLE_RATE as u64) as u32;
            return vec![VadEvent::UtteranceEnd { reason: "ptt", pcm, duration_ms }];
        }
        if self.utt.is_some() {
            vec![self.finish("ptt")]
        } else {
            Vec::new()
        }
    }
}

// ---------------------------------------------------------------------------
// Client frames
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum ClientFrame {
    Start {
        #[serde(default)]
        thread_id: Option<String>,
        audio: AudioSpec,
        #[serde(default)]
        turn_detection: Option<String>,
        #[serde(default)]
        silence_threshold_ms: Option<u32>,
        #[serde(default)]
        barge_in_min_speech_ms: Option<u32>,
        #[serde(default)]
        voice_id: Option<String>,
    },
    PttRelease,
    Interrupt,
    Mute { muted: bool },
    SpeakDelta { turn_id: String, text: String },
    SpeakEnd { turn_id: String },
    Playback { active: bool },
    End,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioSpec {
    mime_type: String,
    sample_rate: u32,
    channels: u32,
}

type Out = UnboundedSender<Value>;

fn send(out: &Out, v: Value) {
    let _ = out.send(v);
}

fn send_error(out: &Out, code: &str, message: impl Into<String>, recoverable: bool) {
    send(out, json!({"type": "error", "code": code, "message": message.into(), "recoverable": recoverable}));
}

// ---------------------------------------------------------------------------
// TTS turn runner
// ---------------------------------------------------------------------------

enum TurnCmd {
    Delta(String),
    End,
}

enum JobEvent {
    Audio(Vec<u8>),
    Failed(UpstreamError),
}

struct Job {
    index: usize,
    text: String,
    rx: UnboundedReceiver<JobEvent>,
    announced: bool,
}

#[derive(Default)]
struct Segmenter {
    buffer: String,
    fence: FenceFilter,
    enqueued: usize,
    pending: VecDeque<String>,
}

impl Segmenter {
    fn feed(&mut self, delta: &str, force: bool) {
        self.buffer.push_str(delta);
        let (segs, rem) = extract_speakable_segments(&self.buffer, force, self.enqueued == 0);
        self.buffer = rem;
        for seg in segs {
            let clean = sanitize_for_tts(&self.fence.filter(&seg));
            if clean.chars().any(char::is_alphanumeric) {
                self.enqueued += 1;
                self.pending.push_back(clean);
            }
        }
    }
}

struct TurnCtx {
    id: String,
    rx: UnboundedReceiver<TurnCmd>,
    out: Out,
    key: String,
    voice: String,
}

async fn run_turn(ctx: TurnCtx) {
    let TurnCtx { id, mut rx, out, key, voice } = ctx;
    let started = Instant::now();
    let mut seg = Segmenter::default();
    let mut open: VecDeque<Job> = VecDeque::new();
    let mut jobs: JoinSet<()> = JoinSet::new();
    let mut next_index = 0usize;
    let mut ended = false;
    let mut first_audio = false;

    loop {
        while open.len() < MAX_OPEN_JOBS {
            let Some(text) = seg.pending.pop_front() else { break };
            let (tx, jrx) = unbounded_channel();
            let (k, v, t) = (key.clone(), voice.clone(), text.clone());
            jobs.spawn(async move {
                let audio_tx = tx.clone();
                let mut sink = move |chunk: Vec<u8>| {
                    let _ = audio_tx.send(JobEvent::Audio(chunk));
                };
                if let Err(e) = tts_stream(&k, &v, &t, &mut sink).await {
                    let _ = tx.send(JobEvent::Failed(e));
                }
            });
            open.push_back(Job { index: next_index, text, rx: jrx, announced: false });
            next_index += 1;
        }

        if open.is_empty() {
            if ended {
                break;
            }
            match rx.recv().await {
                Some(TurnCmd::Delta(t)) => seg.feed(&t, false),
                Some(TurnCmd::End) | None => {
                    ended = true;
                    seg.feed("", true);
                }
            }
            continue;
        }

        if let Some(front) = open.front_mut() {
            if !front.announced {
                front.announced = true;
                send(&out, json!({"type": "tts_segment", "turnId": id, "index": front.index, "text": front.text}));
            }
        }

        tokio::select! {
            cmd = rx.recv(), if !ended => match cmd {
                Some(TurnCmd::Delta(t)) => seg.feed(&t, false),
                Some(TurnCmd::End) | None => {
                    ended = true;
                    seg.feed("", true);
                }
            },
            ev = async { open.front_mut().unwrap().rx.recv().await } => match ev {
                Some(JobEvent::Audio(bytes)) => {
                    let index = open.front().map(|j| j.index).unwrap_or(0);
                    send(&out, json!({
                        "type": "tts_audio", "turnId": id, "segment": index,
                        "mimeType": "audio/pcm", "sampleRate": TTS_SAMPLE_RATE,
                        "dataBase64": BASE64.encode(&bytes),
                    }));
                    if !first_audio {
                        first_audio = true;
                        send(&out, json!({
                            "type": "metrics", "turnId": id,
                            "ttsFirstAudioMs": started.elapsed().as_millis() as u64,
                        }));
                    }
                }
                Some(JobEvent::Failed(e)) => {
                    send_error(&out, "tts_failed", e.describe(""), true);
                }
                None => {
                    open.pop_front();
                }
            },
        }
    }
    send(&out, json!({"type": "tts_done", "turnId": id}));
}

struct Turn {
    id: String,
    tx: UnboundedSender<TurnCmd>,
    handle: JoinHandle<()>,
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

struct Live {
    out: Out,
    stt_key: String,
    tts_key: String,
    voice: String,
    language: Option<String>,
    vad: Vad,
    muted: bool,
    playback_active: bool,
    turn: Option<Turn>,
    closed: HashSet<String>,
    stt_tasks: JoinSet<()>,
}

impl Live {
    fn assistant_active(&self) -> bool {
        self.playback_active || self.turn.as_ref().is_some_and(|t| !t.handle.is_finished())
    }

    fn mark_closed(&mut self, id: &str) {
        if self.closed.len() > 256 {
            self.closed.clear();
        }
        self.closed.insert(id.to_string());
    }

    fn cancel_turn(&mut self, reason: &str) {
        let id = self.turn.take().map(|t| {
            t.handle.abort();
            t.id
        });
        if let Some(id) = &id {
            self.mark_closed(id);
        }
        self.playback_active = false;
        send(&self.out, json!({"type": "turn_cancelled", "turnId": id, "reason": reason}));
    }

    fn handle_events(&mut self, events: Vec<VadEvent>) {
        for ev in events {
            match ev {
                VadEvent::SpeechStarted { barge_in } => {
                    if barge_in {
                        self.cancel_turn("barge_in");
                    }
                    send(&self.out, json!({"type": "speech_started"}));
                }
                VadEvent::Discarded { reason } => {
                    send(&self.out, json!({"type": "utterance_discarded", "reason": reason}));
                }
                VadEvent::UtteranceEnd { reason, pcm, duration_ms } => {
                    send(&self.out, json!({"type": "utterance_end", "reason": reason}));
                    self.spawn_stt(pcm, duration_ms);
                }
            }
        }
    }

    fn spawn_stt(&mut self, pcm: Vec<i16>, duration_ms: u32) {
        let out = self.out.clone();
        let key = self.stt_key.clone();
        let language = self.language.clone();
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.stt_tasks.spawn(async move {
            let wav = pcm16_to_wav(&bytes, INPUT_SAMPLE_RATE);
            let started = Instant::now();
            match transcribe(&key, &wav, language.as_deref()).await {
                Ok(raw) => {
                    let text = clean_transcript(raw.trim());
                    if text.is_empty() {
                        send(&out, json!({"type": "utterance_discarded", "reason": "empty"}));
                    } else {
                        send(&out, json!({"type": "stt_final", "text": text, "durationMs": duration_ms}));
                        send(&out, json!({"type": "metrics", "sttMs": started.elapsed().as_millis() as u64}));
                    }
                }
                Err(e) => send_error(&out, "stt_failed", e.describe("STT"), true),
            }
        });
    }

    fn turn_for(&mut self, id: &str) -> Option<&Turn> {
        if self.closed.contains(id) {
            return None;
        }
        if !self.turn.as_ref().is_some_and(|t| t.id == id) {
            if let Some(old) = self.turn.take() {
                old.handle.abort();
                let old_id = old.id.clone();
                self.mark_closed(&old_id);
            }
            let (tx, rx) = unbounded_channel();
            let handle = tokio::spawn(run_turn(TurnCtx {
                id: id.to_string(),
                rx,
                out: self.out.clone(),
                key: self.tts_key.clone(),
                voice: self.voice.clone(),
            }));
            self.turn = Some(Turn { id: id.to_string(), tx, handle });
        }
        self.turn.as_ref()
    }
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let ticket = query.get("ticket").map(String::as_str).unwrap_or("");
    let user = TICKETS.lock().unwrap_or_else(|e| e.into_inner()).consume_at(ticket, Instant::now());
    if user.is_none() {
        return ApiError(StatusCode::UNAUTHORIZED, "invalid or expired live voice ticket".into()).into_response();
    }
    ws.on_upgrade(move |socket| run_session(socket, state))
}

async fn run_session(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut out_rx) = unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut seq = 0u64;
        while let Some(mut frame) = out_rx.recv().await {
            seq += 1;
            frame["seq"] = json!(seq);
            if sink.send(Message::Text(frame.to_string().into())).await.is_err() {
                return;
            }
        }
        let _ = sink.send(Message::Close(None)).await;
    });

    let mut live: Option<Live> = None;

    while let Some(Ok(msg)) = stream.next().await {
        if let Some(l) = live.as_mut() {
            while l.stt_tasks.try_join_next().is_some() {}
        }
        match msg {
            Message::Binary(bytes) => {
                let Some(l) = live.as_mut() else { continue };
                if l.muted {
                    continue;
                }
                let samples: Vec<i16> =
                    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                let active = l.assistant_active();
                let events = l.vad.process(&samples, active);
                l.handle_events(events);
            }
            Message::Text(text) => {
                let value: Value = match serde_json::from_str(text.as_str()) {
                    Ok(v) => v,
                    Err(e) => {
                        send_error(&out, "invalid_json", format!("invalid JSON: {e}"), true);
                        continue;
                    }
                };
                let frame: ClientFrame = match serde_json::from_value(value) {
                    Ok(f) => f,
                    Err(e) => {
                        send_error(&out, "invalid_frame", format!("invalid frame: {e}"), true);
                        continue;
                    }
                };
                match frame {
                    ClientFrame::End => break,
                    ClientFrame::Start {
                        thread_id,
                        audio,
                        turn_detection,
                        silence_threshold_ms,
                        barge_in_min_speech_ms,
                        voice_id,
                    } => {
                        if live.is_some() {
                            send_error(&out, "invalid_frame", "session already started", true);
                            continue;
                        }
                        if audio.mime_type != "audio/pcm" || audio.sample_rate != INPUT_SAMPLE_RATE || audio.channels != 1 {
                            send_error(&out, "invalid_frame", "audio must be audio/pcm, 16000 Hz, mono", true);
                            continue;
                        }
                        let manual = match turn_detection.as_deref() {
                            None | Some("server_vad") => false,
                            Some("manual") => true,
                            Some(other) => {
                                send_error(&out, "invalid_frame", format!("unknown turnDetection '{other}'"), true);
                                continue;
                            }
                        };
                        let settings = load_settings(&state).await.unwrap_or_else(|_| json!({}));
                        let stt_key = resolve_key(&state, "stt", PROVIDER, None).await.ok().flatten();
                        let tts_key = resolve_key(&state, "tts", PROVIDER, None).await.ok().flatten();
                        let (Some(stt_key), Some(tts_key)) = (stt_key, tts_key) else {
                            send_error(
                                &out,
                                "credentials_unavailable",
                                "No ElevenLabs API key is configured for live voice.",
                                false,
                            );
                            break;
                        };
                        let voice = voice_id
                            .filter(|v| valid_voice_id(v))
                            .unwrap_or_else(|| voice_from_settings(&settings));
                        let voice = if valid_voice_id(&voice) { voice } else { DEFAULT_VOICE_ID.to_string() };
                        let cfg = VadConfig {
                            manual,
                            silence_ms: silence_threshold_ms.unwrap_or(1200).clamp(100, 5000),
                            barge_in_ms: barge_in_min_speech_ms.unwrap_or(250).min(3000),
                        };
                        tracing::info!(thread = ?thread_id, manual, "live voice session started");
                        send(&out, json!({
                            "type": "ready",
                            "sessionId": uuid::Uuid::new_v4().simple().to_string(),
                            "turnDetection": if manual { "manual" } else { "server_vad" },
                            "tts": {"provider": PROVIDER, "voiceId": voice, "model": TTS_MODEL, "sampleRate": TTS_SAMPLE_RATE},
                            "stt": {"provider": PROVIDER, "model": STT_MODEL},
                        }));
                        live = Some(Live {
                            out: out.clone(),
                            stt_key,
                            tts_key,
                            voice,
                            language: language_from_settings(&settings),
                            vad: Vad::new(cfg),
                            muted: false,
                            playback_active: false,
                            turn: None,
                            closed: HashSet::new(),
                            stt_tasks: JoinSet::new(),
                        });
                    }
                    other => {
                        let Some(l) = live.as_mut() else {
                            send_error(&out, "invalid_frame", "send start first", true);
                            continue;
                        };
                        match other {
                            ClientFrame::PttRelease => {
                                let events = l.vad.ptt_release();
                                l.handle_events(events);
                            }
                            ClientFrame::Interrupt => l.cancel_turn("interrupt"),
                            ClientFrame::Mute { muted } => {
                                l.muted = muted;
                                if muted {
                                    l.vad.reset();
                                }
                            }
                            ClientFrame::Playback { active } => l.playback_active = active,
                            ClientFrame::SpeakDelta { turn_id, text } => {
                                if let Some(t) = l.turn_for(&turn_id) {
                                    let _ = t.tx.send(TurnCmd::Delta(text));
                                }
                            }
                            ClientFrame::SpeakEnd { turn_id } => {
                                if let Some(t) = l.turn_for(&turn_id) {
                                    let _ = t.tx.send(TurnCmd::End);
                                }
                            }
                            ClientFrame::Start { .. } | ClientFrame::End => {}
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if let Some(mut l) = live.take() {
        if let Some(t) = l.turn.take() {
            t.handle.abort();
        }
        l.stt_tasks.abort_all();
    }
    drop(out);
    if tokio::time::timeout(Duration::from_secs(2), writer).await.is_err() {
        tracing::debug!("live voice writer did not drain in time");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(vad: &mut Vad, amp: i16, n: usize, active: bool) -> Vec<VadEvent> {
        let mut ev = Vec::new();
        for _ in 0..n {
            ev.extend(vad.process(&vec![amp; FRAME_SAMPLES], active));
        }
        ev
    }

    fn vad() -> Vad {
        Vad::new(VadConfig { manual: false, silence_ms: 1200, barge_in_ms: 250 })
    }

    // -- segmenter --

    #[test]
    fn segments_sentences_and_keeps_decimals() {
        let (s, r) = extract_speakable_segments("Hello world. Pi is 3.14 today! Next", false, false);
        assert_eq!(s, vec!["Hello world.", "Pi is 3.14 today!"]);
        assert_eq!(r, " Next");
        let (s, _) = extract_speakable_segments("It costs 3.14 dollars", false, false);
        assert!(s.is_empty());
    }

    #[test]
    fn segments_closers_stay_attached_and_force_flushes() {
        let (s, r) = extract_speakable_segments("He said \"stop.\" Then left", true, false);
        assert_eq!(s, vec!["He said \"stop.\"", "Then left"]);
        assert_eq!(r, "");
    }

    #[test]
    fn eager_first_segment_splits_on_clause() {
        let t = "Well, I think that we should go to the store, then buy milk";
        let (s, _) = extract_speakable_segments(t, false, true);
        assert_eq!(s[0], "Well, I think that we should go to the store,");
        let (s, _) = extract_speakable_segments(t, false, false);
        assert!(s.is_empty());
    }

    #[test]
    fn eager_forced_split_at_60_and_default_at_180() {
        let t = "word ".repeat(16);
        let (s, r) = extract_speakable_segments(&t, false, true);
        assert!(!s.is_empty() && s[0].chars().count() <= 60, "{s:?}");
        assert!(!r.is_empty());
        let long = "word ".repeat(100);
        let (s, _) = extract_speakable_segments(&long, true, false);
        assert!(s.len() >= 3 && s.iter().all(|x| x.chars().count() <= 180), "{s:?}");
    }

    #[test]
    fn segments_cjk_without_whitespace() {
        let (s, r) = extract_speakable_segments("こんにちは。元気ですか？はい", false, false);
        assert_eq!(s, vec!["こんにちは。", "元気ですか？"]);
        assert_eq!(r, "はい");
        let (s, _) = extract_speakable_segments("「こんにちは。」次です", false, false);
        assert_eq!(s[0], "「こんにちは。」");
    }

    #[test]
    fn segments_split_on_newline() {
        let (s, r) = extract_speakable_segments("one line\nsecond", false, false);
        assert_eq!(s, vec!["one line"]);
        assert_eq!(r, "second");
    }

    // -- sanitizer --

    #[test]
    fn sanitizes_markdown() {
        assert_eq!(sanitize_for_tts("**Bold** and *it* and `code`"), "Bold and it and code");
        assert_eq!(sanitize_for_tts("## Title\n- one\n* two"), "Title one two");
        assert_eq!(sanitize_for_tts("5 * 3 and my_var"), "5 * 3 and my_var");
        assert_eq!(sanitize_for_tts("Great job 🎉👍 team"), "Great job team");
    }

    #[test]
    fn sanitizes_links_and_urls() {
        assert_eq!(sanitize_for_tts("See [the docs](https://x.io/a_(b)/c) now"), "See the docs now");
        assert_eq!(sanitize_for_tts("Look ![chart](http://x/y.png) here"), "Look here");
        assert_eq!(sanitize_for_tts("Visit https://example.com/path. Thanks"), "Visit . Thanks");
    }

    #[test]
    fn fenced_code_is_dropped_once_per_turn() {
        let mut f = FenceFilter::default();
        let a = sanitize_for_tts(&f.filter("Here:\n```rust\nlet x = 1;"));
        assert_eq!(a, "Here: I've put the code in the chat.");
        assert_eq!(sanitize_for_tts(&f.filter("println!();")), "");
        assert_eq!(sanitize_for_tts(&f.filter("```\nDone.")), "Done.");
        assert_eq!(sanitize_for_tts(&f.filter("a ```x``` b")), "a b");
    }

    #[test]
    fn segmenter_skips_empty_and_announces_code() {
        let mut s = Segmenter::default();
        s.feed("Intro here.\n```\ncode();\n```\n🎉\nAll done.", true);
        let all: Vec<_> = s.pending.iter().cloned().collect();
        assert_eq!(all.first().unwrap(), "Intro here.");
        assert!(all.iter().any(|x| x.contains("put the code in the chat")));
        assert_eq!(all.last().unwrap(), "All done.");
        assert!(!all.iter().any(|x| x.contains("code();")));
    }

    #[test]
    fn transcript_cleaning() {
        assert_eq!(clean_transcript("(background noise)"), "");
        assert_eq!(clean_transcript("[music] "), "");
        assert_eq!(clean_transcript("Hello [laughter] there"), "Hello there");
        assert_eq!(clean_transcript("  Hi there. "), "Hi there.");
    }

    // -- WAV --

    #[test]
    fn wav_header_is_correct() {
        let pcm = vec![1u8, 0, 2, 0, 3, 0];
        let w = pcm16_to_wav(&pcm, 16_000);
        assert_eq!(w.len(), 44 + 6);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(w[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(w[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(w[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(w[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(w[34..36].try_into().unwrap()), 16);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 6);
        assert_eq!(&w[44..], &pcm[..]);
    }

    // -- VAD --

    #[test]
    fn vad_speech_then_silence_ends_utterance() {
        let mut v = vad();
        let mut ev = frames(&mut v, 0, 10, false);
        ev.extend(frames(&mut v, 3000, 6, false));
        ev.extend(frames(&mut v, 0, 26, false));
        assert_eq!(ev.len(), 2, "{ev:?}");
        assert_eq!(ev[0], VadEvent::SpeechStarted { barge_in: false });
        match &ev[1] {
            VadEvent::UtteranceEnd { reason, pcm, duration_ms } => {
                assert_eq!(*reason, "silence");
                assert!(*duration_ms >= 300);
                // 10 pre-roll + 6 voiced + 6 tail frames
                assert_eq!(pcm.len(), 22 * FRAME_SAMPLES);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn vad_short_blip_is_discarded() {
        let mut v = vad();
        let mut ev = frames(&mut v, 3000, 3, false);
        ev.extend(frames(&mut v, 0, 30, false));
        assert_eq!(ev, vec![VadEvent::SpeechStarted { barge_in: false }, VadEvent::Discarded { reason: "too_short" }]);
        // Even shorter than onset: nothing at all.
        let mut v = vad();
        let mut ev = frames(&mut v, 3000, 2, false);
        ev.extend(frames(&mut v, 0, 30, false));
        assert!(ev.is_empty());
    }

    #[test]
    fn vad_noise_floor_raises_threshold() {
        let mut v = vad();
        assert_eq!(v.threshold(), 800.0);
        let _ = frames(&mut v, 500, 220, false);
        assert!((v.threshold() - 1500.0).abs() < 1.0, "{}", v.threshold());
        assert!(frames(&mut v, 1200, 10, false).is_empty());
        let mut fresh = vad();
        assert!(!frames(&mut fresh, 1200, 10, false).is_empty());
        // Threshold is capped.
        let mut loud = vad();
        let _ = frames(&mut loud, 2500, 220, false);
        assert_eq!(loud.threshold(), 3200.0);
    }

    #[test]
    fn vad_accepts_arbitrary_chunk_sizes() {
        let mut v = vad();
        let mut ev = Vec::new();
        for _ in 0..(16 * 800 / 160) {
            ev.extend(v.process(&[3000i16; 160], false));
        }
        assert_eq!(ev, vec![VadEvent::SpeechStarted { barge_in: false }]);
    }

    #[test]
    fn vad_barge_in_needs_sustained_energy_above_echo() {
        let mut v = vad();
        // Not enough sustained speech for barge-in (needs 5 frames).
        assert!(frames(&mut v, 3000, 4, true).is_empty());
        let mut v = vad();
        let _ = frames(&mut v, 0, 4, true); // quiet playback: echo estimate ~0
        let ev = frames(&mut v, 3000, 5, true);
        assert_eq!(ev, vec![VadEvent::SpeechStarted { barge_in: true }]);
        // Echo estimate raises the bar.
        let mut v = vad();
        let _ = frames(&mut v, 2000, 20, true);
        assert!(frames(&mut v, 2500, 10, true).is_empty());
        assert!(!frames(&mut v, 6000, 10, true).is_empty());
    }

    #[test]
    fn vad_max_duration_and_ptt() {
        let mut v = vad();
        let ev = frames(&mut v, 6000, 620, false);
        assert!(ev.iter().any(|e| matches!(e, VadEvent::UtteranceEnd { reason: "max-duration", .. })));
        let mut v = vad();
        let _ = frames(&mut v, 3000, 10, false);
        let ev = v.ptt_release();
        assert!(matches!(ev[0], VadEvent::UtteranceEnd { reason: "ptt", .. }));
        assert!(v.ptt_release().is_empty());
    }

    #[test]
    fn vad_manual_mode_collects_until_release() {
        let mut v = Vad::new(VadConfig { manual: true, silence_ms: 1200, barge_in_ms: 250 });
        let mut ev = frames(&mut v, 3000, 10, false);
        ev.extend(frames(&mut v, 0, 60, false)); // long silence does not end it
        assert_eq!(ev, vec![VadEvent::SpeechStarted { barge_in: false }]);
        match &v.ptt_release()[0] {
            VadEvent::UtteranceEnd { reason, pcm, .. } => {
                assert_eq!(*reason, "ptt");
                assert_eq!(pcm.len(), 70 * FRAME_SAMPLES);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(v.ptt_release(), vec![VadEvent::Discarded { reason: "too_short" }]);
    }

    #[test]
    fn vad_reset_drops_open_utterance() {
        let mut v = vad();
        let _ = frames(&mut v, 3000, 10, false);
        v.reset();
        assert!(frames(&mut v, 0, 40, false).is_empty());
    }

    // -- tickets --

    #[test]
    fn ticket_is_one_time_and_expires() {
        let mut s = TicketStore::default();
        let now = Instant::now();
        let t = s.issue_at("u1", now);
        assert_eq!(t.len(), 48);
        assert_eq!(s.consume_at(&t, now + Duration::from_secs(5)), Some("u1".into()));
        assert_eq!(s.consume_at(&t, now + Duration::from_secs(6)), None);
        let t2 = s.issue_at("u2", now);
        assert_eq!(s.consume_at(&t2, now + Duration::from_secs(61)), None);
        assert_eq!(s.consume_at("bogus", now), None);
    }

    #[test]
    fn ticket_issue_prunes_expired() {
        let mut s = TicketStore::default();
        let now = Instant::now();
        let _ = s.issue_at("u1", now);
        let _ = s.issue_at("u2", now + Duration::from_secs(120));
        assert_eq!(s.map.len(), 1);
    }

    #[test]
    fn client_frames_parse() {
        let f: ClientFrame = serde_json::from_str(
            r#"{"type":"start","audio":{"mimeType":"audio/pcm","sampleRate":16000,"channels":1},"turnDetection":"manual","silenceThresholdMs":900}"#,
        )
        .unwrap();
        assert!(matches!(f, ClientFrame::Start { silence_threshold_ms: Some(900), .. }));
        let f: ClientFrame = serde_json::from_str(r#"{"type":"speak_delta","turnId":"t1","text":"hi"}"#).unwrap();
        assert!(matches!(f, ClientFrame::SpeakDelta { .. }));
    }

    // -- live smoke test (needs ELEVENLABS_API_KEY) --

    #[tokio::test]
    #[ignore]
    async fn live_smoke_elevenlabs_tts_then_stt() {
        let key = std::env::var("ELEVENLABS_API_KEY").expect("ELEVENLABS_API_KEY");
        let mut pcm: Vec<u8> = Vec::new();
        let mut chunks = 0;
        tts_stream(&key, DEFAULT_VOICE_ID, "Hello there. This is a quick test of the live voice system.", &mut |c| {
            assert_eq!(c.len() % 2, 0);
            chunks += 1;
            pcm.extend(c);
        })
        .await
        .expect("tts");
        assert!(!pcm.is_empty());
        println!("tts bytes={} chunks={chunks}", pcm.len());
        let s24: Vec<i16> = pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let n = (s24.len() as f64 / 1.5) as usize;
        let mut down = Vec::with_capacity(n * 2);
        for i in 0..n.saturating_sub(1) {
            let pos = i as f64 * 1.5;
            let (a, frac) = (pos as usize, pos.fract());
            let v = s24[a] as f64 * (1.0 - frac) + s24[a + 1] as f64 * frac;
            down.extend_from_slice(&(v as i16).to_le_bytes());
        }
        let wav = pcm16_to_wav(&down, 16_000);
        let text = transcribe(&key, &wav, Some("en")).await.expect("stt");
        println!("transcript: {text}");
        assert!(!text.trim().is_empty());
    }
}
