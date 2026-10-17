//! Configuration file support for amiro
//!
//! Config is loaded from `~/.jcode/config.toml` (or `$AMIRO_HOME/config.toml`)
//! Environment variables override config file settings.

pub use amiro_config_types::{
    AgentsConfig, AmbientConfig, AuthConfig, AutoJudgeConfig, AutoReviewConfig, CompactionConfig,
    CompactionMode, CrossProviderFailoverMode, CustomWebSearchConfig, CustomWebSearchMethod,
    DiagramDisplayMode, DiagramPanePosition, DiffDisplayMode, DisplayConfig, FeatureConfig,
    GatewayConfig, HookCommands, HooksConfig, KeybindingsConfig, LatexRenderingMode,
    LaunchHotkeyEntry, LaunchHotkeysConfig, MarkdownSpacingMode, MenubarConfig, NamedProviderAuth,
    NamedProviderConfig, NamedProviderModelConfig, NamedProviderType, NativeScrollbarConfig,
    NotificationsConfig, PowerConfig, ProviderConfig, ReasoningDisplayMode, SafetyConfig,
    SessionConfig, SessionPickerResumeAction, SponsorsConfig, SwarmSpawnMode, SwarmStripLayout,
    TerminalConfig, UpdateChannel, WebSearchConfig, WebSearchEngine,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant, SystemTime};

const CONFIG_CACHE_CHECK_INTERVAL: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    Duration::from_millis(500)
};

#[cfg(test)]
#[test]
fn custom_websearch_config_toml_roundtrip() {
    let input = r#"
engine = "custom"
prefer_native = false
fallback_engines = []
[custom]
endpoint = "https://search.example.test/api"
method = "POST"
query_param = "search"
count_param = "limit"
params = { format = "json" }
body = { options = { safe = true } }
headers = { Accept = "application/json" }
header_env = { Authorization = "SEARCH_AUTH" }
results_pointer = "/data/hits"
title_pointer = "/name"
url_pointer = "/link"
snippet_pointer = "/summary"
"#;
    let config: WebSearchConfig = toml::from_str(input).unwrap();
    assert_eq!(config.engine, WebSearchEngine::Custom);
    assert!(!config.native_enabled());
    assert_eq!(
        WebSearchEngine::parse("custom"),
        Some(WebSearchEngine::Custom)
    );
    assert!(WebSearchEngine::Custom.is_local());
    assert_eq!(WebSearchEngine::Custom.as_str(), "custom");
    let encoded = toml::to_string(&config).unwrap();
    let decoded: WebSearchConfig = toml::from_str(&encoded).unwrap();
    assert_eq!(
        serde_json::to_value(config).unwrap(),
        serde_json::to_value(decoded).unwrap()
    );
    let no_count: CustomWebSearchConfig =
        toml::from_str("endpoint = 'https://example.test'").unwrap();
    assert!(no_count.count_param.is_none());
    assert_eq!(no_count.method, CustomWebSearchMethod::Get);
    assert!(WebSearchConfig::default().custom.is_none());
}

const CONFIG_ENV_KEYS: &[&str] = &[
    "AMIRO_HIBERNATION_IDLE_SECS",
    "HOME",
    "AMIRO_COMMIT_LOG_KEY",
    "AMIRO_RESUME_PROJECT_SCOPE",
    "AMIRO_SWARM_STALL_AFTER_SECS",
    "AMIRO_SWARM_STALL_NUDGE",
    "AMIRO_ACP_PROFILE",
    "AMIRO_ACP_TOOL_PROFILE",
    "AMIRO_ACTIVE_SESSIONS_MANAGER",
    "AMIRO_EXTERNAL_SESSIONS",
    "AMIRO_AMBIENT_ENABLED",
    "AMIRO_AMBIENT_MAX_INTERVAL",
    "AMIRO_AMBIENT_MIN_INTERVAL",
    "AMIRO_AMBIENT_MODEL",
    "AMIRO_AMBIENT_PROACTIVE",
    "AMIRO_AMBIENT_PROVIDER",
    "AMIRO_AMBIENT_VISIBLE",
    "AMIRO_ANIMATION_FPS",
    "AMIRO_AUTO_POKE",
    "AMIRO_AUTOJUDGE_ENABLED",
    "AMIRO_AUTOJUDGE_MODEL",
    "AMIRO_AUTOREVIEW_ENABLED",
    "AMIRO_AUTOREVIEW_MODEL",
    "AMIRO_AUTO_POKE",
    "AMIRO_AUTO_SERVER_RELOAD",
    "AMIRO_CHECK_UPDATES",
    "AMIRO_BING_API_KEY",
    "AMIRO_BLOCK_LID_CLOSE",
    "AMIRO_BING_API_KEY_ENV",
    "AMIRO_BING_MARKET",
    "AMIRO_CENTERED_TOGGLE_KEY",
    "AMIRO_CHAT_NATIVE_SCROLLBAR",
    "AMIRO_COMPACT_NOTIFICATIONS",
    "AMIRO_COPY_BADGE_ALT_LABEL",
    "AMIRO_COPY_SELECTION_TOGGLE_KEY",
    "AMIRO_COPILOT_PREMIUM",
    "AMIRO_GEMINI_FORCE_OAUTH",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
    "AMIRO_WAKE_MODE",
    "AMIRO_CROSS_PROVIDER_FAILOVER",
    "AMIRO_DEBUG_SOCKET",
    "AMIRO_DEFAULT_REASONING_DISPLAY",
    "AMIRO_DICTATION_COMMAND",
    "AMIRO_DICTATION_RECORDER",
    "AMIRO_DICTATION_KEY",
    "AMIRO_DICTATION_MODE",
    "AMIRO_DICTATION_TIMEOUT_SECS",
    "AMIRO_DIFF_LINE_WRAP",
    "AMIRO_DIFF_MODE",
    "AMIRO_DIFF_MODE_CYCLE_KEY",
    "AMIRO_DIAGRAM_PANE_TOGGLE_KEY",
    "AMIRO_DIAGRAM_PANE_VISIBILITY_TOGGLE_KEY",
    "AMIRO_DISABLE_BASE_TOOLS",
    "AMIRO_DISABLED_ANIMATIONS",
    "AMIRO_DISABLED_TOOLS",
    "AMIRO_DISCORD_BOT_TOKEN",
    "AMIRO_DISCORD_BOT_USER_ID",
    "AMIRO_DISCORD_CHANNEL_ID",
    "AMIRO_DISCORD_REPLY_ENABLED",
    "AMIRO_DISPLAY_CENTERED",
    "AMIRO_EFFORT_DECREASE_KEY",
    "AMIRO_EFFORT_INCREASE_KEY",
    "AMIRO_SPEED_DECREASE_KEY",
    "AMIRO_SPEED_INCREASE_KEY",
    "AMIRO_EMAIL_REPLY_ENABLED",
    "AMIRO_EMAIL_TO",
    "AMIRO_FOCUS_HOOK",
    "AMIRO_GATEWAY_BIND_ADDR",
    "AMIRO_GATEWAY_ENABLED",
    "AMIRO_GATEWAY_PORT",
    "AMIRO_HOME",
    "AMIRO_HOOK_PRE_TOOL",
    "AMIRO_HOOK_PRE_TOOL_TRANSFORM",
    "AMIRO_HOOK_PRE_TOOL_TRANSFORM_TIMEOUT_MS",
    "AMIRO_HOOK_PRE_TOOL_TIMEOUT_MS",
    "AMIRO_HOOK_POST_TOOL",
    "AMIRO_HOOK_POST_TOOL_FEEDBACK",
    "AMIRO_HOOK_POST_TOOL_FEEDBACK_TIMEOUT_MS",
    "AMIRO_HOOK_SESSION_END",
    "AMIRO_HOOK_SESSION_START",
    "AMIRO_HOOK_TURN_END",
    "AMIRO_HOOK_TURN_START",
    "AMIRO_IDLE_ANIMATION",
    "AMIRO_IMAP_HOST",
    "AMIRO_INFO_WIDGET_TOGGLE_KEY",
    "AMIRO_JADE_RELAY_API_BASE",
    "AMIRO_JADE_RELAY_ENABLED",
    "AMIRO_JADE_RELAY_LAUNCH_ENABLED",
    "AMIRO_JADE_RELAY_LAUNCH_WORKING_DIR",
    "AMIRO_JADE_RELAY_REPLY_ENABLED",
    "AMIRO_JADE_RELAY_SESSION_ID",
    "AMIRO_JADE_RELAY_TOKEN",
    "AMIRO_JADE_RELAY_TOKEN_ID",
    "AMIRO_JADE_RELAY_USER_ID",
    "AMIRO_KV_CACHE_MISS_NOTICES",
    "AMIRO_LATEX_RENDERING",
    "AMIRO_MARKDOWN_SPACING",
    "AMIRO_MEMORY_EMBEDDING_BACKEND",
    "AMIRO_MEMORY_EMBEDDING_BASE_URL",
    "AMIRO_MEMORY_EMBEDDING_DIM",
    "AMIRO_MEMORY_EMBEDDING_MODEL",
    "AMIRO_MEMORY_ENABLED",
    "AMIRO_MEMORY_JEV_PROVIDER",
    "AMIRO_ENABLE_MERMAID",
    "AMIRO_MEMORY_MODEL",
    "AMIRO_MEMORY_SIDECAR_ENABLED",
    "AMIRO_PERSIST_MEMORY_INJECTIONS",
    "AMIRO_MESSAGE_TIMESTAMPS",
    "AMIRO_MODEL",
    "AMIRO_MODEL_SWITCH_KEY",
    "AMIRO_MODEL_SWITCH_PREV_KEY",
    "AMIRO_MOUSE_CAPTURE",
    "AMIRO_NEW_TERMINAL_KEY",
    "AMIRO_NO_EMOJI",
    "AMIRO_NTFY_SERVER",
    "AMIRO_NTFY_TOPIC",
    "AMIRO_OPENAI_NATIVE_COMPACTION_MODE",
    "AMIRO_OPENAI_NATIVE_COMPACTION_THRESHOLD_TOKENS",
    "AMIRO_OPENAI_REASONING_EFFORT",
    "AMIRO_OPENAI_SERVICE_TIER",
    "AMIRO_OPENAI_TRANSPORT",
    "AMIRO_ANTHROPIC_REASONING_EFFORT",
    "AMIRO_PRESERVE_REASONING_CONTEXT",
    "AMIRO_PERFORMANCE",
    "AMIRO_PIN_IMAGES",
    "AMIRO_PIN_TODOS",
    "AMIRO_PREVENT_SLEEP_WHILE_STREAMING",
    "AMIRO_PROVIDER",
    "AMIRO_PROMPT_ENTRY_ANIMATION",
    "AMIRO_QUEUE_MODE",
    "AMIRO_REASONING_DISPLAY",
    "AMIRO_REDRAW_FPS",
    "AMIRO_SAME_PROVIDER_ACCOUNT_FAILOVER",
    "AMIRO_SCROLL_BOOKMARK_KEY",
    "AMIRO_SCROLL_DOWN_FALLBACK_KEY",
    "AMIRO_SCROLL_DOWN_KEY",
    "AMIRO_SCROLL_PAGE_DOWN_KEY",
    "AMIRO_SCROLL_PAGE_UP_KEY",
    "AMIRO_SCROLL_PROMPT_DOWN_KEY",
    "AMIRO_SCROLL_PROMPT_UP_KEY",
    "AMIRO_SCROLL_UP_FALLBACK_KEY",
    "AMIRO_SCROLL_UP_KEY",
    "AMIRO_SEARXNG_URL",
    "AMIRO_SHOW_AGENTGREP_OUTPUT",
    "AMIRO_SHOW_BASH_OUTPUT",
    "AMIRO_SHOW_DIFFS",
    "AMIRO_SHOW_THINKING",
    "AMIRO_SIDE_PANEL_TOGGLE_KEY",
    "AMIRO_SIDE_PANEL_NATIVE_SCROLLBAR",
    "AMIRO_SMTP_PASSWORD",
    "AMIRO_SPAWN_HOOK",
    "AMIRO_STREAM_IDLE_TIMEOUT_SECS",
    "AMIRO_MAX_RETRIES",
    "AMIRO_MCP_TOOLS",
    "AMIRO_MCP_TOOLS_TOKEN_THRESHOLD",
    "AMIRO_CODEMODE",
    "AMIRO_RETRY_BACKOFF_CAP_SECS",
    "AMIRO_SWARM_ENABLED",
    "AMIRO_SWARM_EFFORT",
    "AMIRO_SWARM_ROOT_EFFORT",
    "AMIRO_SWARM_DEEP_ROOT_EFFORT",
    "AMIRO_SWARM_MODEL",
    "AMIRO_SWARM_MAX_CONCURRENT_AGENTS",
    "AMIRO_SWARM_SPAWN_MODE",
    "AMIRO_SWARM_STRIP_LAYOUT",
    "AMIRO_TELEGRAM_BOT_TOKEN",
    "AMIRO_TELEGRAM_CHAT_ID",
    "AMIRO_TELEGRAM_REPLY_ENABLED",
    "AMIRO_TOOL_CALL_DETAILS",
    "AMIRO_TOOL_PROFILE",
    "AMIRO_TOOLS",
    "AMIRO_TRUSTED_EXTERNAL_AUTH_SOURCES",
    "AMIRO_TYPING_SCROLL_LOCK_TOGGLE_KEY",
    "AMIRO_UPDATE_CHANNEL",
    "AMIRO_VOICE_INPUT_KEY",
    "AMIRO_WEBSEARCH_ENGINE",
    "AMIRO_WEBSEARCH_FALLBACK_ENGINES",
    "AMIRO_WEBSEARCH_NATIVE_ALLOWED_DOMAINS",
    "AMIRO_WEBSEARCH_NATIVE_BLOCKED_DOMAINS",
    "AMIRO_WEBSEARCH_NATIVE_MAX_USES",
    "AMIRO_WEBSEARCH_PREFER_NATIVE",
    "AMIRO_WORKSPACE_DOWN_KEY",
    "AMIRO_WORKSPACE_LEFT_KEY",
    "AMIRO_WORKSPACE_RIGHT_KEY",
    "AMIRO_WORKSPACE_UP_KEY",
    "XDG_CONFIG_HOME",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigCacheFingerprint {
    path: Option<PathBuf>,
    modified: Option<SystemTime>,
    len: Option<u64>,
    env: Vec<(String, String)>,
}

impl ConfigCacheFingerprint {
    fn current() -> Self {
        let path = Config::path();
        let metadata = path.as_ref().and_then(|path| std::fs::metadata(path).ok());
        Self {
            path,
            modified: metadata
                .as_ref()
                .and_then(|metadata| metadata.modified().ok()),
            len: metadata.as_ref().map(std::fs::Metadata::len),
            env: config_env_fingerprint(),
        }
    }
}

struct ConfigCache {
    config: &'static Config,
    fingerprint: ConfigCacheFingerprint,
    last_checked: Instant,
    force_reload: bool,
}

static CONFIG_CACHE: LazyLock<RwLock<ConfigCache>> = LazyLock::new(|| {
    let config = leak_config(Config::load());
    // Fingerprint after the load: applying env overrides may set env vars
    // (e.g. copilot_premium -> AMIRO_COPILOT_PREMIUM), and fingerprinting
    // first would guarantee a spurious full reload on the next check.
    let fingerprint = ConfigCacheFingerprint::current();
    // Seed the global context-limit cache from named provider configs on first
    // load so every codepath (TUI info widget, compaction budget, model
    // switching) sees user-configured `context_window` values from the start.
    // Read from the loaded config directly to avoid recursing into config(),
    // which would deadlock on the still-initializing CONFIG_CACHE.
    populate_context_limits_from_config_ref(config);
    RwLock::new(ConfigCache {
        config,
        fingerprint,
        last_checked: Instant::now(),
        force_reload: false,
    })
});

fn leak_config(config: Config) -> &'static Config {
    Box::leak(Box::new(config))
}

/// Seed the global context-limit cache from a config reference directly.
///
/// Used during CONFIG_CACHE initialization (where calling config() would
/// deadlock) and shares its logic with
/// `crate::provider::populate_context_limits_from_config`.
fn populate_context_limits_from_config_ref(cfg: &Config) {
    crate::provider::populate_context_limits_from_config_value(cfg);
}

/// Get the global config instance.
///
/// The returned reference is backed by a reloadable process cache. Calls check
/// the config file path/metadata and relevant environment overrides on a short
/// throttle, not every frame. When those inputs change, the next checked call
/// reloads config.toml and invalidates dependent auth/model caches. Older
/// references remain valid for the duration of any in-flight operation.
pub fn config() -> &'static Config {
    let now = Instant::now();
    if let Ok(cache) = CONFIG_CACHE.read()
        && !cache.force_reload
        && now.duration_since(cache.last_checked) < CONFIG_CACHE_CHECK_INTERVAL
    {
        return cache.config;
    }

    let mut reload_reason = None;
    let config = {
        let mut cache = CONFIG_CACHE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let now = Instant::now();
        if !cache.force_reload
            && now.duration_since(cache.last_checked) < CONFIG_CACHE_CHECK_INTERVAL
        {
            return cache.config;
        }

        let fingerprint = ConfigCacheFingerprint::current();
        cache.last_checked = now;
        if cache.force_reload || cache.fingerprint != fingerprint {
            reload_reason = Some(describe_config_reload(
                cache.force_reload,
                &cache.fingerprint,
                &fingerprint,
            ));
            cache.config = leak_config(Config::load());
            // Loading applies env overrides that can themselves set env vars
            // (e.g. copilot_premium propagates config -> AMIRO_COPILOT_PREMIUM).
            // Re-fingerprint after the load so those self-inflicted env changes
            // don't trigger a guaranteed second reload on the next check.
            cache.fingerprint = ConfigCacheFingerprint::current();
            cache.force_reload = false;
        }
        cache.config
    };

    if let Some(reason) = reload_reason {
        crate::logging::info(&format!("CONFIG_RELOAD {}", reason));
        // A config reload can change config-derived system prompt sections
        // (feature toggles, sponsors, ...), which legitimately invalidates the
        // KV cache prefix of warm sessions. Document it so a subsequent
        // harness-attributed cache miss is surfaced with this cause instead of
        // as an unexplained prompt mutation.
        crate::cache_invalidation::record("config reload", &reason);
        notify_config_reloaded();
        // Re-seed the global context-limit cache so user edits to named
        // provider `context_window` values take effect without a restart.
        crate::provider::populate_context_limits_from_config();
    }

    config
}

fn describe_config_reload(
    forced: bool,
    previous: &ConfigCacheFingerprint,
    next: &ConfigCacheFingerprint,
) -> String {
    let mut parts = Vec::new();
    if forced {
        parts.push("forced=true".to_string());
    }
    if previous.path != next.path {
        parts.push(format!(
            "path={:?}->{:?}",
            previous.path.as_ref().map(|p| p.display().to_string()),
            next.path.as_ref().map(|p| p.display().to_string())
        ));
    }
    if previous.modified != next.modified {
        parts.push("modified_changed=true".to_string());
    }
    if previous.len != next.len {
        parts.push(format!("len={:?}->{:?}", previous.len, next.len));
    }
    let env_changes = describe_env_changes(&previous.env, &next.env);
    if !env_changes.is_empty() {
        parts.push(format!("env=[{}]", env_changes.join(", ")));
    }
    if parts.is_empty() {
        "unchanged".to_string()
    } else {
        parts.join(" ")
    }
}

fn describe_env_changes(previous: &[(String, String)], next: &[(String, String)]) -> Vec<String> {
    let previous_map: BTreeMap<&str, &str> = previous
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let next_map: BTreeMap<&str, &str> = next
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let keys: BTreeSet<&str> = previous_map
        .keys()
        .chain(next_map.keys())
        .copied()
        .collect();

    keys.into_iter()
        .filter_map(|key| match (previous_map.get(key), next_map.get(key)) {
            (Some(previous), Some(next)) if previous != next => Some(format!(
                "{}:changed({}->{})",
                key,
                env_value_fingerprint(previous),
                env_value_fingerprint(next)
            )),
            (None, Some(next)) => Some(format!("{}:added({})", key, env_value_fingerprint(next))),
            (Some(previous), None) => Some(format!(
                "{}:removed({})",
                key,
                env_value_fingerprint(previous)
            )),
            _ => None,
        })
        .collect()
}

fn env_value_fingerprint(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("len:{} hash:{:016x}", value.len(), hasher.finish())
}

fn config_env_fingerprint() -> Vec<(String, String)> {
    let mut values = std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_string_lossy().to_string();
            if CONFIG_ENV_KEYS.contains(&key.as_str()) {
                Some((key, value.to_string_lossy().to_string()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.0.cmp(&right.0));
    values
}

pub fn invalidate_config_cache() {
    let mut cache = CONFIG_CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.force_reload = true;
    drop(cache);
    notify_config_reloaded();
}

fn notify_config_reloaded() {
    CONFIG_RELOAD_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    for listener in CONFIG_RELOAD_LISTENERS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
    {
        listener();
    }
}

/// Monotonic counter bumped every time the config cache reloads.
///
/// Callers that snapshot config-derived state (e.g. the TUI's parsed
/// keybindings) can poll this cheaply and re-derive their snapshot when the
/// generation changes, giving instant hot-reload of config edits without a
/// restart.
static CONFIG_RELOAD_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Current config reload generation. Increments after every cache reload.
pub fn config_reload_generation() -> u64 {
    CONFIG_RELOAD_GENERATION.load(std::sync::atomic::Ordering::Relaxed)
}

/// Listeners invoked after the config cache reloads.
///
/// Config is a foundational module, so instead of reaching up into higher-level
/// subsystems (auth cache, event bus) on reload, those subsystems register a
/// reaction here at startup. This keeps config free of upward dependencies and
/// breaks the config -> auth / config -> bus cycle edges.
/// Type of a config reload listener callback.
type ConfigReloadListener = fn();

static CONFIG_RELOAD_LISTENERS: LazyLock<RwLock<Vec<ConfigReloadListener>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));

/// Register a callback to run after the config cache reloads.
///
/// Callbacks must be cheap and non-blocking; they run on whichever thread
/// triggers the reload. Intended to be called once per subsystem during
/// process startup.
pub fn on_config_reloaded(listener: fn()) {
    CONFIG_RELOAD_LISTENERS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(listener);
}

/// Main configuration struct
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    /// Idle session memory hibernation policy.
    pub session: SessionConfig,

    /// Daemon behavior for autonomous wake requests.
    pub server: ServerConfig,

    /// Keybinding configuration
    pub keybindings: KeybindingsConfig,

    /// External dictation / speech-to-text integration
    pub dictation: DictationConfig,

    /// Display/UI configuration
    pub display: DisplayConfig,

    /// Feature toggles
    pub features: FeatureConfig,

    /// Web search tool configuration
    pub websearch: WebSearchConfig,

    /// Built-in tool exposure configuration
    pub tools: ToolConfig,

    /// Agent Client Protocol adapter configuration
    pub acp: AcpConfig,

    /// Auth trust / consent configuration
    pub auth: AuthConfig,

    /// Provider configuration
    pub provider: ProviderConfig,

    /// Named provider profiles, keyed by profile name.
    ///
    /// Example:
    /// [providers.my-gateway]
    /// type = "openai-compatible"
    /// base_url = "https://llm.example.com/v1"
    /// api_key_env = "MY_GATEWAY_API_KEY"
    pub providers: BTreeMap<String, NamedProviderConfig>,

    /// Agent-specific model defaults
    pub agents: AgentsConfig,

    /// Terminal window/pane spawning configuration
    pub terminal: TerminalConfig,

    /// Lifecycle hooks (external commands at turn/session/tool boundaries)
    pub hooks: HooksConfig,

    /// Ambient mode configuration
    pub ambient: AmbientConfig,

    /// Safety / notification configuration
    pub safety: SafetyConfig,

    /// Desktop notifications for interactive sessions (e.g. turn completion)
    pub notifications: NotificationsConfig,

    /// WebSocket gateway configuration (for iOS/web clients)
    pub gateway: GatewayConfig,

    /// Compaction configuration
    pub compaction: CompactionConfig,

    /// Power-management configuration (prevent sleep while streaming)
    pub power: PowerConfig,

    /// macOS menu bar session indicator
    pub menubar: MenubarConfig,

    /// Auto-review configuration
    pub autoreview: AutoReviewConfig,

    /// Auto-judge configuration
    pub autojudge: AutoJudgeConfig,

    /// Partner discovery configuration. Skipped when it matches the shipped
    /// default so saving config never bakes today's default into the file (see
    /// [`sponsors_is_default`]).
    #[serde(skip_serializing_if = "sponsors_is_default")]
    pub sponsors: SponsorsConfig,

    /// Global "launch a new amiro" hotkeys (macOS). Baked once by auto-import.
    pub launch_hotkeys: LaunchHotkeysConfig,

    /// `[desktop.*]` tables owned by Amiro Desktop (voice, workspace,
    /// appearance, ...). The CLI never interprets them, but it must round-trip
    /// them verbatim so a CLI settings save never wipes Desktop preferences.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop: Option<toml::Table>,
}

/// Controls who owns autonomous wake execution.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WakeMode {
    /// The daemon starts idle turns and interrupts running turns itself.
    #[default]
    Internal,
    /// The daemon emits a wake request and leaves turn scheduling to its operator.
    External,
}

impl WakeMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "internal" => Some(Self::Internal),
            "external" => Some(Self::External),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// Ownership model for autonomous wake requests.
    pub wake_mode: WakeMode,
}

/// Agent Client Protocol adapter configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AcpConfig {
    /// Client compatibility profile: "standard" (default), "extended", or "full".
    pub profile: String,
    /// Tool profile to request when `amiro acp` starts a daemon itself.
    pub tool_profile: String,
}

impl Default for AcpConfig {
    fn default() -> Self {
        Self {
            profile: "standard".to_string(),
            tool_profile: "acp".to_string(),
        }
    }
}

/// Controls how MCP server tools are exposed to the model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpToolsMode {
    /// Never change the cached tool list for MCP changes. Providers with
    /// native deferred loading (Claude, OpenAI gpt-5.4+) get MCP tools as
    /// deferred definitions; others get the fixed `mcp_search`/`mcp_call`
    /// surface, with new tools described in the transcript.
    #[default]
    Auto,
    /// Always expose every MCP server tool as a top-level tool definition.
    /// Adding a server mid-session then invalidates the prompt cache.
    Eager,
    /// Same as `Auto` (kept for existing configs).
    Deferred,
}

impl McpToolsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Eager => "eager",
            Self::Deferred => "deferred",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "eager" => Some(Self::Eager),
            "deferred" => Some(Self::Deferred),
            _ => None,
        }
    }
}

/// Controls which tools are sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolConfig {
    /// Tool profile: "full" (default), "acp", "minimal"/"lite", or "none".
    pub profile: String,
    /// Explicit allow-list. When set, only these tools are exposed.
    /// Use "*" or "all" to expose all tools without an allow-list.
    pub enabled: Vec<String>,
    /// Tools to remove after applying profile/enabled.
    pub disabled: Vec<String>,
    /// Disable all built-in tools unless `enabled` is provided.
    pub disable_base_tools: bool,
    /// MCP tool exposure mode: auto (default), eager, or deferred.
    pub mcp_tools: McpToolsMode,
    /// Ignored. `auto` used to switch MCP exposure at this token estimate,
    /// which changed the cached tool list mid-session. Kept so existing
    /// configs and the env override still parse.
    #[serde(
        alias = "mcp_tools_threshold",
        alias = "mcp_tools_auto_threshold",
        alias = "mcp_tools_auto_threshold_tokens"
    )]
    pub mcp_tools_token_threshold: usize,
    /// Opt-in Codemode: expose a `codemode` tool that runs model-written
    /// JavaScript in an embedded QuickJS sandbox able to call every other
    /// tool (including MCP tools). Off by default.
    pub codemode: bool,
}

impl Default for ToolConfig {
    fn default() -> Self {
        Self {
            profile: String::new(),
            enabled: Vec::new(),
            disabled: Vec::new(),
            disable_base_tools: false,
            mcp_tools: McpToolsMode::Auto,
            mcp_tools_token_threshold: 8_000,
            codemode: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolSelection {
    pub allowed_tools: Option<HashSet<String>>,
    pub disabled_tools: HashSet<String>,
}

impl ToolConfig {
    pub fn selection(&self) -> ToolSelection {
        let mut allowed_tools = self.base_allowed_tools();
        let disabled_tools: HashSet<String> = self
            .disabled
            .iter()
            .map(|name| normalize_tool_name(name))
            .filter(|name| !name.is_empty())
            .collect();

        if let Some(allowed) = allowed_tools.as_mut() {
            for name in &disabled_tools {
                allowed.remove(name);
            }
        }

        ToolSelection {
            allowed_tools,
            disabled_tools,
        }
    }

    pub fn allowed_tools(&self) -> Option<HashSet<String>> {
        self.selection().allowed_tools
    }

    pub fn apply_to_allowed_set(&self, allowed: &mut HashSet<String>) {
        let selection = self.selection();
        if let Some(global_allowed) = selection.allowed_tools {
            allowed.retain(|name| global_allowed.contains(name));
        }
        for disabled in selection.disabled_tools {
            allowed.remove(&disabled);
        }
    }

    fn base_allowed_tools(&self) -> Option<HashSet<String>> {
        let (explicit, enables_all_tools) = self.normalized_enabled_tools();

        let profile = self.profile.trim().to_ascii_lowercase();
        if enables_all_tools {
            None
        } else if !explicit.is_empty() {
            Some(explicit)
        } else if self.disable_base_tools || matches!(profile.as_str(), "none" | "off" | "disabled")
        {
            Some(HashSet::new())
        } else if matches!(profile.as_str(), "acp") {
            Some(
                [
                    "bash",
                    "read",
                    "write",
                    "edit",
                    "replace",
                    "apply_patch",
                    "agentgrep",
                    "ls",
                    "batch",
                    "mcp",
                ]
                .into_iter()
                .map(|name| name.to_string())
                .collect(),
            )
        } else if matches!(profile.as_str(), "minimal" | "lite" | "small") {
            Some(
                [
                    "bash",
                    "read",
                    "write",
                    "edit",
                    "replace",
                    "apply_patch",
                    "agentgrep",
                    "ls",
                ]
                .into_iter()
                .map(|name| name.to_string())
                .collect(),
            )
        } else {
            None
        }
    }

    fn normalized_enabled_tools(&self) -> (HashSet<String>, bool) {
        let mut enabled = HashSet::new();
        let mut enables_all_tools = false;

        for name in &self.enabled {
            let normalized = normalize_tool_name(name);
            if normalized.is_empty() {
                continue;
            }
            if normalized == "*" || normalized.eq_ignore_ascii_case("all") {
                enables_all_tools = true;
            } else {
                enabled.insert(normalized);
            }
        }

        (enabled, enables_all_tools)
    }
}

fn normalize_tool_name(name: &str) -> String {
    let trimmed = name.trim().trim_matches('"');
    amiro_tool_types::resolve_tool_name(trimmed).to_string()
}

/// External dictation / speech-to-text integration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DictationConfig {
    /// Shell command to run. Must print the transcript to stdout.
    pub command: String,
    /// How to apply the resulting transcript.
    pub mode: crate::protocol::TranscriptMode,
    /// Optional in-app hotkey to trigger dictation.
    pub key: String,
    /// Maximum time to wait for the command to finish (0 = no timeout).
    pub timeout_secs: u64,
    /// Personal names or terms sent as recognition context to built-in voice
    /// transcription. Appended to the built-in vocabulary every user gets
    /// (Amiro names plus common coding agent terms), for this user only.
    pub vocabulary: Vec<String>,
    /// Built-in voice input: optional shell command that records the
    /// microphone and prints raw mono 16 kHz s16le PCM to stdout. Empty means
    /// auto-detect (pw-record, parecord, arecord, rec, ffmpeg).
    pub recorder: String,
    /// Keyboards `amiro companion` watches for Copilot-key push-to-talk
    /// (Linux evdev nodes, preferably stable `/dev/input/by-id/...` paths).
    /// Empty disables the companion's global voice listener.
    pub global_devices: Vec<std::path::PathBuf>,
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            mode: crate::protocol::TranscriptMode::Send,
            key: "off".to_string(),
            timeout_secs: 90,
            vocabulary: Vec::new(),
            recorder: String::new(),
            global_devices: Vec::new(),
        }
    }
}

pub mod change_report;
mod config_file;
mod default_file;
mod display_summary;
mod env_overrides;

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "config_color_tests.rs"]
mod color_tests;

/// Whether integration discovery settings carry no information beyond the shipped
/// default, so `[sponsors]` can be left out of written config files.
///
/// Discovery originally shipped opt-in with `enabled = false`, and because
/// config saves serialize the whole struct, any save during that window froze
/// the old default into the user's file and permanently disabled discovery even
/// after the default flipped. Omitting default sections prevents a repeat.
fn sponsors_is_default(sponsors: &SponsorsConfig) -> bool {
    sponsors.enabled && is_default_discovery_endpoint(&sponsors.endpoint)
}

/// Endpoints used by shipped defaults. These may also be explicit user choices.
fn is_default_discovery_endpoint(endpoint: &str) -> bool {
    matches!(
        endpoint.trim_end_matches('/'),
        "https://api.jcode.sh/v1/discovery" | "https://api.solosystems.dev/v1/discovery"
    )
}
