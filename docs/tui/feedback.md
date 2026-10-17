# Amiro TUI Implementation - Audit, Testing & Feedback Report

> **Historical Record:** This document records the earlier Go backend and Bubble Tea TUI (`backend-go/cmd/amiro`), which have since been retired and removed. Amiro now uses the native Rust backend (`backend/`, binary `amiro-backend`) and the vendored Rust runtime (`runtime/`, binary `amiro-runtime`), which includes its own Rust TUI (`runtime/crates/amiro-tui`).



**Date:** 2026-08-18  
**Scope:** Review and verification of TUI Implementation Plan Phases 0–6 against `backend-go` and `src/`.  
**Artifacts Reviewed:**
- [tui-implementation-plan.md](./tui-implementation-plan.md)
- [tui-progress.md](./tui-progress.md)
- Codebase: `backend-go/cmd/amiro`, `backend-go/internal/tui/**`, `backend-go/internal/ai/uimessage/**`, `backend-go/internal/appwiring/**`, `backend-go/internal/api/chat/**`

---

## 1. Executive Summary & Verdict

The TUI implementation for Amiro is **substantially complete, cleanly designed, and thoroughly tested**.

The codebase successfully adheres to the core design principle: **"one agent, many surfaces"**. The TUI operates as a lightweight client over the existing HTTP+SSE protocol and Vercel AI SDK UI Message stream, sharing the exact same agent turn engine (`chat.RunTurn`), approval rail, and object dependency graph (`appwiring.New`) with the desktop app.

### Verification Summary
- **Go Build & Vet:** `go build ./... && go vet ./...` passes cleanly across all packages with zero errors or warnings.
- **Go Unit & Integration Test Suite:** All 38+ packages pass, including multi-client concurrency tests, real tool execution tests, and end-to-end sidecar lifecycle tests (`tests/e2e`).
- **Frontend Test Suite:** 29 vitest files (354 tests) pass with zero regressions.
- **Binary Compilation:** `cmd/amiro` compiles into a standalone, pure-Go binary with no CGO dependencies.
- **Headless Pipeline:** `amiro run` successfully initializes `appwiring.App`, executes `chat.RunTurn`, handles auto-login and session resolution, and outputs structured JSON or styled text with appropriate exit codes (0/1/2).

---

## 2. Detailed Phase-by-Phase Verification

| Phase | Core Objective | Key Deliverables Verified | Status |
|---|---|---|---|
| **Phase 0** | Backend Seams | `uimessage.Frame`, `Scanner`, `DecodeFrame`, `Emitter`, `chat.RunTurn`, `internal/appwiring`, SQLite WAL mode & `busy_timeout` | **Verified & Green** |
| **Phase 1** | Walking Skeleton | `cmd/amiro`, discovery lockfile (`sidecar.lock.json`), `client.HTTPClient`, `session.State/Reduce`, auth subcommands (`login`, `logout`, `whoami`) | **Verified & Green** |
| **Phase 2** | Legibility & Visuals | Tool cards (diff, shell, files, plan, generic), reasoning blocks, live todo panel, live status bar (model, tokens, cost, elapsed), interrupt handling | **Verified & Green** |
| **Phase 3** | Interaction & Approvals | Client-side approval modal (`y`/`n`/`a`), live permission mode switching, slash-command palette (`/mode`, `/threads`, `/models`), thread switcher & replay | **Verified & Green** |
| **Phase 4** | Mentions & Config | `@`-mentions for tools, agents, workflows, and MCP tools; YAML config hierarchy (`~/.config/amiro` and `.amiro/config.yaml`); `/settings`, `/compact`, `/export` | **Verified & Green** |
| **Phase 5** | Multi-Client & Attach | `--connect` and `--token` flags, concurrent multi-client SSE listeners on single thread (`multiclient_test.go`) | **Verified & Green** |
| **Phase 6** | Headless Runner | `amiro run "<prompt>" [--json] [--yes]`, stdout pipe suppression, error capturing emitter, 0/1/2 exit codes | **Verified & Green** |

---

## 3. High-Value Findings & Bug Audit

During our code review and test execution, we identified key areas worth highlighting:

### Finding 1: Flaky Golden Test in `internal/tui/page` (Root Cause Identified)
- **Symptom:** Running `go test -count=3 ./internal/tui/page/...` intermittently causes `TestChat_Golden_ToolTurn` to fail with a golden mismatch where the status bar collapses from the full info strip into the minimal format `4380 tok · 6s`.
- **Root Cause:**
  1. `pricing.DefaultCatalog()` initiates an asynchronous background sync (`StartBackgroundSync`) that downloads the live LiteLLM pricing registry over HTTP (`https://raw.githubusercontent.com/BerriAI/litellm/...`).
  2. When the test first runs, `claude-sonnet-5` is not in the static fallback price map, so `estimateCost` returns `found = false` (no cost string rendered, total unstyled line length < 120 cols).
  3. When the background HTTP request completes in memory, `c.prices` is populated with the remote pricing. Subsequent runs in the same test process calculate a cost (`$0.02`), adding ` · $0.02` to the status bar.
  4. At 120-column width, this pushes the line length past 120 characters, triggering the status bar's overflow collapse logic (`minimal`).
- **Recommendation:**
  In tests, either mock or bypass `pricing.DefaultCatalog()`, inject an explicit price catalog into `status.Info`, or disable the background sync goroutine during unit tests.

### Finding 2: Bifrost Stdout Logger
- **Observation:** `internal/ai/bifrost.NewClient` leaves the default logger unconfigured, causing Bifrost to emit JSON log lines directly to `os.Stdout` at `INFO` level.
- **Handling in Headless:** `cmd/amiro/run.go` cleanly works around this for `--json` by using `withStdoutSuppressed` (redirecting `os.Stdout` to a draining pipe during execution).
- **Recommendation:**
  Configure Bifrost's logger inside `internal/ai/bifrost` to direct output to `os.Stderr` or accept an injected logger interface so that CLI and background processes never pollute stdout.

### Finding 3: CLI Subcommand Parity vs. Slash Commands
- **Observation:** Appendix A in the initial plan listed `amiro config path | validate` and `amiro threads [--limit N]` as CLI subcommands.
- **Current State:** These features are available within the interactive TUI as `/settings` and `/threads` (or `ctrl+t`), and `amiro --thread <id>` is supported at startup.
- **Recommendation:**
  If standalone scriptability is needed in CI/CD or shell scripts (e.g. `amiro threads` or `amiro config validate`), add lightweight CLI subcommand handlers in `cmd/amiro/main.go` that call `client.ListThreads()` or `config.Load()`.

### Finding 4: Width Calculation for Unicode & CJK
- **Observation:** `internal/tui/component/status/bar.go` uses `runeWidth(s)` (measuring rune count) rather than display column width.
- **Current State:** Currently, status bar fields are predominantly ASCII (numbers, paths, model names, tokens).
- **Recommendation:**
  For full internationalization or CJK workspace paths, consider using `charmbracelet/x/ansi.StringWidth` or `lipgloss.Width` on the unstyled string to accurately compute terminal column widths.

---

## 4. Notable Past Bugs Caught & Resolved

The implementation process caught and fixed several critical cross-surface bugs:
1. **Desktop Approval Answer Key (`__tag` vs `__$ref__`):** Fixed a bug in `src/types/chat.ts` where approval confirmations sent `__$ref__`, which the Go backend's `parseApprovalAnswer` silently ignored.
2. **Turn Persistence Ordering in `RunTurn`:** Reordered persistence logic to ensure thread state is written before emitting the `[DONE]` SSE frame, eliminating race conditions when clients immediately re-fetch threads.
3. **Keyring Fallback on Headless Linux:** Fixed `KeyringStore.Get` to return `ok=false` cleanly when OS D-Bus secrets service is unavailable, rather than crashing with an unhandled D-Bus error.
4. **Export Share ID Response:** Fixed the export endpoint so it properly returns the generated share ID to callers.
5. **CLI Trailing Flags Parsing:** Implemented `partitionRunArgs` in `cmd/amiro/run.go` so flags like `--json` or `--yes` can appear before or after the prompt string.

---

## 5. Architectural Strengths

1. **Protocol Symmetry:** The TUI parses the exact same SSE frames that the Next.js React frontend consumes via `uimessage.Frame` and `Scanner`.
2. **Single Backend Seam:** Both the desktop app and the TUI utilize `appwiring.New(ctx, cfg)` to instantiate the database, secret store, MCP manager, and agent engine.
3. **Non-Blocking UI Loop:** The Bubble Tea event loop remains strictly non-blocking, reading SSE frames asynchronously from Go channels.
4. **Approval Safety:** Approvals reuse the backend's existing permission store, ensuring rules granted in the terminal persist across desktop sessions and vice-versa.

---

## 6. Next Steps & Recommendations

1. **Fix Pricing Catalog Test Isolation:** Add a deterministic or disabled sync mode for `pricing.DefaultCatalog` when running tests.
2. **Interactive TTY Manual Verification:** Run the compiled `./amiro` binary in full terminal emulators (e.g., iTerm2, Alacritty, Windows Terminal) to visually confirm color themes and scroll behaviors.
3. **Packaging & Distribution:** Integrate `cmd/amiro` into the root build scripts (`package.json` and CI release workflows) alongside the Tauri desktop bundles.
