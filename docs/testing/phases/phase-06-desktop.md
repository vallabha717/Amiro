# Phase 6 — Desktop suite (Tauri)

> **Status:** SHIPPED (2026-08-19) — 6 of 7 exit criteria MET on a machine with no Rust toolchain; Criterion 6 (`ui-parity`) recorded NOT MET with the exact closing work. Progress report in [`docs/testing/progress/phase-06-desktop.md`](../progress/phase-06-desktop.md) and verification log in [`docs/testing/progress/verification-log-phase-06.md`](../progress/verification-log-phase-06.md).

**Depends on:** 0, 1 · **Blocks:** 7 · **Size:** M

The desktop app is a Tauri v2 shell whose entire job is to spawn the Go
sidecar, learn its port, and point a webview at the UI. Almost all of the
risk is in that seam, so that is what this suite covers.

## What the seam actually is

From `cmd/server/main.go` and `src-tauri/`:

1. Rust spawns the sidecar with `AMIRO_AUTH_TOKEN`, `AMIRO_ALLOWED_ORIGIN`
   and friends in its environment.
2. The sidecar binds `127.0.0.1:0`, prints `PORT=<n>` on stdout.
3. Rust reads that line off the child's stdout and configures the webview.
4. The sidecar writes a discovery lock into `AppDataDir` so a terminal
   `amiro` attaches instead of starting a second backend.
5. On quit, Rust sends SIGTERM; the sidecar shuts down gracefully within
   5 seconds and removes the lock.
6. If Rust dies abruptly, the sidecar must not survive as an orphan —
   `cmd/server/main.go` now watches its stdin pipe for closure and shuts
   down the same way a caught SIGTERM would (Phase 6's Criterion 4 fix).

Every step is a real failure mode with a real user-visible consequence.
`tests/e2e/sidecar_test.go` already passes (its "currently failing" status
here was stale — see Phase 6's Divergence 2); the rest is now covered by
`tests/suites/desktop/` where the toolchain allows it, and recorded as a
gap with the closing command where it does not.

## Deliverables

### 1. `harness/desktop`

- Detect the toolchain (`cargo`, the Tauri CLI, platform webview deps) and
  report a **skip with a reason**, never a failure, when absent. This is
  what `desktop.enabled: auto` resolves.
- Launch `cargo tauri dev` (or a bundled binary in `mode: bundled`) under
  `harness/process`, with the process-group semantics that make orphan
  detection possible.
- Capture Rust stdout/stderr and the sidecar's separately.
- Parse and record the `PORT=` handoff and every discovery-lock read/write
  into `ports.ndjson`.
- Connect Playwright to the Tauri webview over CDP where the platform
  allows it, so the UI specs can be reused against the desktop shell.

### 2. Feature directories

| Feature | Covers |
|---|---|
| `lifecycle` | App starts; sidecar spawns; `PORT=` is read; webview loads; quit sends SIGTERM; sidecar exits within 5s; lock removed |
| `orphans` | SIGKILL the Rust parent → the sidecar must not survive. **The known gap**; this suite is where it gets a failing test and then a fix |
| `discovery` | With the app running, `amiro` attaches (does not embed) and shares its database — a thread created in the TUI appears in the desktop window |
| `ports` | OS-assigned port each launch; a port collision recovers; two app instances behave per design (attach or refuse, not double-bind) |
| `data` | `AppDataDir` resolution per platform; legacy `better-chatbot` → `amiro` migration; legacy `betterchatbot.db` → `amiro.db` fallback |
| `ipc` | Tauri commands in `src-tauri/src/lib.rs`; capability restrictions in `capabilities/default.json` hold |
| `webview` | The correct origin is allowed; CORS matches `AMIRO_ALLOWED_ORIGIN`; the auth token reaches the backend |
| `packaging` | `tauri build` produces an installer; it installs; the installed app launches and its sidecar starts. Tagged `slow` |
| `updates` | Update-check behaviour, if configured |

### 3. Reuse the UI specs

The desktop webview runs the same bundle as the served dashboard. Rather
than duplicating specs, `--surface desktop --feature ui-parity` runs the
`smoke`-tagged UI specs against the Tauri webview. Any divergence between
browser and webview — and there will be some, around storage, origins, and
file access — surfaces as a parity failure rather than as an untested gap.

## Exit criteria

1. `amirotest run --surface desktop` passes where the toolchain exists, and skips with a clear recorded reason where it does not — never a red build on a machine without cargo.
2. The `PORT=` handoff is asserted end to end, closing the loop on the currently-failing `tests/e2e/sidecar_test.go`.
3. SIGTERM shuts the sidecar down within 5 seconds; the lock is removed.
4. SIGKILL of the parent leaves no orphaned sidecar — with a fix if the test fails, since this is a known gap.
5. Discovery works: desktop running + `amiro` in a terminal share one database, proven by a thread visible in both.
6. `smoke` UI specs pass against the desktop webview.
7. The desktop suite runs serially and never overlaps with another surface.

## Risks

- **CI cost and fragility.** Tauri dev builds are slow and need platform webview dependencies. Mitigation: the desktop job runs on PRs touching `src-tauri/**` and nightly, not on every push; `mode: bundled` is `slow`-tagged.
- **Webview automation varies by platform.** WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows — CDP availability differs. Where automation is not possible, fall back to asserting on the lifecycle and logs rather than the DOM, and record that limitation in the suite README.
- **Orphan detection is inherently racy.** Assert on "no process holding the port and no process with the sidecar's parent pid" with a bounded poll, never a fixed sleep.
- **Headless CI.** Linux needs a virtual display (`xvfb`). Set it up in the workflow rather than in the harness, so a local run uses the real display.
