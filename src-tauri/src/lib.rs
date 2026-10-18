use rand::RngCore;
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

/// Reserves an ephemeral loopback port for the backend sidecar by binding
/// `127.0.0.1:0`, reading the OS-assigned port, then dropping the listener
/// immediately. The chosen port is injected into the backend (`AMIRO_PORT`)
/// and the webview (`__BACKEND_PORT__`) so both agree up front.
///
/// Why ephemeral instead of a fixed port: a desktop HTTP listener and a host
/// service (e.g. public reverse proxy terminating TLS) can both want a default
/// port, and a collision would silently hand the webview the wrong server.
/// `127.0.0.1:0` cannot collide with anything already listening.
///
/// The drop-then-rebind window is a deliberate, accepted TOCTOU: another
/// process could grab the port in that instant. In practice the window is
/// microseconds and the alternative -- holding the listener until the child
/// binds -- would block the child from binding at all. On failure the caller's
/// bounded socket poll (wait_for_backend) reports the miss rather than
/// panicking the app.
fn reserve_loopback_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to reserve a loopback port for the backend sidecar");
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

/// Generates a random 32-byte hex shared-secret token, passed to the backend
/// as `AMIRO_TOKEN` and injected into the webview as `__BACKEND_TOKEN__`.
/// The backend checks it on the `X-Amiro-Token` / `Authorization` headers
/// on every non-public route.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}


/// Locate the bundled owned runtime next to this executable.
///
/// Tauri places `bundle.externalBin` entries beside the app binary; the shell
/// plugin can spawn a sidecar by slot name but does not expose its path, and the
/// backend needs the path to start `runtime --no-update api-bridge` itself.
/// Exact names win over suffixed ones (dev builds keep the target triple).
fn find_runtime_binary() -> Option<std::path::PathBuf> {
    let current = std::env::current_exe().ok()?;
    let dir = current.parent()?;
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    for name in ["runtime", "amiro-runtime", "amiro"] {
        let exact = dir.join(format!("{name}{exe_suffix}"));
        if exact.is_file() {
            return Some(exact);
        }
    }
    let prefix = "runtime-";
    let mut fallback = None;
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with(prefix) && entry.path().is_file() {
            fallback = Some(entry.path());
        }
    }
    fallback
}

/// Polls the loopback port until the backend accepts a connection or the
/// deadline passes. Readiness is observed at the socket.
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

#[tauri::command]
fn desktop_show_notification(
    _app: tauri::AppHandle,
    title: String,
    body: String,
    _thread_id: Option<String>,
    _schedule_id: Option<String>,
    _category: Option<String>,
    silent: Option<bool>,
) -> Result<serde_json::Value, String> {
    let os = std::env::consts::OS;
    let is_silent = silent.unwrap_or(false);

    if !is_silent {
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("notify-send")
                .arg("--app-name=Amiro")
                .arg(&title)
                .arg(&body)
                .spawn();
        }

        #[cfg(target_os = "macos")]
        {
            let script = format!(
                "display notification \"{}\" with title \"{}\"",
                body.replace('\\', "\\\\").replace('"', "\\\""),
                title.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let _ = std::process::Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .spawn();
        }

        #[cfg(target_os = "windows")]
        {
            let script = format!(
                r#"[void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms"); $obj = New-Object System.Windows.Forms.NotifyIcon; $obj.Icon = [System.Drawing.SystemIcons]::Information; $obj.BalloonTipTitle = "{}"; $obj.BalloonTipText = "{}"; $obj.Visible = $True; $obj.ShowBalloonTip(5000);"#,
                title.replace('"', "`\""),
                body.replace('"', "`\"")
            );
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
                .spawn();
        }
    }

    let surface_os = match os {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    };

    Ok(serde_json::json!({
        "delivered": true,
        "surface": "desktop_native",
        "os": surface_os
    }))
}

#[tauri::command]
fn desktop_focus_window(
    app: tauri::AppHandle,
    route: Option<String>,
) -> Result<serde_json::Value, String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(ref r) = route {
            if r.starts_with('/') {
                let detail = serde_json::json!({ "targetUrl": r });
                let js = format!(
                    "window.dispatchEvent(new CustomEvent(\"amiro:notification-click\", {{ detail: {} }}));",
                    detail
                );
                let _ = win.eval(&js);
            }
        }
        Ok(serde_json::json!({
            "focused": true,
            "route": route
        }))
    } else {
        Err("main window not found".to_string())
    }
}

#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    desktop_focus_window(app, None)
}

#[tauri::command]
fn desktop_runtime_info() -> serde_json::Value {
    serde_json::json!({
        "isDesktop": true,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION")
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file from project root for local development
    let _ = dotenv::from_path("../.env");
    let _ = dotenv::from_path("./.env");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            desktop_show_notification,
            desktop_focus_window,
            focus_main_window,
            desktop_runtime_info
        ])
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

            // Choose the backend's loopback port before spawning it, so the
            // same value goes to the child (AMIRO_PORT) and the webview.
            let backend_port = reserve_loopback_port();

            // The sidecar slots (bundle.externalBin: ["binaries/backend",
            // "binaries/runtime"]) are filled by src-tauri/build-sidecar.sh.
            let mut sidecar = app
                .shell()
                .sidecar("backend")
                .expect("backend sidecar launcher not found next to the app executable (run src-tauri/build-sidecar.sh)")
                .env("AMIRO_DESKTOP", "1")
                .env("AMIRO_PORT", backend_port.to_string())
                .env("AMIRO_TOKEN", &shared_secret)
                .env("AMIRO_ALLOWED_ORIGIN", allowed_origin)
                .env("AMIRO_AUTH_TOKEN", &shared_secret);

            // Pass environment variables to backend sidecar
            if let Ok(openai_compat_data) = std::env::var("OPENAI_COMPATIBLE_DATA") {
                sidecar = sidecar.env("OPENAI_COMPATIBLE_DATA", openai_compat_data);
            }

            // The backend supervises the owned runtime (bridge + keepalive).
            // Hand it the bundled path when one is present; in a checkout it
            // falls back to the runtime workspace's own build output.
            if let Some(runtime) = find_runtime_binary() {
                sidecar = sidecar.env("AMIRO_RUNTIME_BIN", runtime);
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

            // Drain the sidecar's stdout/stderr into the log so backend
            // startup issues are visible. Nothing here is required for the
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

            // Wait (bounded) for the backend to accept connections before the
            // window loads, so the frontend's first requests do
            // not race backend startup. A miss is logged, not fatal: the
            // window still opens and the frontend retries.
            if !wait_for_backend(backend_port, Duration::from_secs(15)) {
                log::warn!(
                    "backend sidecar did not accept connections on 127.0.0.1:{backend_port} within 15s -- opening the window anyway"
                );
            }

            // window.__BACKEND_PORT__/__BACKEND_TOKEN__ are config.ts's own
            // names (src/lib/backend/config.ts), read at request time, not
            // module load, so injection order relative to React hydration
            // doesn't matter -- only that it happens before the first
            // /api/... call, which initialization_script guarantees.
            // __BACKEND_SESSION_TOKEN__ is intentionally not set: the Amiro
            // backend seeds authentication credentials directly.
            let init_script = format!(
                r#"window.__BACKEND_PORT__ = {port};
window.__BACKEND_TOKEN__ = {token};
window.__AMIRO_DESKTOP__ = true;
window.__AMIRO_PLATFORM__ = {platform};
window.__AMIRO_DESKTOP_NOTIFY__ = async function(payload) {{
  if (!window.__TAURI__?.core?.invoke && !window.__TAURI__?.invoke) return null;
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  return await invoke("desktop_show_notification", {{
    title: payload.title,
    body: payload.body,
    threadId: payload.threadId ?? null,
    scheduleId: payload.scheduleId ?? null,
    category: payload.category ?? null,
    silent: payload.silent ?? false
  }});
}};
"#,
                port = backend_port,
                token = serde_json::to_string(&shared_secret).unwrap(),
                platform = serde_json::to_string(std::env::consts::OS).unwrap(),
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
