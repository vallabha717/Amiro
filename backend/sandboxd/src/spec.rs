//! The one place an agent container's Docker spec is built.
//!
//! Every hardening field lives in [`container_spec`] so a unit test can assert
//! all of them. Nothing here is taken from a request: the image, user, mount,
//! limits, network and OCI runtime come only from the supervisor's environment.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Where the agent's folder appears inside its container.
pub const AGENT_HOME: &str = "/home/agent";
/// Label keys on every container the supervisor owns.
pub const LABEL_NAMESPACE: &str = "amiro.sandbox.namespace";
pub const LABEL_AGENT: &str = "amiro.sandbox.agentId";
pub const LABEL_SPEC: &str = "amiro.sandbox.specHash";

/// Docker refuses `Memory` below 6 MiB; a shell needs far more.
const MIN_MEMORY_BYTES: i64 = 64 * 1024 * 1024;

/// Supervisor settings, read once at start-up.
#[derive(Debug, Clone, PartialEq)]
pub struct SandboxConfig {
    /// Prefix of container names and the namespace label.
    pub namespace: String,
    pub image: String,
    /// `uid:gid` the container runs as. Never 0.
    pub uid: u32,
    pub gid: u32,
    /// Host path holding one folder per agent (`~/.amiro/agents`).
    pub agents_root: String,
    /// The main agent's own workspace (`~/.amiro/workspace`), mounted for
    /// the `main` desktop container so the TV shows the files Amiro works on.
    /// Empty means `workspace` next to the agents root.
    pub main_workspace: String,
    pub memory_bytes: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
    /// `bridge` (default) or `none`.
    pub network: String,
    /// OCI runtime, e.g. `runsc` for gVisor. `None` is Docker's default.
    pub runtime: Option<String>,
    /// `no-new-privileges`. On by default; snap-packaged Docker's AppArmor
    /// profile refuses every exec under it, so `scripts/sandbox.sh` turns it
    /// off there and the self-check reports it.
    pub no_new_privileges: bool,
}

impl SandboxConfig {
    /// Defaults for everything except the user and the agents root, which have
    /// no safe default.
    pub fn new(uid: u32, gid: u32, agents_root: impl Into<String>) -> Self {
        SandboxConfig {
            namespace: "amiro".into(),
            image: "amiro-agent:local".into(),
            uid,
            gid,
            agents_root: agents_root.into(),
            main_workspace: String::new(),
            memory_bytes: 1024 * 1024 * 1024,
            nano_cpus: 1_000_000_000,
            // The desktop (Xtigervnc, Chromium, Thunar, a terminal) needs ~300 threads.
            pids_limit: 1024,
            network: "bridge".into(),
            runtime: None,
            no_new_privileges: true,
        }
    }

    /// Read `AMIRO_SANDBOX_*` through `get` (the process environment in the
    /// binary, a map in tests). Refuses anything unsafe or malformed.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let var = |name: &str| get(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let user = var("AMIRO_SANDBOX_USER").ok_or("AMIRO_SANDBOX_USER (uid:gid) is required")?;
        let (uid, gid) = parse_user(&user)?;
        let root = var("AMIRO_SANDBOX_AGENTS_ROOT").ok_or("AMIRO_SANDBOX_AGENTS_ROOT is required")?;
        if !root.starts_with('/') || root.split('/').any(|part| part == "..") {
            return Err("AMIRO_SANDBOX_AGENTS_ROOT must be an absolute path without '..'".into());
        }
        let mut cfg = SandboxConfig::new(uid, gid, root.trim_end_matches('/'));
        if let Some(main) = var("AMIRO_SANDBOX_MAIN_WORKSPACE") {
            if !main.starts_with('/') || main.split('/').any(|part| part == "..") {
                return Err("AMIRO_SANDBOX_MAIN_WORKSPACE must be an absolute path without '..'".into());
            }
            cfg.main_workspace = main.trim_end_matches('/').to_string();
        }
        if let Some(ns) = var("AMIRO_SANDBOX_NAMESPACE") {
            if ns.len() > 32 || !ns.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
                return Err("AMIRO_SANDBOX_NAMESPACE must be up to 32 of a-z, 0-9 and '-'".into());
            }
            cfg.namespace = ns;
        }
        if let Some(image) = var("AMIRO_SANDBOX_IMAGE") {
            cfg.image = image;
        }
        if let Some(raw) = var("AMIRO_SANDBOX_MEMORY_MB") {
            let mb: i64 = raw.parse().map_err(|_| "AMIRO_SANDBOX_MEMORY_MB must be a whole number")?;
            cfg.memory_bytes = mb.saturating_mul(1024 * 1024);
            if cfg.memory_bytes < MIN_MEMORY_BYTES {
                return Err("AMIRO_SANDBOX_MEMORY_MB must be at least 64".into());
            }
        }
        if let Some(raw) = var("AMIRO_SANDBOX_CPUS") {
            let cpus: f64 = raw.parse().map_err(|_| "AMIRO_SANDBOX_CPUS must be a number like 1 or 0.5")?;
            if !(0.1..=64.0).contains(&cpus) {
                return Err("AMIRO_SANDBOX_CPUS must be between 0.1 and 64".into());
            }
            cfg.nano_cpus = (cpus * 1e9) as i64;
        }
        if let Some(raw) = var("AMIRO_SANDBOX_PIDS") {
            let pids: i64 = raw.parse().map_err(|_| "AMIRO_SANDBOX_PIDS must be a whole number")?;
            if !(16..=32768).contains(&pids) {
                return Err("AMIRO_SANDBOX_PIDS must be between 16 and 32768".into());
            }
            cfg.pids_limit = pids;
        }
        if let Some(network) = var("AMIRO_SANDBOX_NETWORK") {
            if network != "bridge" && network != "none" {
                return Err("AMIRO_SANDBOX_NETWORK must be 'bridge' or 'none'".into());
            }
            cfg.network = network;
        }
        if let Some(runtime) = var("AMIRO_SANDBOX_RUNTIME") {
            if !runtime.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                return Err("AMIRO_SANDBOX_RUNTIME must be a runtime name such as runsc".into());
            }
            cfg.runtime = Some(runtime);
        }
        if let Some(raw) = var("AMIRO_SANDBOX_NO_NEW_PRIVILEGES") {
            cfg.no_new_privileges = match raw.as_str() {
                "true" | "1" => true,
                "false" | "0" => false,
                _ => return Err("AMIRO_SANDBOX_NO_NEW_PRIVILEGES must be true or false".into()),
            };
        }
        Ok(cfg)
    }

    /// The host folder mounted at /home/agent for one agent: the main
    /// agent's workspace for `main`, else `<agents root>/<id>`.
    pub fn agent_folder(&self, agent_id: &str) -> String {
        if agent_id == "main" {
            if !self.main_workspace.is_empty() {
                return self.main_workspace.clone();
            }
            if let Some((parent, _)) = self.agents_root.rsplit_once('/') {
                if !parent.is_empty() {
                    return format!("{parent}/workspace");
                }
            }
        }
        format!("{}/{agent_id}", self.agents_root)
    }

    /// The container name for one agent.
    pub fn container_name(&self, agent_id: &str) -> String {
        format!("{}-agent-{agent_id}", self.namespace)
    }
}

fn parse_user(raw: &str) -> Result<(u32, u32), String> {
    let (uid, gid) = raw.split_once(':').ok_or("AMIRO_SANDBOX_USER must look like 1000:1000")?;
    let uid: u32 = uid.parse().map_err(|_| "AMIRO_SANDBOX_USER uid must be a number")?;
    let gid: u32 = gid.parse().map_err(|_| "AMIRO_SANDBOX_USER gid must be a number")?;
    if uid == 0 || gid == 0 {
        return Err("agent containers never run as root: AMIRO_SANDBOX_USER must not be 0".into());
    }
    Ok((uid, gid))
}

/// The Docker `POST /containers/create` body for `agent_id`, labelled with the
/// hash of everything else so a changed setting replaces the container.
pub fn container_spec(cfg: &SandboxConfig, agent_id: &str) -> Value {
    let mut spec = base_spec(cfg, agent_id);
    let hash = spec_hash(&spec);
    spec["Labels"][LABEL_SPEC] = Value::String(hash);
    spec
}

/// Hash of a spec without its own hash label.
pub fn spec_hash(spec: &Value) -> String {
    let mut spec = spec.clone();
    if let Some(labels) = spec.get_mut("Labels").and_then(Value::as_object_mut) {
        labels.remove(LABEL_SPEC);
    }
    hex::encode(Sha256::digest(spec.to_string().as_bytes()))[..16].to_string()
}

/// Where else the agent's folder may appear inside its container: at its own
/// host path, so its desktop (Files, the terminal) shows where it really is.
/// `None` when that path would shadow part of the container's system or its
/// tmpfs, or is already /home/agent.
pub fn mirror_target(folder: &str) -> Option<&str> {
    const SYSTEM: [&str; 14] = [
        "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/run", "/sbin", "/sys", "/tmp", "/usr",
        "/var",
    ];
    let shadows = |root: &str| folder == root || folder.starts_with(&format!("{root}/"));
    let ok = folder.starts_with('/')
        && folder.len() > 1
        && !folder.split('/').any(|part| part == "..")
        && folder != AGENT_HOME
        && !folder.starts_with(&format!("{AGENT_HOME}/"))
        && !AGENT_HOME.starts_with(&format!("{folder}/"))
        && !SYSTEM.iter().any(|root| shadows(root));
    ok.then_some(folder)
}

fn base_spec(cfg: &SandboxConfig, agent_id: &str) -> Value {
    let folder = cfg.agent_folder(agent_id);
    let mount = |target: &str| {
        json!({
            "Type": "bind",
            "Source": folder,
            "Target": target,
            "ReadOnly": false,
            "BindOptions": {"Propagation": "rprivate"}
        })
    };
    // Only this agent's folder is mounted. `bind` (not `Binds`) so Docker
    // refuses a missing folder instead of creating one as root. It appears at
    // /home/agent (what the agent's tools use) and, when safe, at its own host
    // path too, so the desktop shows the folder where it really is.
    let mut mounts = vec![mount(AGENT_HOME)];
    if let Some(target) = mirror_target(&folder) {
        mounts.push(mount(target));
    }
    let mut host = json!({
        "Mounts": mounts,
        "CapDrop": ["ALL"],
        "SecurityOpt": if cfg.no_new_privileges { json!(["no-new-privileges:true"]) } else { json!([]) },
        "Privileged": false,
        "ReadonlyRootfs": true,
        "Tmpfs": {
            "/tmp": "rw,nosuid,nodev,exec,size=256m",
            "/dev/shm": "rw,nosuid,nodev,size=256m"
        },
        // Memory and MemorySwap together: an unset MemorySwap lets the
        // container swap up to twice Memory.
        "Memory": cfg.memory_bytes,
        "MemorySwap": cfg.memory_bytes,
        "NanoCpus": cfg.nano_cpus,
        "PidsLimit": cfg.pids_limit,
        "NetworkMode": cfg.network,
        "Init": true,
        "RestartPolicy": {"Name": "no"},
    });
    if let Some(runtime) = &cfg.runtime {
        host["Runtime"] = Value::String(runtime.clone());
    }
    json!({
        "Image": cfg.image,
        "User": format!("{}:{}", cfg.uid, cfg.gid),
        "Cmd": ["sleep", "infinity"],
        "WorkingDir": AGENT_HOME,
        // No credential, token or key: nothing in the container calls back.
        "Env": [format!("HOME={AGENT_HOME}"), format!("AMIRO_AGENT_ID={agent_id}")],
        "NetworkDisabled": cfg.network == "none",
        "Labels": {
            LABEL_NAMESPACE: cfg.namespace,
            LABEL_AGENT: agent_id,
        },
        "HostConfig": host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key| map.get(key).cloned()
    }

    fn cfg() -> SandboxConfig {
        SandboxConfig::new(1001, 1002, "/home/owner/.amiro/agents")
    }

    #[test]
    fn spec_carries_every_hardening_field() {
        let spec = container_spec(&cfg(), ID);
        let host = &spec["HostConfig"];
        assert_eq!(spec["User"], "1001:1002");
        assert_eq!(host["CapDrop"], json!(["ALL"]));
        assert!(host.get("CapAdd").is_none());
        assert_eq!(host["SecurityOpt"], json!(["no-new-privileges:true"]));
        assert_eq!(host["Privileged"], false);
        assert_eq!(host["ReadonlyRootfs"], true);
        assert_eq!(host["Memory"], 1024 * 1024 * 1024);
        assert_eq!(host["MemorySwap"], host["Memory"]);
        assert_eq!(host["NanoCpus"], 1_000_000_000);
        assert_eq!(host["PidsLimit"], 1024);
        assert_eq!(host["NetworkMode"], "bridge");
        assert!(host.get("Runtime").is_none());
        assert!(host.get("Binds").is_none());
        assert!(host.get("Devices").is_none());
        assert!(host.get("PortBindings").is_none());
        let mounts = host["Mounts"].as_array().unwrap();
        let folder = format!("/home/owner/.amiro/agents/{ID}");
        assert!(
            mounts.iter().all(|m| m["Source"] == folder.as_str() && m["Type"] == "bind"),
            "only the agent's own folder is mounted: {mounts:?}"
        );
        assert_eq!(mounts[0]["Target"], AGENT_HOME);
        assert_eq!(mounts[1]["Target"], folder.as_str(), "and at its own path, for the desktop");
        assert_eq!(mounts.len(), 2);
        // The main agent's desktop shows its own workspace, not an agents/ folder.
        let main = container_spec(&cfg(), "main");
        assert_eq!(main["HostConfig"]["Mounts"][0]["Source"], "/home/owner/.amiro/workspace");
        let mut moved = cfg();
        moved.main_workspace = "/srv/amiro/workspace".into();
        assert_eq!(container_spec(&moved, "main")["HostConfig"]["Mounts"][0]["Source"], "/srv/amiro/workspace");
        assert_eq!(moved.agent_folder(ID), format!("/home/owner/.amiro/agents/{ID}"));
        let env = spec["Env"].as_array().unwrap();
        assert!(env.iter().all(|e| {
            let e = e.as_str().unwrap();
            !e.contains("TOKEN") && !e.contains("MASTER") && !e.contains("CREDENTIAL")
        }));
        assert_eq!(spec["Labels"][LABEL_AGENT], ID);
        assert_eq!(spec["Labels"][LABEL_SPEC].as_str().unwrap().len(), 16);
    }

    #[test]
    fn the_folder_is_mirrored_at_its_own_path_only_where_that_is_safe() {
        assert_eq!(mirror_target("/home/owner/.amiro/workspace"), Some("/home/owner/.amiro/workspace"));
        assert_eq!(mirror_target("/srv/amiro/agents/x"), Some("/srv/amiro/agents/x"));
        for unsafe_path in [
            "/", "/home/agent", "/home/agent/x", "/home", "/tmp/amiro/workspace", "/etc/amiro", "/usr/local/x",
            "/proc/1", "/var/lib/amiro", "relative/path", "/home/o/../etc",
        ] {
            assert_eq!(mirror_target(unsafe_path), None, "{unsafe_path}");
        }
        let mut c = cfg();
        c.agents_root = "/tmp/amiro/agents".into();
        assert_eq!(container_spec(&c, ID)["HostConfig"]["Mounts"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_changed_setting_changes_the_spec_hash() {
        let a = container_spec(&cfg(), ID);
        let mut other = cfg();
        other.network = "none".into();
        let b = container_spec(&other, ID);
        assert_ne!(a["Labels"][LABEL_SPEC], b["Labels"][LABEL_SPEC]);
        assert_eq!(b["HostConfig"]["NetworkMode"], "none");
        assert_eq!(b["NetworkDisabled"], true);
        assert_eq!(spec_hash(&a), a["Labels"][LABEL_SPEC].as_str().unwrap());
    }

    #[test]
    fn no_new_privileges_is_on_unless_turned_off() {
        let mut c = cfg();
        c.no_new_privileges = false;
        assert_eq!(container_spec(&c, ID)["HostConfig"]["SecurityOpt"], json!([]));
        let base = [("AMIRO_SANDBOX_AGENTS_ROOT", "/a"), ("AMIRO_SANDBOX_USER", "1:1")];
        assert!(SandboxConfig::from_lookup(lookup(&base)).unwrap().no_new_privileges);
        let off = [base[0], base[1], ("AMIRO_SANDBOX_NO_NEW_PRIVILEGES", "false")];
        assert!(!SandboxConfig::from_lookup(lookup(&off)).unwrap().no_new_privileges);
        let bad = [base[0], base[1], ("AMIRO_SANDBOX_NO_NEW_PRIVILEGES", "maybe")];
        assert!(SandboxConfig::from_lookup(lookup(&bad)).is_err());
    }

    #[test]
    fn runsc_is_passed_through_when_asked() {
        let mut c = cfg();
        c.runtime = Some("runsc".into());
        assert_eq!(container_spec(&c, ID)["HostConfig"]["Runtime"], "runsc");
    }

    #[test]
    fn config_refuses_root_and_bad_values() {
        let base = [("AMIRO_SANDBOX_AGENTS_ROOT", "/home/o/.amiro/agents")];
        assert!(SandboxConfig::from_lookup(lookup(&base)).is_err(), "user is required");
        for user in ["0:0", "0:1000", "1000:0", "root", "1000"] {
            let pairs = [base[0], ("AMIRO_SANDBOX_USER", user)];
            assert!(SandboxConfig::from_lookup(lookup(&pairs)).is_err(), "{user} accepted");
        }
        let ok = [base[0], ("AMIRO_SANDBOX_USER", "1000:1000")];
        let cfg = SandboxConfig::from_lookup(lookup(&ok)).unwrap();
        assert_eq!((cfg.uid, cfg.gid), (1000, 1000));
        for (key, value) in [
            ("AMIRO_SANDBOX_NETWORK", "host"),
            ("AMIRO_SANDBOX_MEMORY_MB", "8"),
            ("AMIRO_SANDBOX_PIDS", "0"),
            ("AMIRO_SANDBOX_CPUS", "1000"),
            ("AMIRO_SANDBOX_RUNTIME", "runsc --debug"),
            ("AMIRO_SANDBOX_NAMESPACE", "Bad Name"),
            ("AMIRO_SANDBOX_AGENTS_ROOT", "relative/agents"),
        ] {
            let pairs = [ok[0], ok[1], (key, value)];
            assert!(SandboxConfig::from_lookup(lookup(&pairs)).is_err(), "{key}={value} accepted");
        }
        let pairs = [ok[0], ok[1], ("AMIRO_SANDBOX_NETWORK", "none"), ("AMIRO_SANDBOX_RUNTIME", "runsc")];
        let cfg = SandboxConfig::from_lookup(lookup(&pairs)).unwrap();
        assert_eq!(cfg.network, "none");
        assert_eq!(cfg.runtime.as_deref(), Some("runsc"));
    }
}
