//! `amiro-sandboxd`: the only process that holds the Docker socket.
//!
//! Environment (see `packaging/sandbox/compose.yml`):
//! `AMIRO_SANDBOX_TOKEN`, `AMIRO_SANDBOX_MASTER` (secrets, ≥ 24 chars each),
//! `AMIRO_SANDBOX_USER` (uid:gid, never 0), `AMIRO_SANDBOX_AGENTS_ROOT`,
//! optional `AMIRO_SANDBOX_{IMAGE,NAMESPACE,MEMORY_MB,CPUS,PIDS,NETWORK,RUNTIME}`,
//! `AMIRO_SANDBOX_LISTEN` (default `127.0.0.1:4313`), `DOCKER_SOCKET`.

use std::sync::Arc;

use sandboxd::docker::Docker;
use sandboxd::server::{router, Supervisor};
use sandboxd::spec::SandboxConfig;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    if let Err(message) = run().await {
        eprintln!("amiro-sandboxd: {message}");
        std::process::exit(2);
    }
}

async fn run() -> Result<(), String> {
    let env = |name: &str| std::env::var(name).ok();
    let cfg = SandboxConfig::from_lookup(env)?;
    let token = env("AMIRO_SANDBOX_TOKEN").unwrap_or_default().trim().to_string();
    let master = env("AMIRO_SANDBOX_MASTER").unwrap_or_default().trim().to_string();
    let socket = env("DOCKER_SOCKET").unwrap_or_else(|| "/var/run/docker.sock".into());
    let listen = env("AMIRO_SANDBOX_LISTEN").unwrap_or_else(|| "127.0.0.1:4313".into());
    let docker = Docker::new(socket);
    let supervisor = Supervisor::new(cfg, docker, token, master)?;
    if !supervisor.docker.ping().await {
        tracing::warn!("Docker is not answering yet; agent containers will fail until it does");
    }
    tracing::info!(
        namespace = %supervisor.cfg.namespace,
        image = %supervisor.cfg.image,
        network = %supervisor.cfg.network,
        runtime = %supervisor.cfg.runtime.as_deref().unwrap_or("runc"),
        "amiro-sandboxd listening on {listen}"
    );
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    axum::serve(listener, router(Arc::new(supervisor)))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
}
