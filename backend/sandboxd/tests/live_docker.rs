//! The boundary measured on a real Docker engine.
//!
//! Needs Docker on `DOCKER_SOCKET` (default `/var/run/docker.sock`) and the
//! agent image (`scripts/sandbox.sh up`, or
//! `docker build -t amiro-agent:local -f packaging/sandbox/agent.Dockerfile packaging/sandbox`).
//! Without them every test here prints why and returns: a reasoned skip, not
//! a pass. `AMIRO_SANDBOX_LIVE=require` turns the skip into a failure.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use axum::http::Method;
use axum::Router;
use common::{agent, MASTER, TOKEN};
use sandboxd::docker::Docker;
use sandboxd::server::{router, Supervisor};
use sandboxd::spec::SandboxConfig;
use serde_json::json;

struct Live {
    app: Router,
    docker: Docker,
    cfg: SandboxConfig,
    root: PathBuf,
    agents: Vec<String>,
}

impl Live {
    async fn cleanup(&self) {
        for id in &self.agents {
            let _ = self.docker.remove(&self.cfg.container_name(id)).await;
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn unique() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("{:032x}", nanos ^ ((std::process::id() as u128) << 96))
}

/// Snap-packaged Docker keeps its data under /var/snap.
fn snap_docker() -> bool {
    std::process::Command::new("docker")
        .args(["info", "--format", "{{.DockerRootDir}}"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("/snap/"))
        .unwrap_or(false)
}

fn current_ids() -> (u32, u32) {
    let id = |flag: &str| {
        let out = std::process::Command::new("id").arg(flag).output().expect("id");
        String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().expect("numeric id")
    };
    (id("-u"), id("-g"))
}

/// A supervisor on the real engine with `count` fresh agents, or `None` (with
/// the reason printed) when Docker or the image is not available.
async fn live(count: usize) -> Option<Live> {
    let required = std::env::var("AMIRO_SANDBOX_LIVE").as_deref() == Ok("require");
    let skip = |why: String| {
        assert!(!required, "AMIRO_SANDBOX_LIVE=require but {why}");
        eprintln!("SKIP live_docker: {why}");
        None
    };
    let socket = std::env::var("DOCKER_SOCKET").unwrap_or_else(|_| "/var/run/docker.sock".into());
    let docker = Docker::new(&socket);
    if !docker.ping().await {
        return skip(format!("Docker is not reachable at {socket}"));
    }
    let image = std::env::var("AMIRO_SANDBOX_IMAGE").unwrap_or_else(|_| "amiro-agent:local".into());
    let probe = std::process::Command::new("docker").args(["image", "inspect", &image]).output();
    if !probe.map(|o| o.status.success()).unwrap_or(false) {
        return skip(format!("image {image} is not built (scripts/sandbox.sh up)"));
    }
    let (uid, gid) = current_ids();
    if uid == 0 {
        return skip("tests run as root; agent containers never do".into());
    }
    // Under $HOME, not /tmp: snap-packaged Docker has a private /tmp.
    let home = std::env::var("HOME").expect("HOME");
    let root = PathBuf::from(home).join(".cache").join(format!("amiro-sandboxd-live-{}", unique()));
    let agents: Vec<String> = (0..count).map(|i| format!("{:x}{}", i, &unique()[1..])).collect();
    for id in &agents {
        std::fs::create_dir_all(root.join(id)).unwrap();
    }
    let mut cfg = SandboxConfig::new(uid, gid, root.to_string_lossy().to_string());
    cfg.namespace = "amirotest".into();
    cfg.image = image;
    cfg.memory_bytes = 256 * 1024 * 1024;
    // Same switch the script uses: snap Docker cannot exec under it.
    if std::env::var("AMIRO_SANDBOX_NO_NEW_PRIVILEGES").as_deref() == Ok("false") || snap_docker() {
        eprintln!("NOTE live_docker: snap-packaged Docker; testing without no-new-privileges");
        cfg.no_new_privileges = false;
    }
    let sup = Supervisor::new(cfg.clone(), docker.clone(), TOKEN.into(), MASTER.into()).unwrap();
    Some(Live { app: router(Arc::new(sup)), docker, cfg, root, agents })
}

#[tokio::test]
async fn container_runs_non_root_without_capabilities_and_sees_only_its_folder() {
    let Some(live) = live(1).await else { return };
    let id = &live.agents[0];
    let (status, check) = agent(&live.app, Method::GET, id, "selfcheck", None).await;
    let inspect = live.docker.inspect(&live.cfg.container_name(id)).await.unwrap();
    live.cleanup().await;
    assert_eq!(status, 200, "{check}");
    assert_eq!(check["uid"], json!(live.cfg.uid));
    assert_ne!(check["uid"], json!(0));
    assert_eq!(check["capEff"], "0000000000000000", "{check}");
    assert_eq!(check["noCapabilities"], true);
    assert_eq!(check["noNewPrivs"], live.cfg.no_new_privileges, "{check}");
    assert_eq!(check["dockerSocket"], false);
    assert_eq!(check["readOnlyRoot"], true);
    assert_eq!(check["homeWritable"], true);
    // Its own folder, at /home/agent and (for its desktop) at its host path.
    let mut expected = vec!["/home/agent".to_string()];
    if let Some(mirror) = sandboxd::spec::mirror_target(&live.cfg.agent_folder(id)) {
        if mirror.starts_with("/home/") {
            expected.push(mirror.to_string());
        }
    }
    let mut mounts: Vec<String> =
        check["homeMounts"].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_string()).collect();
    mounts.sort();
    expected.sort();
    assert_eq!(mounts, expected, "{check}");

    let host = &inspect.unwrap()["HostConfig"];
    assert_eq!(host["CapDrop"], json!(["ALL"]));
    assert_eq!(host["Privileged"], false);
    assert_eq!(host["PidsLimit"], 1024);
    assert_eq!(host["Memory"], 256 * 1024 * 1024);
}

#[tokio::test]
async fn files_round_trip_and_one_agent_cannot_see_anothers() {
    let Some(live) = live(2).await else { return };
    let (a, b) = (&live.agents[0], &live.agents[1]);
    let secret = format!("only-for-a-{}", unique());
    let big = "0123456789abcdef".repeat(20 * 1024); // 320 KiB: several write chunks
    let results = async {
        let w = agent(&live.app, Method::POST, a, "files/write", Some(json!({"path": "notes/a.md", "content": secret}))).await;
        let r = agent(&live.app, Method::POST, a, "files/read", Some(json!({"path": "notes/a.md"}))).await;
        let wb = agent(&live.app, Method::POST, a, "files/write", Some(json!({"path": "big.txt", "content": big}))).await;
        let rb = agent(&live.app, Method::POST, a, "exec", Some(json!({"command": "wc -c < big.txt"}))).await;
        let la = agent(&live.app, Method::POST, a, "files/list", Some(json!({"path": ""}))).await;
        let lb = agent(&live.app, Method::POST, b, "files/list", Some(json!({"path": ""}))).await;
        let rb_other = agent(&live.app, Method::POST, b, "files/read", Some(json!({"path": "notes/a.md"}))).await;
        let grep = agent(
            &live.app,
            Method::POST,
            b,
            "exec",
            // Every writable or mounted place a sibling's file could show up.
            // B's own folder also appears at its host path (for its desktop);
            // A's host path must not exist in B's container.
            Some(json!({"command": format!(
                "grep -rs {secret} /home /tmp /mnt /srv /var /opt /root 2>/dev/null | head -1; test -e {} && echo SEES_A_FOLDER; ls /home",
                live.cfg.agent_folder(a)
            ), "timeoutSecs": 100})),
        )
        .await;
        (w, r, wb, rb, la, lb, rb_other, grep)
    }
    .await;
    let on_host = std::fs::read_to_string(live.root.join(a).join("notes/a.md")).ok();
    let b_host_entries = std::fs::read_dir(live.root.join(b)).unwrap().count();
    live.cleanup().await;
    let (w, r, wb, rb, la, lb, rb_other, grep) = results;

    assert_eq!(w.0, 200, "{}", w.1);
    assert_eq!(r.1["content"], secret);
    assert_eq!(on_host.as_deref(), Some(secret.as_str()), "written into A's own host folder");
    assert_eq!(wb.0, 200, "{}", wb.1);
    assert_eq!(rb.1["stdout"].as_str().unwrap().trim(), big.len().to_string());
    let names: Vec<_> = la.1["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert!(names.contains(&"notes".to_string()) && names.contains(&"big.txt".to_string()), "{names:?}");
    assert_eq!(lb.1["entries"], json!([]), "B's folder is empty");
    assert_eq!(b_host_entries, 0);
    assert_eq!(rb_other.0, 404, "B cannot read A's file: {}", rb_other.1);
    let out = grep.1["stdout"].as_str().unwrap();
    assert!(!out.contains(&secret), "B found A's secret: {out}");
    assert!(!out.contains("SEES_A_FOLDER"), "B can see A's folder: {out}");
    // /home holds B's own folder: at /home/agent, and at its host path when
    // that is under /home (its first part).
    let b_folder = live.cfg.agent_folder(b);
    let mirror_top = b_folder.strip_prefix("/home/").and_then(|rest| rest.split('/').next());
    for name in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        assert!(name == "agent" || Some(name) == mirror_top, "B's /home holds only its own folder: {out}");
    }
}

#[tokio::test]
async fn shell_reports_exit_codes_and_kills_at_the_timeout() {
    let Some(live) = live(1).await else { return };
    let id = &live.agents[0];
    let ok = agent(&live.app, Method::POST, id, "exec", Some(json!({"command": "echo hi; echo oops >&2; exit 3"}))).await;
    let slow = agent(&live.app, Method::POST, id, "exec", Some(json!({"command": "sleep 30", "timeoutSecs": 1}))).await;
    let root = agent(&live.app, Method::POST, id, "exec", Some(json!({"command": "touch /etc/x 2>&1; id -u"}))).await;
    live.cleanup().await;
    assert_eq!(ok.1["exitCode"], 3, "{}", ok.1);
    assert_eq!(ok.1["stdout"], "hi\n");
    assert_eq!(ok.1["stderr"], "oops\n");
    assert_eq!(slow.1["timedOut"], true, "{}", slow.1);
    let out = root.1["stdout"].as_str().unwrap();
    assert!(out.contains("Read-only file system") || out.contains("Permission denied"), "{out}");
}
