//! Startup configuration from files: `.env` and `amiro.toml`.
//!
//! Everything Amiro reads at startup is an environment variable
//! (`AMIRO_PORT`, `AMIRO_OWNER_EMAIL`, ...). This module lets the same
//! settings come from files, so a VM or a desktop install can be set up
//! without the onboarding UI:
//!
//! 1. The process environment always wins.
//! 2. `.env` files: `AMIRO_ENV_FILE`, then `./.env`, then `$AMIRO_HOME/.env`.
//!    The first file to set a key wins.
//! 3. `amiro.toml`: `AMIRO_CONFIG` or `--config <path>`, else `./amiro.toml`,
//!    else `$AMIRO_HOME/amiro.toml`. Its values are mapped onto the same
//!    environment variables (see [`TOML_KEYS`]), again never overriding one
//!    that is already set.
//!
//! [`apply`] must run before any thread is spawned: it calls
//! `std::env::set_var`.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// `[section] key` in amiro.toml → environment variable.
pub const TOML_KEYS: &[(&str, &str, &str)] = &[
    ("server", "host", "AMIRO_HOST"),
    ("server", "port", "AMIRO_PORT"),
    ("server", "token", "AMIRO_TOKEN"),
    ("server", "allowed_origin", "AMIRO_ALLOWED_ORIGIN"),
    ("server", "home", "AMIRO_HOME"),
    ("server", "session_ttl_days", "AMIRO_SESSION_TTL_DAYS"),
    ("owner", "email", "AMIRO_OWNER_EMAIL"),
    ("owner", "password", "AMIRO_OWNER_PASSWORD"),
    ("owner", "password_file", "AMIRO_OWNER_PASSWORD_FILE"),
    ("owner", "name", "AMIRO_OWNER_NAME"),
    ("owner", "timezone", "AMIRO_OWNER_TIMEZONE"),
    ("agent", "name", "AMIRO_AGENT_NAME"),
    ("agent", "avatar", "AMIRO_AGENT_AVATAR"),
    ("agent", "color", "AMIRO_AGENT_COLOR"),
    ("agent", "default_model", "AMIRO_DEFAULT_MODEL"),
    ("notify", "decision_model", "AMIRO_NOTIFY_DECISION_MODEL"),
    ("providers", "anthropic_api_key", "ANTHROPIC_API_KEY"),
    ("providers", "openai_api_key", "OPENAI_API_KEY"),
    ("providers", "openrouter_api_key", "OPENROUTER_API_KEY"),
    ("providers", "gemini_api_key", "GEMINI_API_KEY"),
    ("providers", "openai_compat_api_base", "AMIRO_OPENAI_COMPAT_API_BASE"),
    ("onboarding", "skip", "AMIRO_SKIP_ONBOARDING"),
];

/// amiro.toml sections other modules parse themselves.
const OWNED_ELSEWHERE: &[&str] = &["composio"];

/// Where each setting came from, for the onboarding wizard ("set in
/// amiro.toml"). Never holds values, only variable names and file paths.
#[derive(Debug, Default, Clone)]
pub struct Loaded {
    pub env_files: Vec<PathBuf>,
    pub toml_file: Option<PathBuf>,
    /// Variable name → "env" | ".env" | "amiro.toml".
    pub sources: Vec<(String, &'static str)>,
    pub errors: Vec<String>,
}

impl Loaded {
    pub fn source_of(&self, var: &str) -> Option<&'static str> {
        self.sources
            .iter()
            .find(|(name, _)| name == var)
            .map(|(_, source)| *source)
    }

    pub fn summary(&self) -> Value {
        json!({
            "envFiles": self.env_files.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
            "tomlFile": self.toml_file.as_ref().map(|p| p.display().to_string()),
            "errors": self.errors,
        })
    }
}

static LOADED: std::sync::OnceLock<Loaded> = std::sync::OnceLock::new();

/// What [`apply`] loaded; empty when it never ran (tests, the library).
pub fn loaded() -> Loaded {
    LOADED.get().cloned().unwrap_or_default()
}

/// Parse one `.env` file: `KEY=value`, optional `export `, `#` comments,
/// single or double quotes (double quotes understand `\n`, `\"`, `\\`).
pub fn parse_env(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || key.starts_with(|c: char| c.is_ascii_digit())
        {
            continue;
        }
        let value = value.trim();
        let value = if let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"'))
        {
            let mut s = String::with_capacity(inner.len());
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => s.push('\n'),
                        Some('t') => s.push('\t'),
                        Some(other) => s.push(other),
                        None => s.push('\\'),
                    }
                } else {
                    s.push(c);
                }
            }
            s
        } else if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
            inner.to_string()
        } else {
            // Unquoted: drop a trailing ` # comment`.
            match value.find(" #") {
                Some(index) => value[..index].trim_end().to_string(),
                None => value.to_string(),
            }
        };
        out.push((key.to_string(), value));
    }
    out
}

/// Flatten amiro.toml into `(ENV_VAR, value)` pairs using [`TOML_KEYS`],
/// plus a free-form `[env]` table copied verbatim. Unknown keys are errors
/// so a typo does not silently do nothing.
pub fn parse_toml(text: &str) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    let doc: toml::Table = text.parse().map_err(|e: toml::de::Error| e.to_string())?;
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    for (section, value) in &doc {
        let Some(table) = value.as_table() else {
            warnings.push(format!("amiro.toml: `{section}` should be a [section]"));
            continue;
        };
        // Read by their own modules (composio_config.rs reads [composio]).
        if OWNED_ELSEWHERE.contains(&section.as_str()) {
            continue;
        }
        if section == "env" {
            for (key, value) in table {
                if let Some(text) = scalar(value) {
                    out.push((key.clone(), text));
                }
            }
            continue;
        }
        for (key, value) in table {
            let Some((_, _, var)) = TOML_KEYS
                .iter()
                .find(|(s, k, _)| s == section && k == key)
            else {
                warnings.push(format!("amiro.toml: unknown setting [{section}] {key}"));
                continue;
            };
            match scalar(value) {
                Some(text) => out.push(((*var).to_string(), text)),
                None => warnings.push(format!("amiro.toml: [{section}] {key} must be a string, number or boolean")),
            }
        }
    }
    Ok((out, warnings))
}

fn scalar(value: &toml::Value) -> Option<String> {
    match value {
        toml::Value::String(s) => Some(s.clone()),
        toml::Value::Integer(n) => Some(n.to_string()),
        toml::Value::Float(n) => Some(n.to_string()),
        toml::Value::Boolean(b) => Some(if *b { "1" } else { "0" }.to_string()),
        _ => None,
    }
}

/// The user's home directory on every platform (`HOME`, else Windows'
/// `USERPROFILE`).
pub fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn amiro_home() -> PathBuf {
    std::env::var_os("AMIRO_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".amiro"))
}

fn set_if_unset(loaded: &mut Loaded, key: &str, value: &str, source: &'static str) {
    if std::env::var_os(key).is_some_and(|v| !v.is_empty()) {
        if loaded.source_of(key).is_none() {
            loaded.sources.push((key.to_string(), "env"));
        }
        return;
    }
    std::env::set_var(key, value);
    loaded.sources.push((key.to_string(), source));
}

/// Load `.env` files and `amiro.toml` into the process environment.
/// `config_arg` is a `--config <path>` from the command line.
pub fn apply(config_arg: Option<PathBuf>) -> Loaded {
    let mut loaded = Loaded::default();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    // .env first (they may set AMIRO_HOME / AMIRO_CONFIG themselves).
    let mut env_candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("AMIRO_ENV_FILE").filter(|v| !v.is_empty()) {
        env_candidates.push(PathBuf::from(path));
    }
    env_candidates.push(cwd.join(".env"));
    env_candidates.push(amiro_home().join(".env"));
    for path in env_candidates {
        if loaded.env_files.contains(&path) || !path.is_file() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                for (key, value) in parse_env(&text) {
                    set_if_unset(&mut loaded, &key, &value, ".env");
                }
                loaded.env_files.push(path);
            }
            Err(error) => loaded
                .errors
                .push(format!("{}: {error}", path.display())),
        }
    }

    let explicit = config_arg.or_else(|| {
        std::env::var_os("AMIRO_CONFIG")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let toml_path = match explicit {
        Some(path) => {
            if !path.is_file() {
                loaded
                    .errors
                    .push(format!("config file {} does not exist", path.display()));
            }
            Some(path)
        }
        None => [cwd.join("amiro.toml"), amiro_home().join("amiro.toml")]
            .into_iter()
            .find(|p| p.is_file()),
    };
    if let Some(path) = toml_path.filter(|p| p.is_file()) {
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| parse_toml(&text))
        {
            Ok((pairs, warnings)) => {
                for (key, value) in pairs {
                    set_if_unset(&mut loaded, &key, &expand_home(&value), "amiro.toml");
                }
                loaded.errors.extend(warnings);
                loaded.toml_file = Some(path);
            }
            Err(error) => loaded.errors.push(format!("{}: {error}", path.display())),
        }
    }
    for error in &loaded.errors {
        eprintln!("amiro config: {error}");
    }
    let _ = LOADED.set(loaded.clone());
    loaded
}

/// `~/x` → `<home>/x`, for path-valued settings such as `password_file`.
fn expand_home(value: &str) -> String {
    match value.strip_prefix("~/") {
        Some(rest) => user_home().join(rest).display().to_string(),
        None => value.to_string(),
    }
}

/// A commented starter amiro.toml (`amiro-backend init-config`).
pub const SAMPLE_TOML: &str = include_str!("../../amiro.example.toml");

/// Write [`SAMPLE_TOML`] to `path` unless something is already there.
pub fn write_sample(path: &Path) -> std::io::Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, SAMPLE_TOML)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_parsing_handles_quotes_comments_and_export() {
        let pairs = parse_env(
            "# c\nexport A=1\nB = \"two words\\n\"\nC='x # y'\nD=plain # note\n1BAD=x\nE\n",
        );
        assert_eq!(
            pairs,
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "two words\n".into()),
                ("C".into(), "x # y".into()),
                ("D".into(), "plain".into()),
            ]
        );
    }

    #[test]
    fn toml_maps_sections_to_env_and_flags_typos() {
        let (pairs, warnings) = parse_toml(
            "[composio]\napi_key = \"x\"\n[server]\nport = 3000\nhost = \"0.0.0.0\"\n[owner]\nemail = \"a@b.c\"\nemial = \"x\"\n[onboarding]\nskip = true\n[env]\nFOO = \"bar\"\n",
        )
        .unwrap();
        assert!(pairs.contains(&("AMIRO_PORT".into(), "3000".into())));
        assert!(pairs.contains(&("AMIRO_HOST".into(), "0.0.0.0".into())));
        assert!(pairs.contains(&("AMIRO_OWNER_EMAIL".into(), "a@b.c".into())));
        assert!(pairs.contains(&("AMIRO_SKIP_ONBOARDING".into(), "1".into())));
        assert!(pairs.contains(&("FOO".into(), "bar".into())));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("emial"));
    }

    #[test]
    fn the_sample_config_parses_cleanly() {
        let (_, warnings) = parse_toml(SAMPLE_TOML).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
    }
}
