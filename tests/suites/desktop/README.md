# Amiro Desktop Test Suites (Tauri)

The desktop test suite exercises the seam between the Tauri v2 shell and
the Go sidecar (`cmd/server`): spawning it, reading its `PORT=` handoff,
the discovery lock a terminal `amiro` attaches to, CORS by origin,
`AppDataDir`/legacy-file resolution, and — the one place this phase
changes product code — making sure the sidecar never survives as an
orphan when its parent dies abruptly.

**What runs where.** Every feature directory that follows always runs and
reports real pass/fail results, on any machine — but which of its own
tests actually execute depends on whether `cargo` and the Tauri CLI
(`cargo tauri`) are on `PATH`:

| Feature | Runs without cargo | Needs cargo |
|---|---|---|
| `lifecycle` | SIGTERM shuts the sidecar down within 5s and removes the discovery lock | The full `cargo tauri dev` launch, webview load |
| `orphans` | **Everything** — SIGKILL-of-parent simulated via `os.Pipe`, no Rust involved at all | — |
| `discovery` | **Everything** — a thread created through a real TUI, read back by a second client against the same backend | A live webview showing the same thread (checked via API instead) |
| `ports` | Two concurrent sidecars get distinct OS-assigned ports | Port-collision recovery; two-instance attach-or-refuse policy (may not even be implemented in `src-tauri/src/lib.rs` today — see the phase 6 progress doc) |
| `data` | **Everything** — `AppDataDir` legacy-directory fallback and `betterchatbot.db` legacy-filename fallback, driven black-box against the real compiled binary | — |
| `ipc` | **Everything** — a structural guard: zero custom `#[tauri::command]`s are registered today, so there is nothing live to test yet | Real IPC round-trip once a command exists |
| `webview` | CORS origin matching (dev origin via the loopback wildcard, packaged origin via `AMIRO_ALLOWED_ORIGIN`, a disallowed origin gets nothing) | A live WKWebView/WebView2/WebKitGTK actually loading the dashboard |
| `packaging` | — (tagged `slow`; no cargo-free equivalent exists) | `tauri build`, install, launch the installed app |
| `ui-parity` | — | Reusing Phase 5's UI specs against the Tauri webview over CDP (not implemented — see the phase 6 progress doc for the three pieces it needs) |

A test that needs cargo calls `harness/desktop.RequireToolchain(h, ...)`
first, which resolves `desktop.enabled` (`auto` | `true` | `false`) against
what is actually on `PATH`: `auto` (the default) skips cleanly with a
recorded reason when the toolchain is missing; `true` turns a missing
toolchain into a hard, clean failure instead, for CI jobs that are
supposed to have it. See `harness/desktop/toolchain.go`.

## Platform limitations on webview automation

Real webview automation — CDP attach, driving the DOM the way the UI
suite's Playwright specs do — varies by platform: WebKitGTK on Linux,
WKWebView on macOS, WebView2 on Windows. This suite has never run against
a live webview on any of them, since no development machine here has the
Tauri toolchain. Where a real webview is unreachable, the phase's own
design falls back to asserting on process lifecycle and logs rather than
the DOM (see `docs/testing/phases/phase-06-desktop.md`'s Risks section) —
`lifecycle`, `orphans`, `discovery`, `data`, and the CORS half of
`webview` all follow exactly that fallback, proving the seam through the
sidecar's own behaviour rather than through anything rendered on screen.

## Running

```bash
# Run the whole desktop surface through amirotest
go run ./cmd/amirotest run --surface desktop

# Run a specific feature
go run ./cmd/amirotest run --surface desktop --feature orphans

# Run via standard go test (what CI would also use, with -race)
go test -race ./suites/desktop/...

# See exactly what is and is not installed, and what each gap means
go run ./cmd/amirotest doctor

# Make a missing toolchain a hard failure instead of a skip (e.g. in CI
# where the toolchain is supposed to be present)
AMIRO_TEST_DESKTOP_ENABLED=true go run ./cmd/amirotest run --surface desktop
```
