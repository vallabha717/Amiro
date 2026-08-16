use rand::RngCore;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

/// Holds the running backend-go sidecar's child handle so it can be killed
/// explicitly on app exit (RunEvent::Exit below). Covers both the normal
/// window-close quit path AND an external SIGTERM/SIGINT (confirmed live:
/// a plain `kill <pid>` on the app process, e.g. how `systemctl stop` or a
/// process supervisor would ask it to quit, does NOT run Tauri's own
/// RunEvent::Exit on its own -- SIGTERM's default disposition is immediate
/// termination, orphaning the sidecar; reproduced this exact orphan during
/// live testing before adding the signal_hook-based handler below that
/// turns a caught SIGTERM/SIGINT into a clean app_handle.exit()). What's
/// still open, matching Phase 0's spike doc comment (cmd/server/main.go):
/// SIGKILL itself can't be caught by any process, and tauri-plugin-shell's
/// Command wrapper exposes no pre_exec hook to set PR_SET_PDEATHSIG on the
/// child before it execs, so a SIGKILLed parent still orphans the sidecar.
struct SidecarChild(Mutex<Option<CommandChild>>);

/// Generates a random 32-byte hex shared-secret token, matching plan
/// section 1's "generate a random shared-secret token per launch" and the
/// exact hex-encoding shape backend-go's own dev-mode fallback
/// (config.go) already uses, so BETTERCHATBOT_AUTH_TOKEN looks the same
/// either way.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
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

            // Plan section 1: a random shared secret per launch, passed to
            // the Go process via env (never a CLI arg, which would be
            // visible in `ps`), required as a header on every webview
            // request. BETTERCHATBOT_ALLOWED_ORIGIN is deliberately not
            // set here -- backend-go's own config.go default
            // ("tauri://localhost") already matches this webview's origin,
            // confirmed live rather than duplicated/hardcoded a second
            // time here.
            let shared_secret = generate_token();

            // "backend" (not "binaries/backend") -- tauri-build's build.rs
            // already resolved bundle.externalBin's "binaries/backend-
            // <target-triple>" source path (tauri.conf.json) at compile
            // time and copied/renamed it to sit flat next to this app's
            // own executable; the runtime sidecar() lookup here is always
            // relative to that, bare, no target-triple suffix -- confirmed
            // by reading tauri-plugin-shell's relative_command_path after
            // "binaries/backend" panicked with ENOENT (it was looking for
            // a literal "binaries/" subfolder next to the exe, which
            // doesn't exist).
            let allowed_origin = if cfg!(dev) {
                "http://localhost:3210"
            } else {
                "http://tauri.localhost"
            };

            let mut sidecar = app
                .shell()
                .sidecar("backend")
                .expect("backend sidecar binary not found next to the app executable")
                .env("AMIRO_AUTH_TOKEN", &shared_secret)
                .env("AMIRO_ALLOWED_ORIGIN", allowed_origin)
                .env("BETTERCHATBOT_AUTH_TOKEN", &shared_secret)
                .env("BETTERCHATBOT_ALLOWED_ORIGIN", allowed_origin);

            // Pass environment variables to backend sidecar
            if let Ok(openai_compat_data) = std::env::var("OPENAI_COMPATIBLE_DATA") {
                sidecar = sidecar.env("OPENAI_COMPATIBLE_DATA", openai_compat_data);
            }

            let (mut rx, child) = sidecar
                .spawn()
                .expect("failed to spawn backend sidecar");

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

            // Blocks app setup (briefly -- the sidecar prints PORT= within
            // milliseconds of starting, confirmed live) until the sidecar
            // has told us its port, so the window can be created with the
            // port/token baked into its initialization_script -- guaranteed
            // to run before any frontend script, unlike a post-load
            // window.eval() which could race the frontend's own first
            // /api/auth/session read (session-context.tsx).
            let (port, session_token) = tauri::async_runtime::block_on(async move {
                let mut port: Option<u16> = None;
                let mut session_token: Option<String> = None;
                let mut stdout_buf = String::new();
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            stdout_buf.push_str(&String::from_utf8_lossy(&line));
                            while let Some(pos) = stdout_buf.find('\n') {
                                let line_str = stdout_buf[..pos].to_string();
                                stdout_buf = stdout_buf[pos + 1..].to_string();
                                let l = line_str.trim();
                                if let Some(p) = l.strip_prefix("PORT=") {
                                    port = p.trim().parse::<u16>().ok();
                                } else if let Some(t) = l.strip_prefix("SESSION_TOKEN=") {
                                    session_token = Some(t.trim().to_string());
                                }
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            log::info!("backend: {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(err) => {
                            log::error!("backend sidecar error: {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            log::error!("backend sidecar exited before printing PORT=: {payload:?}");
                            break;
                        }
                        _ => {}
                    }
                    if port.is_some() {
                        break;
                    }
                }
                (port, session_token)
            });

            let port = port.expect(
                "backend sidecar never printed a PORT=<n> line on stdout -- see stderr above",
            );

            // window.__BACKEND_PORT__/__BACKEND_TOKEN__ are config.ts's own
            // names (src/lib/backend/config.ts); __BACKEND_SESSION_TOKEN__
            // is session-context.tsx's adoptInjectedSessionToken -- all
            // three read at request time, not module load, so injection
            // order relative to React hydration doesn't matter, only that
            // it happens before the first /api/... call, which
            // initialization_script guarantees.
            let mut init_script = format!(
                "window.__BACKEND_PORT__ = {port};\nwindow.__BACKEND_TOKEN__ = {token};\n",
                port = port,
                token = serde_json::to_string(&shared_secret).unwrap(),
            );
            if let Some(session_token) = session_token {
                init_script.push_str(&format!(
                    "window.__BACKEND_SESSION_TOKEN__ = {token};\n",
                    token = serde_json::to_string(&session_token).unwrap(),
                ));
            }

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
        // Normal-quit kill-on-exit half of plan section 1's process
        // lifecycle guard (see SidecarChild's doc comment for the other,
        // still-open half).
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarChild>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
