# Amiro - Terminal (TUI) Implementation Plan

> **Historical Record:** This document records the earlier Go backend and Bubble Tea TUI (`backend-go/cmd/amiro`), which have since been retired and removed. Amiro now uses the native Rust backend (`backend/`, binary `amiro-backend`) and the vendored Rust runtime (`runtime/`, binary `amiro-runtime`), which includes its own Rust TUI (`runtime/crates/amiro-tui`).



**Goal:** one agent, many surfaces. The same `backend-go` that powers the desktop app also powers a first-class terminal client - `amiro` in a project directory - and, later, an IDE extension, without a second implementation of the agent loop.

**Build log:** [tui-progress.md](./tui-progress.md) - what is actually built, phase by phase. Read it before starting work; append to it when you finish a phase.

**Status:** All phases (0 through 6) landed 2026-08-18. Plan revised 2026-08-18 after verifying the approach against `openai/codex`, `charmbracelet/crush`, `sst/opencode` (all three cloned and read) and Claude Code's published architecture. Part 2 records what that verification changed.

---

## Part 0 - Where the tree actually stands today

Everything below was read out of the working tree, not assumed:

| Fact | Where | Why it matters here |
|---|---|---|
| `backend-go` is one Go module, `amiro/backend`; all agent code is under `internal/` | `backend-go/go.mod` | Decides the folder layout - Part 1 |
| The turn engine **already runs headless once** | `internal/api/chat/eval_agent.go` drives `runToolLoop` with `uimessage.NewDiscardWriter()` - no HTTP, no auth, no thread | A TUI is a *second caller* of a path that already has two |
| Only **five** non-test sites hold a `*uimessage.Writer` | `compact.go:58`, `tool_loop.go:107,122`, `tool_scheduler.go:65,106` | Decoupling the loop from HTTP is small |
| `Handler.Chat(w, r)` is HTTP only at its edges | `internal/api/chat/route.go` - ~200 lines in the middle touch neither `w` nor `r` | Extraction is a cut, not a rewrite |
| The wire format is already the **Vercel AI SDK UI Message Stream** | `internal/ai/uimessage/stream.go` | Amiro already has a protocol. It just has no Go *reader* for it |
| Approvals suspend and wait for the client to resubmit the assistant message | `tool_scheduler.go:suspendForApproval`, `approvals.go:resolveApprovals` | Survives a refresh; the TUI can reuse it rather than invent a second rail |
| Desktop requires sign-up/login; auto-login is commented out | `cmd/server/main.go` | The TUI needs a real identity |
| SQLite opens with **only** `PRAGMA foreign_keys = ON` - no WAL, no `busy_timeout` | `internal/db/driver.go` | Two processes on the file today means `database is locked`, not a slow query |
| Frontend tests are **28 vitest unit tests**; `pnpm test:e2e` is scripted but **no `playwright.config` exists** | `package.json`, `src/**/*.test.ts` | "Test the desktop every phase" needs a harness that does not exist yet - Part 5 addresses this honestly |

---

## Part 1 - The one constraint that decides the folder layout

Go's `internal/` rule: a package under `backend-go/internal/` is importable **only** from inside the `amiro/backend` module. A top-level `tui/` directory with its own `go.mod` could never import the agent's types - it would be a wire-protocol client forever, with a hand-maintained copy of every struct.

**Decision:** the TUI is `backend-go/internal/tui/**`, its binary is `backend-go/cmd/amiro/`. Separate folder, separate binary, separate dependency set - sharing types and the turn engine with the server, which is the point.

This matches both Go references exactly: crush puts its Bubble Tea UI at `internal/ui/` inside the same module as `internal/backend`, and codex puts `tui` in the same Cargo workspace as `core`.

---

## Part 2 - Verification: what the reference implementations actually do

Cloned and read, not summarized from blog posts.

| | Core | Protocol layer | Surfaces | How its own TUI reaches the core |
|---|---|---|---|---|
| **codex** (Rust) | `codex-rs/core` | `codex-rs/protocol` - its README: *"internal types for communication between `codex-core` and `codex-tui`, as well as external types used with `codex app-server`"* | `tui`, `exec` (headless), `app-server` (JSON-RPC over stdio) → VS Code extension | **In-process**, but every GUI surface goes through `app-server` |
| **crush** (Go) | `internal/backend` | `internal/proto` (`message.go`, `permission.go`, `requests.go`, `agent.go`) | `internal/ui` (Bubble Tea), HTTP + unix-socket server | **Over the socket** - its own TUI is a client, via `internal/client` |
| **opencode** (TS) | `packages/core` | `packages/protocol` + OpenAPI-generated `packages/sdk` | `packages/tui`, `packages/desktop` (Electron), VS Code, Slack | **HTTP + SSE** through the generated SDK |
| **Claude Code** | one engine | stdio JSON stream | CLI, IDE extensions, desktop, SDK | SDK spawns the CLI as a subprocess and streams typed messages over stdio |

### 2.1 What this confirms about the original approach

Four things were right and stay:

1. **One backend, thin surfaces.** All four are built this way. Nobody forks the agent per surface.
2. **A transport-neutral turn function is the load-bearing seam.** codex's `core` and crush's `backend` are exactly that. Amiro's `RunTurn` extraction is the same move.
3. **The TUI belongs in the same module as the core.** crush and codex both do this.
4. **Approval is a first-class protocol concept, not UI glue.** crush has a whole `internal/proto/permission.go` (`CreatePermissionRequest`, `PermissionRequest`, `PermissionNotification`); codex's app-server README has an `Approvals` section. Amiro already has this shape - it just calls it a `data-tool-approval` part.

### 2.2 What this changes - **the TUI should be a client of the server, not an in-process caller**

The first draft of this plan recommended in-process by default, HTTP later. The evidence says invert that:

- **3 of 4 references route rich surfaces through a protocol**, and the one that links in-process (codex `tui`) still exposes `app-server` the moment a GUI is involved.
- **Amiro already has the server and already has a GUI client of it.** Making the TUI the only surface that bypasses the boundary means the safety-critical path - approvals - has two implementations, and the two surfaces can silently diverge. That is precisely what the user's "test both every phase" instinct is protecting against, and the cheapest way to honor it is to have one path to test.
- **The SQLite two-writer problem disappears.** One process owns the database. §2.6's WAL work is still worth doing, but it stops being load-bearing.
- **Attaching the terminal to the running desktop session becomes free**, instead of a Phase 5 feature. crush tests exactly this scenario (`internal/server/multiclient_test.go`).
- **An IDE extension later is then a third client, not a third architecture.**

The zero-setup UX is preserved by *embedding* the server, not by skipping it:

```
amiro                       # 1. is a sidecar already running for this app-data dir?
                            #    yes → attach to it (shares the desktop app's session)
                            #    no  → start httpserver in-process on a loopback port,
                            #          in the same binary, and talk to it over HTTP+SSE
amiro --connect URL --token # explicit attach (remote / Postgres deploy)
```

Cost: JSON marshal→parse per stream frame on loopback. opencode and crush both stream tokens this way; it is not the bottleneck next to a model call.

**In-process direct calls do not disappear** - they remain the path for `amiro run` (headless, Phase 6) and the eval harness, which genuinely have no client. `RunTurn` serves both.

### 2.3 The protocol layer gets promoted from "maybe later" to Phase 0

Every reference has a dedicated protocol package. Amiro has a *writer* for the AI SDK UI Message Stream and no reader, and the frames are assembled from `map[string]any` literals.

**Decision:** `internal/ai/uimessage` gains typed frames and a decoder - `Frame` as a discriminated union over the existing `type` field, `Encode`/`Decode`, and `Writer` re-expressed as "the SSE encoder of a `Frame`". The wire bytes do not change (the frontend's `useChat` depends on them; `parts_golden_test.go` and the Headers map pin them). What changes is that Go code on both ends of the stream refers to one set of types.

This is crush's `internal/proto` and codex's `protocol` crate, adapted to a wire format Amiro already shipped.

### 2.4 Approvals - reuse the existing rail, render it as a dialog

The first draft proposed a blocking `Approver` interface for the terminal. With the TUI as a client, that is no longer needed and is actively worse: it would be a second approval implementation.

The TUI instead speaks the rail that exists - receive the `data-tool-approval` frame, show a modal, resubmit the assistant message with `{"__tag":"manual-tool-confirm","confirm":true,"scope":"always"}` - and *renders* it as though it were blocking. Same protocol as the browser, same `permission.Store` grants, so an "always allow" granted in the terminal is honored in the desktop window and vice versa.

A blocking `Approver` stays on the shelf for `amiro run --yes` and the eval harness, where there is no client to ask.

### 2.5 Identity - log in once, keep the token where the provider keys already live

- `amiro auth login` → `auth.Service.Login` → token stored via `internal/secrets` (OS keyring, existing file-store fallback for headless Linux/SSH).
- `amiro auth whoami` / `logout`.
- First run with no credential drops into a login form inside the TUI.
- The same token authenticates both the embedded and the attached server, alongside the sidecar's shared secret.

### 2.6 SQLite - WAL anyway

`internal/db/driver.go` sets no journal mode, so a second writer fails immediately rather than waiting. With the server-client decision this is no longer the TUI's problem, but it is still one `PRAGMA` away from being a latent desktop bug the first time anything else opens the file (a backup tool, `amiro run`, a migration script):

```
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Lands in Phase 0. It is a strict improvement for the desktop app on its own.

### 2.7 TUI stack

| Dependency | For |
|---|---|
| `charmbracelet/bubbletea` | The Elm-architecture event loop |
| `charmbracelet/bubbles` | viewport, textarea, list, spinner, help |
| `charmbracelet/lipgloss` | Styling, layout, adaptive light/dark |
| `charmbracelet/glamour` | Markdown rendering |
| `charmbracelet/x/ansi` | Width-correct truncation (CJK, emoji) |
| `charmbracelet/x/exp/golden` | Golden-file assertions in tests (crush uses this for 363 goldens) |

All MIT, all pure Go - cross-compilation and the sidecar build are unaffected. Bubble Tea's one hard rule shapes the code: **`Update` must never block.** The SSE reader runs on its own goroutine and feeds `tea.Msg` values through a channel.

### 2.8 Configuration - YAML file for preferences, DB for shared state, keyring for secrets

Three kinds of value, three homes. Putting them in one place is how config files end up holding API keys.

| Value | Home | Why |
|---|---|---|
| Default model, permission mode, theme, keybindings, enabled toolkits, workspace defaults | **`~/.config/amiro/config.yaml`**, overridden by **`./.amiro/config.yaml`** | Hand-editable, diffable, shareable per project |
| Provider API keys, session token | **OS keyring** (`internal/secrets`, already) | A key in YAML is a key in backups and screenshots |
| MCP servers, agents, workflows, threads, per-user preferences | **SQLite** (already) | Both surfaces must see one list; a file copy would drift |

Precedence: CLI flags → project `.amiro/config.yaml` → user `~/.config/amiro/config.yaml` → `AMIRO_*` environment → built-in defaults. Both binaries read the same files, so a default set in the terminal applies in the desktop app.

Ship a generated `schema.json` beside it for editor completion - crush does this (`crush.json` + `schema.json`) and it costs one `go generate`.

### 2.9 Out of scope, permanently

The workflow graph editor (a canvas is not a terminal), the admin user-management panel, and browser OAuth flows for remote MCP servers. The TUI uses servers the desktop authorized; it does not reimplement the flow.

---

## Part 3 - Folder and file structure

```
backend-go/
├── cmd/
│   └── amiro/
│       ├── main.go              # flag parsing, subcommand dispatch, terminal setup/teardown
│       ├── tui.go               # default: resolve transport → run the Bubble Tea program
│       ├── serve.go             # embedded server bootstrap (attach-or-start)
│       ├── auth.go              # login / logout / whoami
│       ├── run.go               # headless one-shot (Phase 6)
│       └── version.go
│
└── internal/
    ├── ai/uimessage/
    │   ├── frame.go             # NEW: typed Frame union over the existing wire format
    │   ├── decode.go            # NEW: SSE bytes → Frame
    │   ├── emitter.go           # NEW: the Emitter interface (Writer already satisfies it)
    │   └── stream.go            # Writer, re-expressed as the SSE encoder of a Frame
    │
    ├── api/chat/
    │   ├── runner.go            # NEW: TurnRequest / TurnResult / RunTurn, cut out of route.go
    │   ├── approver.go          # NEW: Approver iface - headless/eval only (§2.4)
    │   └── route.go             # SHRINKS to: auth, decode, NewWriter, RunTurn
    │
    ├── appwiring/               # NEW: the dependency graph cmd/server builds, extracted
    │   └── wiring.go            #      so the embedded server cannot drift from the sidecar
    │
    └── tui/
        ├── app/
        │   ├── app.go           # root tea.Model: page routing, global keymap, layout
        │   ├── update.go        # message dispatch (frames, keys, resize, errors)
        │   ├── view.go          # header + page + status + modal layer
        │   └── msg.go           # app-level tea.Msg types
        │
        ├── page/
        │   ├── chat.go          # transcript + editor + todo panel
        │   ├── threads.go       # list, search, resume, delete
        │   ├── models.go        # provider/model picker
        │   ├── mcp.go           # MCP servers and their tools
        │   └── settings.go      # provider keys, defaults
        │
        ├── component/
        │   ├── transcript/      # transcript.go · message.go · cache.go (render-once-when-final)
        │   ├── editor/          # editor.go · slash.go · mention.go
        │   ├── toolcard/        # card.go · diff.go · shell.go · files.go · registry.go
        │   ├── approval/        # dialog.go
        │   ├── todo/            # panel.go
        │   ├── status/          # bar.go - model · mode · workspace · tokens · cost · elapsed
        │   └── dialog/          # modal.go · confirm.go · picker.go
        │
        ├── client/
        │   ├── client.go        # the interface every page talks to
        │   ├── http.go          # HTTP + SSE against embedded or attached server
        │   ├── discover.go      # is a sidecar already running for this app-data dir?
        │   └── embedded.go      # start httpserver in-process, return its address
        │
        ├── session/
        │   ├── state.go         # the open thread: messages, in-flight turn, usage
        │   └── reduce.go        # Frame → state; the TUI's projection, mirroring parts.go
        │
        ├── theme/               # theme.go (adaptive, NO_COLOR-aware) · markdown.go (glamour)
        ├── keys/                # keys.go - one keymap, one help view
        └── config/              # config.go - YAML load/merge/precedence (§2.8)
```

Two structural rules, because they are what stops this from rotting:

1. **`internal/tui/client` is the only package under `internal/tui` that knows a transport exists.** Everything above it takes a `Client` and a `Frame`.
2. **`internal/appwiring` is built once and used by both `cmd/server` and `client/embedded.go`.** Two copies of "how Amiro is assembled" drift the first time a repository gains a dependency - this tree already has one bug on record from exactly that (see `toolDeps`' doc comment in `route.go`).

---

## Part 4 - Phased implementation

### Phase 0 - Seams in the existing backend *(no TUI code yet)* - **landed 2026-08-18**

1. ✅ `uimessage.Frame` + `Scanner`/`DecodeFrame` + `Emitter`. - `internal/ai/uimessage/{frame,decode,emitter}.go`
2. ✅ `chat.RunTurn` + `TurnRequest`/`TurnResult`; `Chat(w, r)` reduced to its HTTP edges. - `internal/api/chat/runner.go`
3. ✅ `internal/appwiring` extracted from `cmd/server/main.go`; the sidecar uses it. - `internal/appwiring/wiring.go`, `cmd/server/main.go` down to 112 lines
4. ✅ SQLite WAL + `busy_timeout`. - `internal/db/driver.go`
5. ✅ `chat.Approver` (headless/eval only). - `internal/api/chat/approver.go`

**Verified:** 38 Go packages green (including `tests/e2e`, which spawns the real sidecar binary and SIGTERMs it - the strongest available proof the `appwiring` rewrite of `main.go` is correct), plus the frontend's 351 tests across 28 files. No existing assertion was edited.

Three things differed from the plan, and the reasons matter more than the changes:

- **`Writer` was NOT reimplemented on top of `Frame`, and that was the right call.** The plan said "`Writer` re-expressed as the SSE encoder of a `Frame`". Writing it revealed the flaw: `Frame`'s fields are `omitempty`, so a nil tool input encodes as an *absent* `"input"` key where the existing map literal encodes `"input":null`. Different bytes, on a stream the desktop app parses, under a refactor whose entire purpose was to change nothing about the wire. `Writer` keeps its literals; `Frame` reads them. The drift this leaves - a writer method gaining a field `Frame` does not model - is covered rather than accepted: `TestFrameRoundTripsEveryWriterMethod` drives every method on `Writer` and fails if decoding then re-encoding loses anything.
- **The `Approver` is carried on the context, not passed as a parameter.** The usual advice is the opposite, and three things put this on the right side of that line: it is genuinely request-scoped ("who is watching this turn"), it is optional with a correct zero behavior (no approver ⇒ the existing suspend rail, unchanged), and the alternative was a ninth parameter on a tool loop that already takes eight and is called from five places - four of which would pass `nil` forever. The rule it does not break: nothing *required* is smuggled through context, since a turn with no approver is a complete, correct turn.
- **One deduplication came along for free and is worth naming.** The sentence the model is told when a human declines a tool existed as a literal in `approvals.go` and was about to be written a second time for the `Approver` path. It is now `declinedToolMessage`, used by both. That sentence is a prompt, it is tuned, and a model that gets differently-worded refusals depending on which surface asked is a difference nobody chose.

### Phase 1 - Walking skeleton - **landed 2026-08-18**
`cmd/amiro`, attach-or-embed transport, one chat page, streaming text, `Ctrl+C`, workspace = cwd, thread persisted. Details, deviations and a real `RunTurn` persistence-ordering bug this phase's own tests found: [tui-progress.md](./tui-progress.md#phase-1--walking-skeleton--landed-2026-08-18).

### Phase 2 - The loop made legible - **landed 2026-08-18**
Tool cards (diff / shell / files renderers), reasoning blocks, todo panel, status bar with live tokens/cost/elapsed, interrupt mid-tool. Details, deviations and the real tool-output integration tests this phase added: [tui-progress.md](./tui-progress.md#phase-2--loop-made-legible--landed-2026-08-18).

### Phase 3 - Interaction - **landed 2026-08-18**
Approval dialog on the existing rail (§2.4); live permission-mode switching; slash commands; model picker; thread switcher and `--thread` resume. Details, deviations, and two real pre-existing bugs this phase found and fixed (a silent desktop-app approval-answer bug, and a TUI transcript-duplication bug): [tui-progress.md](./tui-progress.md#phase-3--interaction--landed-2026-08-18).

### Phase 4 - Mentions and configuration - **landed 2026-08-18**
`@`-mentions (MCP tools, agents, workflows, default tools); YAML config (§2.8); settings page; `/compact`; `/export`. Details, deviations (no `schema.json` yet, no `page/mcp.go`), and a second real pre-existing bug this phase found and fixed (the Export endpoint never actually returned its share id): [tui-progress.md](./tui-progress.md#phase-4--mentions-and-configuration--landed-2026-08-18).

### Phase 5 - Attach and multi-client - **landed 2026-08-18**
`--connect`, explicit attach to a running desktop sidecar, two clients on one thread. Details, deviations, and why the multi-client property needed proving rather than building: [tui-progress.md](./tui-progress.md#phase-5--attach-and-multi-client--landed-2026-08-18).

### Phase 6 - Headless - **landed 2026-08-18**
`amiro run "prompt"` over `RunTurn` directly, `--json` dumping the `session.Log`, non-zero exit on failure. Details, deviations, and two real bugs this phase's own manual smoke test found (RunTurn's mid-stream errors don't come back as a Go `error`; Appendix A's own documented trailing-flags invocation didn't parse): [tui-progress.md](./tui-progress.md#phase-6--headless--landed-2026-08-18).

---

## Part 5 - Testing: how each phase is proven on **both** surfaces

The reference implementations all test in the same five layers. This is the part of the plan to copy most literally.

**What they actually do:**
- **codex**: `wiremock` fake model server in *both* `core` and `tui` test suites · 673 `insta` snapshots in `tui` · `vt100` terminal emulation asserting real screen contents (`terminal.backend().vt100().screen().contents()`) · `app-server/tests/suite/**` drives the **real binary** over JSON-RPC via a dedicated `app-server-test-client` crate · `exec/` has its own event-output tests for the headless surface.
- **crush**: 363 `.golden` files via `charmbracelet/x/exp/golden` · `internal/server/e2e_test.go` with a reusable `e2eHarness` (httptest server + backend + SSE subscription, cleanup-ordered) · `multiclient_test.go`, `agent_cancel_test.go`, `sessions_isbusy_test.go`.
- **opencode**: `packages/tui/test/{component,util}` unit tests per component.

### Layer 1 - Core behavior *(surface-independent)*
`internal/api/chat` against the fake `Engine`. Golden persisted parts, approvals, budgets, compaction, subagents. **Mostly exists already** - `parts_golden_test.go`, `tool_loop_test.go`, `approvals_test.go`, `tool_scheduler_test.go`.
*New in Phase 0:* a test driving a full multi-step tool turn through `RunTurn` that reproduces `TestToolLoop_PersistedPartsGolden` byte-for-byte. That test is the gate on the extraction.

### Layer 2 - Protocol contract *(the shared truth both surfaces depend on)*
One recorded turn → assert the **exact SSE frame sequence** as a golden file, then assert `Decode(Encode(f)) == f` for every frame kind.
This is the single most valuable new test in the plan: it is what makes "the TUI and the desktop see the same thing" a checked property instead of a hope. The golden file becomes the fixture both Layer 3 suites replay.

### Layer 3 - Per-surface rendering
- **TUI:** `teatest` + `x/exp/golden` at fixed widths (80 and 120). One golden per component state, not per pixel. Plus `lipgloss`/`x/ansi` width assertions for CJK and emoji.
- **Desktop:** the frontend's stream consumer fed the **same Layer 2 golden fixture**, asserting the rendered message parts. This is new work - today `src/**` has 28 vitest unit tests and no stream-level test - and it is the cheapest credible way to satisfy "check the desktop every phase" without a Tauri e2e rig.

### Layer 4 - Cross-surface parity *(the "same turn" test)*
One fixture, replayed through both renderers, asserting they agree on: tool calls and their order, approval requests, final assistant text, and usage totals. A frame the TUI renders and the desktop drops (or vice versa) fails here.

### Layer 5 - Multi-client end-to-end
crush's `multiclient_test.go` adapted: an embedded server, two clients on one thread, assert both receive the same event stream and the persisted thread is intact. Covers the desktop-open-while-TUI-runs case directly.

### Per-phase exit criteria

No phase is done until **all four columns** pass.

| Phase | Backend gate | TUI gate | Desktop gate | Manual smoke |
|---|---|---|---|---|
| **0** | `RunTurn` golden-parts test passes; full existing suite green with no assertion edits; Layer 2 frame-sequence golden created; WAL pragma test | - | Full `pnpm test`; frontend consumes the Layer 2 fixture unchanged | Launch desktop app, send a tool-using message, confirm streaming and persistence unchanged |
| **1** | Layer 1 unchanged | Chat page golden at 80/120; streaming-text reduce test | Layer 2 golden unchanged (byte-for-byte) | `cd repo && amiro`, ask a question; reopen the thread in the desktop app and confirm it is identical |
| **2** | - | Golden per tool card (diff, shell, files, generic); interrupt-mid-tool test | Same thread renders correctly in the desktop app; tool-presenter tests green | Run "read 3 files, edit 1, run tests" in both surfaces; compare |
| **3** | Approval rail tests extended for a non-browser client | Approval dialog golden; mode-switch test | Approval card still renders and resubmits correctly | Grant "always allow" in the TUI; confirm the desktop app stops asking in that thread |
| **4** | Mention-resolution tests cover the TUI's request shape | Mention/slash completion tests; config precedence table test | Settings written by the TUI appear in the desktop app | Define an agent in the desktop app; `@`-mention it in the TUI |
| **5** | Layer 5 multi-client e2e | Attach-mode client test against `httptest` | Desktop unaffected while a TUI is attached | Desktop app open, `amiro --connect` to it, drive the same thread from both |
| **6** | `amiro run` exit codes; `--json` log schema test | - | - | `amiro run "..." --json \| jq` in CI |

### Two rules learned from the references

1. **Golden files at one or two widths, behavior assertions everywhere else.** 673 snapshots works for codex because they snapshot *components*, not whole screens at many sizes.
2. **A fake model, never a live one, in the default suite.** codex uses `wiremock`; Amiro's `Engine` interface is better - it is already the seam. Live-provider tests stay behind a build tag, as `client_live_test.go` already does.

---

## Part 6 - Build and distribution

- `go build -o amiro ./cmd/amiro`. No cgo (`glebarez/sqlite` is pure Go), so cross-compilation stays trivial.
- The Tauri sidecar build (`src-tauri/build-sidecar.{sh,ps1}`) builds `cmd/server` and is untouched.
- `scripts/build-tui.sh` mirroring the sidecar script; `dev:tui` in the root `package.json`.
- Both binaries read the same config files, app-data directory and `AMIRO_*` variables - a machine with the desktop app installed needs no extra setup for the terminal.

---

## Part 7 - Risks

| Risk | Mitigation |
|---|---|
| **`RunTurn` extraction changes behavior silently** | The golden persisted-parts test is the gate; it already exists and already covers a multi-step tool turn |
| **Frame typing changes the wire format** | Layer 2 golden + the existing `Headers` map and `parts_golden_test.go` pin the bytes |
| **Embedded and sidecar wiring drift** | One `internal/appwiring` package, used by both |
| **Markdown rendering cost on long threads** | Render each message once when final, cache by (content, width); stream the in-flight tail unstyled |
| **Width correctness** - CJK, emoji, ANSI | `x/ansi` for every truncation; never `len()` on display strings |
| **Keyring unavailable over SSH / headless Linux** | `internal/secrets` already has a file-store fallback; must not hard-fail |
| **Desktop has no e2e harness today** | Layer 2/3/4 fixture replay is the substitute; a Tauri Playwright rig stays optional |
| **Feature drift between surfaces** | One `RunTurn`, one protocol, and Layer 4 parity tests that fail when they diverge |

---

## Appendix A - Command surface

```
amiro                                  # TUI in the current directory (attach-or-embed)
amiro -C <dir>                         # …in another directory
amiro --model <provider>/<model>
amiro --mode plan|interactive|edit|auto
amiro --thread <id>                    # resume
amiro --connect <url> --token <tok>    # explicit attach
amiro run "<prompt>" [--json] [--yes]  # headless
amiro threads [--limit N]
amiro auth login | logout | whoami
amiro config path | validate
amiro version
```

## Appendix B - Keymap (proposed)

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` / `Ctrl+J` | Newline |
| `Ctrl+C` | Interrupt the turn; again on an idle prompt to quit |
| `Esc` | Close dialog / cancel completion |
| `Tab` | Accept completion |
| `Ctrl+T` / `Ctrl+O` / `Ctrl+P` | Threads / models / command palette |
| `Ctrl+R` | Toggle reasoning blocks |
| `Ctrl+E` | Expand/collapse focused tool card |
| `y` / `n` / `a` | Approve once / deny / always allow |
| `PgUp` / `PgDn` | Scroll transcript |
| `?` | Help |

## Appendix C - Sources

- [openai/codex](https://github.com/openai/codex) - `codex-rs/{core,protocol,tui,exec,app-server}`, cloned 2026-08-18
- [charmbracelet/crush](https://github.com/charmbracelet/crush) - `internal/{backend,proto,server,client,ui}`, cloned 2026-08-18
- [sst/opencode](https://github.com/sst/opencode) - `packages/{core,protocol,sdk,tui,desktop}`, cloned 2026-08-18
- [OpenCode server docs](https://opencode.ai/docs/server/) · [opencode architecture (DeepWiki)](https://deepwiki.com/sst/opencode)
- [Claude Code overview](https://code.claude.com/docs/en/overview) · [Claude Code platforms](https://codingnomads.com/claude-code-platforms-ide-integrations)
