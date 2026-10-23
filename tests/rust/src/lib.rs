//! amiro-testkit: std-only test harness and real file/binary verifier for Amiro.
//!
//! This crate contains offline verification tools, real file inspections,
//! and binary integration tests for Amiro components without external dependencies.

use std::fs;
use std::path::{Path, PathBuf};

/// Resolve an environment variable through a fallback chain.
/// Given a lookup function and a slice of key names in priority order,
/// returns the first non-empty value found.
pub fn resolve_env_chain<F>(lookup: F, chain: &[&str]) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    for key in chain {
        if let Some(val) = lookup(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Resolve the workspace directory following Amiro configuration precedence:
/// 1. AMIRO_WORKSPACE_DIR
/// 2. AMIRO_HOME/workspace
/// 3. Default fallback directory
pub fn resolve_workspace_dir<F>(lookup: F, default_dir: &str) -> String
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(dir) = lookup("AMIRO_WORKSPACE_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(home) = lookup("AMIRO_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return format!("{}/workspace", trimmed.trim_end_matches('/'));
        }
    }
    default_dir.to_string()
}

/// Find the repository root by locating the root Cargo.toml / package.json / .git.
pub fn find_repo_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut current = manifest_dir;
    while let Some(parent) = current.parent() {
        if parent.join("package.json").exists() && parent.join("clients/desktop").exists() {
            return parent.to_path_buf();
        }
        current = parent;
    }
    // Fallback: manifest_dir is tests/rust, so parent-parent is repo root.
    manifest_dir.join("../..").canonicalize().unwrap_or_else(|_| manifest_dir.join("../.."))
}

/// Scan directory recursively for files with a specific extension,
/// skipping ignored directories (e.g., node_modules, target, .git, runtime).
pub fn find_files_with_extension(
    dir: &Path,
    ext: &str,
    skip_dirs: &[&str],
) -> Vec<PathBuf> {
    let mut matches = Vec::new();
    if !dir.is_dir() {
        return matches;
    }

    let mut stack = vec![dir.to_path_buf()];
    while let Some(current_dir) = stack.pop() {
        let read_dir = match fs::read_dir(&current_dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !skip_dirs.contains(&name) {
                    stack.push(path);
                }
            } else if path.is_file() {
                if let Some(file_ext) = path.extension().and_then(|e| e.to_str()) {
                    if file_ext == ext {
                        matches.push(path);
                    }
                }
            }
        }
    }
    matches
}

/// Inspection information about the real adapter entry point.
#[derive(Debug, PartialEq, Eq)]
pub struct AdapterContractSummary {
    pub file_exists: bool,
    pub references_amiro_port: bool,
    pub references_amiro_token: bool,
    pub references_auth_module: bool,
    pub health_endpoint_defined: bool,
}

/// Inspect the real `adapter/src/server.mjs` and related adapter files on disk.
pub fn inspect_adapter_server(repo_root: &Path) -> Result<AdapterContractSummary, std::io::Error> {
    let server_path = repo_root.join("adapter/src/server.mjs");
    let auth_path = repo_root.join("adapter/src/auth.mjs");
    if !server_path.is_file() {
        return Ok(AdapterContractSummary {
            file_exists: false,
            references_amiro_port: false,
            references_amiro_token: false,
            references_auth_module: false,
            health_endpoint_defined: false,
        });
    }

    let server_content = fs::read_to_string(&server_path)?;
    let auth_content = if auth_path.is_file() {
        fs::read_to_string(&auth_path)?
    } else {
        String::new()
    };

    Ok(AdapterContractSummary {
        file_exists: true,
        references_amiro_port: server_content.contains("AMIRO_PORT"),
        references_amiro_token: server_content.contains("AMIRO_TOKEN"),
        references_auth_module: server_content.contains("./auth.mjs"),
        health_endpoint_defined: auth_content.contains("'/health'") || auth_content.contains("\"/health\""),
    })
}

/// Inspection information about Tauri configuration on disk.
#[derive(Debug, PartialEq, Eq)]
pub struct TauriContractSummary {
    pub cargo_toml_exists: bool,
    pub lib_name: Option<String>,
    pub package_license: Option<String>,
    pub main_calls_lib: bool,
}

/// Inspect the real `clients/desktop` files on disk.
pub fn inspect_tauri_contract(repo_root: &Path) -> Result<TauriContractSummary, std::io::Error> {
    let cargo_path = repo_root.join("clients/desktop/Cargo.toml");
    let main_path = repo_root.join("clients/desktop/src/main.rs");

    let cargo_content = if cargo_path.is_file() {
        Some(fs::read_to_string(&cargo_path)?)
    } else {
        None
    };

    let main_content = if main_path.is_file() {
        Some(fs::read_to_string(&main_path)?)
    } else {
        None
    };

    let mut lib_name = None;
    let mut package_license = None;

    if let Some(content) = cargo_content {
        let mut in_lib = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                in_lib = trimmed == "[lib]";
            } else if in_lib && trimmed.starts_with("name") {
                if let Some(val) = trimmed.split('=').nth(1) {
                    lib_name = Some(val.trim().trim_matches('"').to_string());
                }
            } else if trimmed.starts_with("license") {
                if let Some(val) = trimmed.split('=').nth(1) {
                    package_license = Some(val.trim().trim_matches('"').to_string());
                }
            }
        }
    }

    let main_calls_lib = match (&main_content, &lib_name) {
        (Some(main_str), Some(name)) => {
            let expected_call = format!("{}::run()", name);
            main_str.contains(&expected_call)
        }
        _ => false,
    };

    Ok(TauriContractSummary {
        cargo_toml_exists: cargo_path.is_file(),
        lib_name,
        package_license,
        main_calls_lib,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_env_fallback_chains() {
        let mut env = HashMap::new();
        env.insert("FALLBACK_B".to_string(), "val_b".to_string());
        env.insert("FALLBACK_C".to_string(), "val_c".to_string());

        let lookup = |k: &str| env.get(k).cloned();

        let chain = &["PRIMARY", "FALLBACK_A", "FALLBACK_B", "FALLBACK_C"];
        let resolved = resolve_env_chain(lookup, chain);
        assert_eq!(resolved, Some("val_b".to_string()));

        let empty_chain = &["MISSING_1", "MISSING_2"];
        assert_eq!(resolve_env_chain(lookup, empty_chain), None);
    }

    #[test]
    fn test_resolve_workspace_dir() {
        let empty_env = HashMap::<String, String>::new();
        assert_eq!(
            resolve_workspace_dir(|k| empty_env.get(k).cloned(), "/var/fallback"),
            "/var/fallback"
        );

        let mut home_env = HashMap::new();
        home_env.insert("AMIRO_HOME".to_string(), "/root/.amiro".to_string());
        assert_eq!(
            resolve_workspace_dir(|k| home_env.get(k).cloned(), "/var/fallback"),
            "/root/.amiro/workspace"
        );

        let mut explicit_env = HashMap::new();
        explicit_env.insert("AMIRO_HOME".to_string(), "/root/.amiro".to_string());
        explicit_env.insert("AMIRO_WORKSPACE_DIR".to_string(), "/custom/workspace".to_string());
        assert_eq!(
            resolve_workspace_dir(|k| explicit_env.get(k).cloned(), "/var/fallback"),
            "/custom/workspace"
        );
    }

    #[test]
    fn test_repo_root_discovery() {
        let root = find_repo_root();
        assert!(root.is_dir());
        assert!(root.join("package.json").exists());
        assert!(root.join("clients/desktop").exists());
    }

    #[test]
    fn test_inspect_real_adapter_server() {
        let root = find_repo_root();
        let summary = inspect_adapter_server(&root).expect("failed to inspect adapter server");
        assert!(summary.file_exists, "adapter/src/server.mjs must exist");
        assert!(summary.references_amiro_port, "adapter/src/server.mjs must reference AMIRO_PORT");
        assert!(summary.references_amiro_token, "adapter/src/server.mjs must reference AMIRO_TOKEN");
        assert!(summary.references_auth_module, "adapter/src/server.mjs must reference auth module");
        assert!(summary.health_endpoint_defined, "adapter/src/auth.mjs must define /health route");
    }

    #[test]
    fn test_inspect_real_tauri_contract() {
        let root = find_repo_root();
        let summary = inspect_tauri_contract(&root).expect("failed to inspect tauri contract");
        assert!(summary.cargo_toml_exists, "clients/desktop/Cargo.toml must exist");
        assert_eq!(summary.lib_name.as_deref(), Some("amiro_desktop"), "Tauri lib must be amiro_desktop");
        assert_eq!(summary.package_license.as_deref(), Some("MIT"), "Tauri Cargo.toml must have license MIT");
        assert!(summary.main_calls_lib, "main.rs must invoke amiro_desktop::run()");
    }
}
