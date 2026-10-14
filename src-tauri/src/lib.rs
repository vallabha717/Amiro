use rand::RngCore;
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

/// Reserves an ephemeral loopback port for the adapter by binding
/// `127.0.0.1:0`, reading the OS-assigned port, then dropping the listener
/// immediately. The chosen port is injected into the adapter (`AMIRO_PORT`)
/// and the webview (`__BACKEND_PORT__`) so both agree up front.
///
/// Why ephemeral instead of the fixed 8787 the Go sidecar's dev flow used: a
/// desktop HTTP listener and a host service (e.g. the coordinator's public
/// nginx terminating TLS) can both want 8787, and a collision would silently
/// hand the webview the wrong server. `127.0.0.1:0` cannot collide with
/// anything already listening.
///
/// The drop-then-rebind window is a deliberate, accepted TOCTOU: another
/// process could grab the port in that instant. In practice the window is
/// microseconds and the alternative -- holding the listener until the child
/// binds -- would block the child from binding at all. On failure the caller's
/// bounded socket poll (wait_for_backend) reports the miss rather than
/// panicking the app.
fn reserve_loopback_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to reserve a loopback port for the backend adapter");
    let port = listener
        .local_addr()
        .expect("reserved loopback listener has no local address")
        .port();
    drop(listener);
    port
}

/// Holds the running backend sidecar's child handle so it can be killed
/// explicitly on app exit (RunEvent::Exit below). Covers both the normal
/// window-close quit path AND an external SIGTERM/SIGINT (confirmed live:
/// a plain `kill <pid>` on the app process, e.g. how `systemctl stop` or a
/// process supervisor would ask it to quit, does NOT run Tauri's own
/// RunEvent::Exit on its own -- SIGTERM's default disposition is immediate
/// termination, orphaning the sidecar; reproduced this exact orphan during
/// live testing before adding the signal_hook-based handler below that
/// turns a caught SIGTERM/SIGINT into a clean app_handle.exit()). What's
/// still open: SIGKILL itself can't be caught by any process, and
/// tauri-plugin-shell's Command wrapper exposes no pre_exec hook to set
/// PR_SET_PDEATHSIG on the child before it execs, so a SIGKILLed parent
/// still orphans the sidecar.
struct SidecarChild(Mutex<Option<CommandChild>>);

/// Generates a random 32-byte hex shared-secret token, passed to the adapter
/// as `AMIRO_TOKEN` and injected into the webview as `__BACKEND_TOKEN__`.
/// The adapter checks it on the `X-Amiro-Token` / `X-BetterChatbot-Token`
/// headers (adapter/src/auth.mjs) on every non-public route.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Polls the loopback port until the adapter accepts a connection or the
/// deadline passes. Replaces the old stdout `PORT=` handshake's implicit
/// "the server is up" guarantee: the adapter prints structured JSON logs, not
/// a machine-readable readiness line, so readiness is observed at the socket.
fn wait_for_backend(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file from project root for local development
    let _ = dotenv::from_path("../.env");
    let _ = dotenv::from_path("./.env");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let shared_secret = generate_token();

            let allowed_origin = if cfg!(dev) {
                "http://localhost:3210"
            } else {
                "http://tauri.localhost"
            };

            // Choose the adapter's loopback port before spawning it, so the
            // same value goes to the child (AMIRO_PORT) and the webview.
            let backend_port = reserve_loopback_port();

            // The sidecar slot (bundle.externalBin: ["binaries/backend"]) is
            // filled by src-tauri/build-sidecar.sh, which writes a launcher
            // that execs the Node adapter (adapter/src/server.mjs) -- there is
            // no compiled backend binary any more. See that script's header
            // comment for the packaging limitation (a distributed build needs
            // a Node runtime on the target, or the adapter packaged as a Node
            // SEA; the Go binary used to be self-contained).
            let mut sidecar = app
                .shell()
                .sidecar("backend")
                .expect("backend sidecar launcher not found next to the app executable (run src-tauri/build-sidecar.sh)")
                .env("AMIRO_PORT", backend_port.to_string())
                .env("AMIRO_TOKEN", &shared_secret)
                .env("AMIRO_ALLOWED_ORIGIN", allowed_origin)
                // Legacy header names the old Go config also honoured; the
                // adapter reads AMIRO_TOKEN, these are harmless belt-and-braces.
                .env("AMIRO_AUTH_TOKEN", &shared_secret)
                .env("BETTERCHATBOT_AUTH_TOKEN", &shared_secret)
                .env("BETTERCHATBOT_ALLOWED_ORIGIN", allowed_origin);

            // Pass environment variables to backend sidecar
            if let Ok(openai_compat_data) = std::env::var("OPENAI_COMPATIBLE_DATA") {
                sidecar = sidecar.env("OPENAI_COMPATIBLE_DATA", openai_compat_data);
            }

            let (mut rx, child) = sidecar.spawn().expect("failed to spawn backend sidecar");

            app.manage(SidecarChild(Mutex::new(Some(child))));

            // See SidecarChild's doc comment: an external SIGTERM/SIGINT
            // (not just a window-close click) needs to reach Tauri's own
            // exit path for the RunEvent::Exit handler below to ever run.
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGINT, SIGTERM};
                use signal_hook::iterator::Signals;
                let app_handle = app.handle().clone();
                let mut signals = Signals::new([SIGTERM, SIGINT])
                    .expect("failed to register SIGTERM/SIGINT handler");
                std::thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        app_handle.exit(0);
                    }
                });
            }

            // Drain the sidecar's stdout/stderr into the log so adapter
            // startup failures are visible. Nothing here is required for the
            // window to come up -- readiness is polled at the socket below.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            log::info!("backend: {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            log::info!("backend: {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Error(err) => {
                            log::error!("backend sidecar error: {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            log::error!("backend sidecar exited: {payload:?}");
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Wait (bounded) for the adapter to accept connections before the
            // window loads, so the frontend's first /api/auth/session read does
            // not race adapter startup. A miss is logged, not fatal: the
            // window still opens and the frontend retries.
            if !wait_for_backend(backend_port, Duration::from_secs(15)) {
                log::warn!(
                    "backend adapter did not accept connections on 127.0.0.1:{backend_port} within 15s -- opening the window anyway"
                );
            }

            // window.__BACKEND_PORT__/__BACKEND_TOKEN__ are config.ts's own
            // names (src/lib/backend/config.ts), read at request time, not
            // module load, so injection order relative to React hydration
            // doesn't matter -- only that it happens before the first
            // /api/... call, which initialization_script guarantees.
            // __BACKEND_SESSION_TOKEN__ is intentionally not set: it was the
            // Go sqlite driver's auto-login token; the adapter seeds an admin
            // user with a generated password instead (adapter/src/auth.mjs).
            let init_script = format!(
                "window.__BACKEND_PORT__ = {port};\nwindow.__BACKEND_TOKEN__ = {token};\n",
                port = backend_port,
                token = serde_json::to_string(&shared_secret).unwrap(),
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Amiro")
                .inner_size(1200.0, 800.0)
                .min_inner_size(600.0, 400.0)
                .initialization_script(&init_script)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Normal-quit kill-on-exit half of the process lifecycle guard (see
        // SidecarChild's doc comment for the other, still-open half).
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarChild>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
