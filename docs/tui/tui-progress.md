# Amiro TUI - Build Log

> **Historical Record:** This document records the earlier Go backend and Bubble Tea TUI (`backend-go/cmd/amiro`), which have since been retired and removed. Amiro now uses the native Rust backend (`backend/`, binary `amiro-backend`) and the vendored Rust runtime (`runtime/`, binary `amiro-runtime`), which includes its own Rust TUI (`runtime/crates/amiro-tui`).



**Companion to [tui-implementation-plan.md](./tui-implementation-plan.md).** The plan says what to build and why; this says what is actually built, what it cost, and what the next person needs to know before touching it.

> **If you are the agent picking this up: you are expected to append to this file.**
> Finish a phase → add an entry in the same shape as the ones below, *before* reporting done. Record what landed with file paths, every deviation from the plan and why, the exact commands that verified it, and anything that cost you time and would cost the next person the same. An entry that only lists files is not worth writing - the reasons are the part that does not survive in the diff.

---

## Status at a glance

| Phase | State | Landed |
|---|---|---|
| **0 - Backend seams** | ✅ Done | 2026-08-18 |
| **1 - Walking skeleton** | ✅ Done | 2026-08-18 |
| **2 - Loop made legible** | ✅ Done | 2026-08-18 |
| **3 - Interaction (approvals, modes, pickers)** | ✅ Done | 2026-08-18 |
| **4 - Mentions and configuration** | ✅ Done | 2026-08-18 |
| **5 - Attach and multi-client** | ✅ Done | 2026-08-18 |
| **6 - Headless** | ✅ Done | 2026-08-18 |

`cmd/amiro` is a real terminal client: attach-or-embed transport, one chat page with tool cards, reasoning, a todo panel and a live status bar. See the Phase 1 and Phase 2 entries below.

---

## State of the tree

Everything below is current as of 2026-08-18 (post-Phase-1) and worth knowing before your first edit.

**Build and test, from `backend-go/`:**

```bash
go build ./...                 # must stay clean
go test ./...                  # all green
go test -count=1 ./tests/... ./internal/httpserver/... ./internal/api/chat/... ./internal/tui/...
                                # e2e spawns the real sidecar binary - run this after touching cmd/ or appwiring
go build -o amiro ./cmd/amiro  # the terminal client itself
```

`cmd/amiro` exists now. `charmbracelet/{bubbletea,bubbles,lipgloss}` and `x/exp/golden` (test-only) are direct `go.mod` requires; `x/ansi` is pulled in transitively (bubbles/bubbletea depend on it) but nothing in this tree imports it directly yet - Phase 1's transcript is plain text with no truncation to get width-correct. `x/exp/teatest` was fetched per the plan's stack list, then `go mod tidy` dropped it again: the golden tests ended up driving `page.Chat.Update` directly (see "Deviations" below) rather than through a full `tea.Program`, so nothing imports it. Worth pulling back in for Phase 2+ if a test needs a real program loop (key sequences, timing) rather than direct message dispatch.

**Frontend, from the repo root:** `pnpm test` - 28 files, 351 tests, all green. This is the desktop gate. `pnpm test:e2e` is scripted but **there is no `playwright.config`** - desktop end-to-end does not exist, and the plan's Layer 3 fixture-replay is the substitute.

**The working tree was already dirty before any of this work** - a large body of unrelated uncommitted changes (search providers, chat-graph, plan tools, i18n). Do not assume an untracked file is yours. `git status` is not a useful summary of TUI work; this document is.

**Reference implementations** were cloned into the session scratchpad to verify the architecture (`openai/codex`, `charmbracelet/crush`, `sst/opencode`). That scratchpad is session-scoped and is gone. Re-clone if you need them; the findings are recorded in Part 2 of the plan, so re-reading them is usually unnecessary.

---

## Phase 0 - Backend seams - landed 2026-08-18

No TUI code. The point was to put the seams in place so that Phase 1 adds a client rather than a second agent.

### What landed

| Item | Files |
|---|---|
| Typed protocol: `Frame`, `Scanner`, `DecodeFrame`, `Emitter` | `internal/ai/uimessage/{frame,decode,emitter}.go` |
| `RunTurn` - the transport-neutral turn | `internal/api/chat/runner.go` (new), `route.go` (shrunk to decode → authorize → `RunTurn`) |
| `internal/appwiring` - one object graph, used by every entrypoint | `internal/appwiring/wiring.go`, `cmd/server/main.go` (down to 112 lines) |
| SQLite WAL + `busy_timeout` | `internal/db/driver.go` |
| Optional `Approver` for headless/eval | `internal/api/chat/approver.go`, gate wired in `tool_scheduler.go` |
| `*uimessage.Writer` → `uimessage.Emitter` at 5 call sites | `compact.go`, `tool_loop.go` (×2), `tool_scheduler.go` (×2) |

~2,000 lines, roughly half tests.

### Deviations from the plan, and why

- **`Writer` was NOT reimplemented on top of `Frame`.** The plan asked for it; writing it exposed the flaw. `Frame`'s fields are `omitempty`, so a nil tool input encodes as an *absent* `"input"` key where the existing map literal encodes `"input":null` - different bytes, on a stream the desktop app parses, under a refactor whose entire purpose was to change nothing about the wire. `Writer` keeps its map literals; `Frame` reads them. The drift this leaves is covered by `TestFrameRoundTripsEveryWriterMethod`, which drives every method on `Writer` and fails if a decode/re-encode round trip loses a field. **Do not "finish" this by making `Writer` encode `Frame`s without first proving byte-identity on the nil cases.**
- **`Approver` is carried on the context** (`WithApprover`), not as a parameter. It is request-scoped, optional with a correct zero behavior, and the alternative was a ninth parameter on a tool loop that already takes eight and is called from five places - four of which would pass `nil` forever.
- **One dedup:** the "user declined this tool" sentence is now `declinedToolMessage`, shared by the client rail and the `Approver` path. It is a tuned prompt; two surfaces phrasing a refusal differently is a difference nobody chose.

### Verification actually run

```bash
go build ./... && go vet ./...
go test ./...                                              # 38 pkgs green
go test -count=1 ./tests/... ./internal/httpserver/ \
        ./internal/api/chat/ ./internal/db/                 # uncached
pnpm test                                                   # 351 frontend tests green
```

No existing test assertion was edited. `tests/e2e` is the strongest signal on the `appwiring` change - it spawns the real sidecar binary, reads `PORT=` off stdout and SIGTERMs it.

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `TestFrameRoundTripsEveryWriterMethod` | `Frame` drifting behind `Writer` |
| `TestRunTurn_PersistsBothSidesAndReportsTheTurn` | A step of the extracted handler quietly not happening |
| `TestRunTurn_ContinuingWritesOneRowNotTwo` | The approval-resume path (a known past bug: one assistant row per approval) |
| `TestRunTurn_RefusesWorkItMayNotDo` | The four pre-stream failures, and that none writes to the stream first |
| `TestRunTurn_StreamFramesGolden` | **The protocol contract.** The exact frame sequence both surfaces render from |
| `TestApprover_*` (5) | once / always / deny / error-is-not-a-yes / nil-still-suspends |
| `TestOpen_SQLite*` (2) | WAL actually applied; two live connections to one file |

### Things that cost time - read before repeating them

- **`run_shell` is `tools.RiskExec`, not `RiskExternal`.** `RiskExternal` is explicitly *allowed* by the permission engine ("external calls are not gated yet", `permission.go`). A test written against `RiskExternal` will never reach the approval branch and the failure looks like the approver is broken.
- **Golden files regenerate with `UPDATE_GOLDEN=1`**, e.g. `UPDATE_GOLDEN=1 go test ./internal/api/chat -run TestRunTurn_StreamFrames`. Read the diff - `testdata/turn_frames.jsonl` is the contract both clients depend on, and `testdata/persisted_parts.json` is what every already-saved thread renders from.
- **`gofmt -l ./internal` reports pre-existing drift** in files nobody touched (`bifrost/client.go`, `httpserver/router.go`, `pricing/pricing.go`, `db/models/search_provider.go`, and others). Check only your own files or you will chase someone else's formatting.
- **The frame golden normalizes generated ids and `durationMs`.** Anything else non-deterministic you add to the stream needs the same treatment in `normalizeFrame`, or the test flakes.
- **`Usage` serializes with Go field names** (`PromptTokens`, not `promptTokens`) because `bifrostai.Usage` has no JSON tags. This is pre-existing and the frontend already reads it that way (`src/app/(chat)/(admin)/admin/providers/test/page.tsx`). Not a bug - do not "fix" it without checking every consumer.
- **A `Handler` for tests needs only `chats` and `engine`.** `resolveAgent`, `loadMCPTools` and `loadWorkflowTools` are all nil-tolerant, so `NewHandler(chatRepo, nil, engine, nil, nil, nil, nil, nil, nil, nil, nil)` is a complete test handler. Thread inserts do need a real user row (foreign keys are ON) - register one through `auth.NewService(gdb).Register`.

### What Phase 1 can now assume

- `chat.RunTurn(ctx, TurnRequest, uimessage.Emitter)` runs a complete turn with no HTTP anywhere.
- `uimessage.NewScanner(r)` decodes an SSE stream into typed `Frame` values - this is what the TUI's client reads.
- `appwiring.New(ctx, cfg)` builds the whole backend; `AttachPort(ctx, port)` finishes the parts that need a bound port. An embedded server is `appwiring.New` + `httpserver.New(cfg, app.Handlers)` + a loopback listener.
- Two processes can open the SQLite file at once without `database is locked`.
- `chat.AutoApprove` and `chat.WithApprover` exist for the headless path (Phase 6) - **not** for the TUI, which uses the client approval rail like the desktop app does.

---

## Phase 1 - Walking skeleton - landed 2026-08-18

`cmd/amiro` exists: attach-or-embed transport, one chat page streaming text into a viewport, Ctrl+C to interrupt then quit, workspace = cwd, thread created and persisted, `amiro auth login/logout/whoami`.

### What landed

| Item | Files |
|---|---|
| Discovery lock file (attach-or-embed's "is a sidecar already running") | `internal/appwiring/lock.go`; written by `cmd/server/main.go` and by the embedded path |
| `internal/tui/client` - the only package under `internal/tui` that knows a transport exists | `client.go` (the `Client` interface), `http.go` (HTTP+SSE impl + auth calls), `discover.go`, `embedded.go` |
| `internal/tui/session` - Frame → state projection | `state.go`, `reduce.go` |
| `internal/tui/{app,page,keys,theme}` - the chat page itself | `app/app.go`, `page/chat.go`, `keys/keys.go`, `theme/theme.go` |
| `cmd/amiro` - main, TUI launch, transport resolution, session resolution, auth subcommands | `main.go`, `tui.go`, `serve.go`, `session.go`, `auth.go`, `version.go` |
| Bubble Tea stack in `go.mod` | `bubbletea`, `bubbles`, `lipgloss` (direct), `x/exp/golden` (test-only), `x/term` (password prompt) |
| A real correctness bug in `RunTurn`, found by this phase's own tests and fixed | `internal/api/chat/runner.go` - see "Things that cost time" |
| `KeyringStore.Get` no longer hard-fails when the OS keyring backend itself is unreachable | `internal/secrets/keyring_store.go` |

### Deviations from the plan, and why

- **No `component/`, no `session/reduce.go`-vs-`app/update.go` split beyond what one page needs.** The plan's Part 3 folder tree has `component/{transcript,editor,toolcard,approval,todo,status,dialog}` and `app/{update.go,view.go,msg.go}` as separate files. Phase 1 has exactly one page and no tool cards, no approval dialog, no status bar - building that scaffolding now would be six near-empty files nothing calls yet. `app/app.go` is a thin pass-through to `page.Chat`; `page/chat.go` owns its own `Update`/`View` and its own `frameMsg`/`streamEndMsg` types (the plan puts frame dispatch at the app level in `app/update.go`, which will matter once a second page needs frames - Phase 2/3's job, not this one's).
- **Golden tests drive `page.Chat.Update` directly, not through `teatest`'s `tea.Program` harness.** `x/exp/teatest` runs a real program loop over an in-memory PTY-like reader/writer with timing waits (`WaitFor`, `WithCheckInterval`) - built for asserting on keystroke sequences and timing-sensitive behavior. Phase 1's need was simpler and fully deterministic: feed a known `Frame` sequence through `Update` and assert the rendered `View()` at two widths. Calling `Update` directly is faster, has no timing to flake on, and is what `internal/tui/page/chat_test.go` does with `charmbracelet/x/exp/golden` for the comparison. `go mod tidy` dropped `teatest` from `go.mod` as a result - it's one `go get` away when a test genuinely needs a running program.
- **The discovery mechanism (a lock file: pid, port, shared-secret token, in `AppDataDir`) is not in the plan's Part 3 file list.** The plan describes `discover.go`'s job ("is a sidecar already running for this app-data dir?") without saying how it knows. Nothing in the existing tree published a running sidecar's port anywhere outside the Tauri parent process's own stdout pipe - Rust reads `PORT=` off the child it spawned; a second, unrelated `amiro` process has no way to see that. `internal/appwiring/lock.go` adds `WriteLock`/`ReadLock`/`RemoveLock` over a JSON file at `AppDataDir/sidecar.lock.json`; `cmd/server/main.go` writes one on startup (removed on shutdown) and the embedded path does the same. Liveness is a real HTTP round trip to `/health` with the lock's own token (`client.Discover`), not just "the file exists" - a lock file left behind by a `SIGKILL`ed process is not proof of a live server.
- **Auth: a stored session always wins over auto-provisioning, and auto-provisioning only ever fires once.** The plan's §2.5 says `amiro auth login` stores a token and separately (§3, inherited from the desktop app's pre-existing `EnsureDesktopDefaultUser`) that desktop should need no login screen by default. Those two pull against each other: if every plain `amiro` launch auto-provisioned the desktop-default local user, it would silently overwrite a real account's stored session on every run. `cmd/amiro/session.go`'s `resolveSession` resolves the conflict: check the stored session first (validated with a live `Whoami` call); only when nothing is stored *and* this process owns the server it's talking to (embedded, never attached - fabricating a session against a stranger's already-running backend is not a convenience) does it fall back to `EnsureDesktopDefaultUser`, and it persists that result, so the fallback never fires twice.
- **`amiro auth login` doubles as signup.** Not explicitly in the plan, but `POST /api/auth/login` can never succeed against a server with zero accounts, and a CLI that requires a separate `amiro auth register` for the obvious first-run case is a worse first five minutes. It checks `IsFirstUser` and calls `Register` instead when true.

### Verification actually run

```bash
go build ./... && go vet ./...                                            # clean
go test ./...                                                             # all green
go test -count=1 ./tests/... ./internal/httpserver/... \
        ./internal/api/chat/... ./internal/tui/... ./internal/secrets/... # uncached, 8x repeated for the new client tests specifically (flakiness check)
pnpm test                                                                  # 28 files / 351 tests, unchanged from Phase 0 -- the desktop gate
```

Golden regeneration: `go test ./internal/tui/page/... -run TestChat_Golden -update`.

Manual smoke, to the extent this sandbox allows (no TTY, no live model provider - see the last bullet below for exactly what that leaves unverified):
- `amiro auth login/whoami/logout` end to end against a throwaway `AMIRO_APP_DATA_DIR`, including the just-logged-out `whoami` (the case that exposed the keyring bug below).
- A standalone probe program exercising `client.Discover` (nothing running → false), `client.StartEmbedded` (starts, writes the lock file), `EnsureDesktopDefaultUser` + `Whoami` over real HTTP, then `client.Discover` again while the embedded server is still up (finds it, reports healthy) - the attach-or-embed contract, end to end, minus an actual second OS process.
- `amiro` with no subcommand in a directory with no TTY: fails with a clean `could not open a new TTY` rather than hanging, and the deferred `transport.Close()` still runs (lock file gone afterward) - proof the transport/session resolution that happens *before* the Bubble Tea program starts is sound, even though the interactive program itself couldn't be driven here.

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `internal/tui/session/reduce_test.go` (4 tests) | Streaming text accumulates on one message in order; a tool step between two text spans doesn't split the message (the same bug class `RunTurn`'s own doc comment names for the browser side); `Interrupted`/`Failed` leave already-streamed text intact |
| `internal/tui/client/http_test.go` (3 tests) | **The real find of this phase.** Real `httptest.Server` + real router + real auth + a fake `Engine` (never a live model, per the plan's own testing rule) + real SSE decode. `TestHTTPClient_SendMessage_ThreadIsCreatedAndPersisted` is what caught the `RunTurn` persistence race - see below. `TestHTTPClient_SendMessage_CancelInterruptsCleanly` proves Ctrl+C's cancel path closes the frame channel and reports `ctx.Err()` rather than hanging or surfacing a generic transport error |
| `internal/tui/page/chat_test.go` (3 tests × 2 widths) | The Phase 1 TUI gate's golden requirement: transcript + composer + status line at 80 and 120 columns, mid-stream / finished / interrupted. The finished-state goldens are the ones that actually exercise width-dependent wrapping differently (a short mid-stream fragment doesn't wrap at either width, which is why a longer final paragraph was used) |
| `TestKeyringStore_*` (existing, now exercised for real rather than skipped) | See below - fixing `Get` turned an environment-dependent `t.Skip` into a real pass in this sandbox |

### Things that cost time - read before repeating them

- **`RunTurn` persisted the turn *after* writing the stream's `[DONE]` frame, not before.** `httptest.NewRecorder()` (what every existing test in this tree uses) has no live connection for a client to act on early, so this was never observable until `internal/tui/client`'s tests stood up a real `httptest.Server` and read the stream at wire speed. A client that reads `[DONE]` and immediately re-fetches the thread (exactly what `TestHTTPClient_SendMessage_ThreadIsCreatedAndPersisted` does, and exactly what "ask a question, then reopen that thread" does at human pace too, just with enough of a gap that it never showed) could observe zero or one of the turn's two messages, deterministically, not intermittently - because SSE frames are flushed to the wire as `em.*` methods are called, well before the handler goroutine reaches the persistence code that runs after them. Fixed by moving persistence (both messages) to run *before* `em.Finish`/`em.Done`, so `[DONE]` means what every reader already assumes it means: the turn is saved. This is a two-line reorder in `runner.go`, not a new code path, and every existing `internal/api/chat` test - including the frame-sequence golden - still passes unchanged, because the *sequence and content* of frames didn't change, only when persistence happens relative to them.
- **The same reorder is also why persistence now runs against `context.WithoutCancel(ctx)`, not `ctx`.** Once a turn is interrupted mid-loop (`ctx` already canceled), `RunTurn`'s own doc comment promises the partial turn still gets persisted - a promise `ctx` itself can't keep once canceled. `context.WithoutCancel` (already precedented in this tree, `appwiring.go`'s `MCP.Init`) keeps request-scoped values while dropping the cancellation.
- **`internal/secrets.KeyringStore.Get` returned a raw D-Bus error instead of `ok=false` when the OS keyring backend itself was unreachable and the key wasn't in the file-store fallback either** - this exact sandbox (a session D-Bus with no `org.freedesktop.secrets` provider registered) hits it. The existing test suite already knew about this failure mode (`skipIfHeadless` in `keyring_store_test.go`, added before this phase) but treated it as an environment limitation to skip around rather than a bug to fix - which meant `amiro auth whoami` after a `logout`, in exactly this environment, crashed with a D-Bus error instead of printing "not signed in". Fixed in `Get`: when the backend errors and the fallback file doesn't have the key either, that's "not set", the same as any other miss - never a hard error. This also means `TestKeyringStore_RoundTripSetsAndGetsValues` and `TestKeyringStore_DeleteRemovesKey`, previously skipped in this environment, now genuinely pass here (`Set`'s fallback already worked; `Get`'s didn't).
- **No real model provider and no real TTY in this sandbox** - the two things "ask a question in the TUI, watch it stream, reopen in desktop" actually needs live. Substituted with the strongest verification available short of that: a real HTTP+SSE round trip against a fake `Engine` (proves the wire path end to end, same rule the rest of this test suite already follows - never a live model in the default suite) for the streaming/persistence half, and a standalone probe hitting the real attach-or-embed/session code for the transport half. The genuinely-untested slice is Bubble Tea's own event loop against a real terminal (key repeat, resize, rendering to an actual VT100) - worth an explicit human smoke test (`cd` into a real repo, `amiro`, ask something, reopen in the desktop app) before this is fully trusted, since nothing here can substitute for that on this machine.
- **`chatapi.NewHandler` takes eleven positional arguments and several are untyped `nil`.** Building the fake-engine test server needed one; get the order wrong and it fails at runtime, not compile time (most are same-shaped repository pointers). Copied the exact call from `internal/httpserver/chat_routes_test.go` rather than reconstructing it from `NewHandler`'s signature.

### What Phase 2 can now assume

- `internal/tui/client.Client` is a working, tested seam - `SendMessage` streams real frames over real HTTP, with the wait-for-completion/interrupt contract already covered. Phase 2's tool cards, reasoning blocks and status bar are consumers of `session.State`/`session.Reduce`, not of the transport.
- `session.State`/`Reduce` already has the shape Phase 2 extends: `Message` currently carries only `Text`; adding tool-call and reasoning fields is additive, and the existing reduce tests pin the text-accumulation behavior that must not regress.
- `[DONE]` now means "persisted", not just "streamed" - safe to build a "switch threads" or "reopen" feature against that assumption without re-verifying it.
- The discovery lock file (`appwiring.WriteLock`/`ReadLock`) is the mechanism Phase 5's explicit `--connect` and multi-client work builds on; Phase 1 only uses it for same-machine, same-`AppDataDir` attach-or-embed, but the format (pid, port, token) has no changes anticipated.
- `cmd/amiro/session.go`'s `resolveSession` is the one place identity resolution happens - Phase 3's live permission-mode switching and Phase 4's settings page should read the signed-in user through the same `*client.HTTPClient` this returns, not re-derive it.

---

## Phase 2 - Loop made legible - landed 2026-08-18

Tool cards (diff/shell/files/generic), reasoning blocks, a live todo panel, a status bar (model · mode · workspace · tokens · cost · elapsed), interrupt mid-tool. No backend changes - this phase is `internal/tui/**` only.

### What landed

| Item | Files |
|---|---|
| `session.Message` grew from a flat string into ordered `Parts` (text/reasoning/tool), plus thread-scoped `Todos`/`Model`/`Usage`/`DurationMS` | `internal/tui/session/state.go`, `reduce.go` |
| Tool call lifecycle: `ToolPending → ToolDone / ToolError`, and `ToolInterrupted` for a call Ctrl+C catches with no result yet | `internal/tui/session/state.go` (`abandonPendingTools`) |
| `component/toolcard` - diff/shell/files/generic card renderers, plus a `todo_write`/`todo_read` renderer added mid-phase (see Deviations) | `card.go`, `diff.go`, `shell.go`, `files.go`, `plan.go`, `registry.go` |
| `component/todo` - the live plan as a one-line panel | `panel.go` |
| `component/status` - the model/mode/workspace/tokens/cost/elapsed bar, with width-based field-dropping | `bar.go` |
| `theme.Theme` grew reasoning, tool-border-by-status, diff add/remove/context, todo-status and status-bar styles | `internal/tui/theme/theme.go` |
| `page.Chat` now renders `Parts` (cards + reasoning), a variable-height todo row, a live elapsed clock (`tea.Tick`), and an injectable clock for deterministic tests | `internal/tui/page/chat.go` |

### Deviations from the plan, and why

- **`todo_write`/`todo_read` got a dedicated card, though the plan's Phase 2 exit criteria names only "diff / shell / files / generic".** Built the tool-turn golden first with them falling through to `renderGeneric`, and the result was a raw JSON blob (`{"items":[...]}`) sitting in the middle of an otherwise-legible transcript - directly working against this phase's own name. `component/toolcard/plan.go` adds a one-line "N done · N in progress · N pending" card; the full list stays exclusively `component/todo`'s job (thread-scoped, always visible), so the card never duplicates it.
- **Every renderer decodes tool input/output through its own small mirrored struct instead of importing `internal/ai/tools`.** That package pulls in `agent/lsp`, `agent/memory`, `agent/workspace` and `db/repository` - real backend weight - into a client whose entire architectural point (plan §2.2) is knowing nothing about the server's insides beyond the wire protocol. `internal/tui/client/http.go` already set this precedent for the request side (Phase 1); this phase is the same call for the response side. The risk this creates - a mirror struct drifting from the real Go tool's JSON tags - is exactly what `internal/tui/component/toolcard/integration_test.go` exists to catch: it runs the *real* `read_file`/`edit_file`/`run_shell`/`list_dir` tools against a real temp workspace and asserts the real output renders correctly, not a hand-written fixture that could be wrong the same way twice.
- **The status bar's "mode" field is a hardcoded `"interactive"` constant.** Live permission-mode switching is Phase 3's job (`docs/tui-implementation-plan.md`'s own phase breakdown); the field exists now because the plan names it as part of the bar's shape, and a bar that's missing a column when Phase 3 lands is a worse diff than a bar with one static value now.
- **`page.Chat` gained an injectable clock (`now func() time.Time`, defaulting to `time.Now`).** The elapsed-time field is genuinely live (a `tea.Tick` every second while streaming), and golden tests cannot depend on how fast the test binary happens to run. `chat_test.go`'s `fakeClock` sets `m.now` directly (same package, no exported seam needed) and advances it explicitly between steps, so every golden's elapsed value is chosen, not measured.
- **Cost is omitted, not shown as `$0.00`, for any model the pricing catalog doesn't recognize.** `pricing.Catalog.GetModelPrice`'s `found` return exists for exactly this; showing a zero cost for a real (just unpriced-in-the-static-fallback) model would read as "this is free," which is a worse lie than showing nothing.
- **A real bug caught while writing `component/status/bar.go`, fixed before it shipped rather than landing and finding it later:** the width-fitting check first measured the *styled* string (post-`lipgloss.Style.Render`, ANSI codes included) against the target column width, which would have overestimated width and elided fields a real color terminal had room for - invisible in this sandbox's test environment (color is auto-disabled for non-tty output, so the styled and unstyled string were byte-identical there) and only reachable in a real terminal. Fixed by measuring the raw joined fields and rendering the style only on the final string.

### Verification actually run

```bash
go build ./... && go vet ./...                                     # clean
go test ./...                                                      # all green
go test -count=1 ./tests/... ./internal/httpserver/... \
        ./internal/api/chat/... ./internal/tui/...                 # uncached; internal/tui/... repeated 3x for flakiness
pnpm test                                                           # 28 files / 351 tests, unchanged -- no backend/wire touched this phase
```

Golden regeneration: `go test ./internal/tui/component/toolcard/... -run TestToolCard_Golden -update`, `go test ./internal/tui/page/... -run TestChat_Golden -update`.

Manual smoke, same sandbox constraints as Phase 1 (no TTY, no live model provider - noted honestly rather than glossed over):
- The plan's own Phase 2 manual-smoke scenario ("read 3 files, edit 1, run tests") is `TestChat_Golden_ToolTurn`: the exact frame sequence a real turn like that produces, replayed through the real `Update`/`Reduce`/`View` path and golden-checked at 80 and 120 columns. This is the strongest replay-based substitute available without a live model, same reasoning Phase 1's `internal/tui/client` tests used a fake `Engine` instead of asserting against nothing.
- `internal/tui/component/toolcard/integration_test.go` goes one step further than a replay: it runs the *real* `read_file`, `edit_file`, `run_shell` and `list_dir` tool implementations (`internal/ai/tools`) against a real temp workspace and feeds their real output into `toolcard.Render`, asserting on content only the real tool run could have produced (the real line count, the real diff's `+`/`-` lines, the real shell stdout and exit code). This is real tool execution without needing a live LLM - only "which tool to call next" needs a model, and the test scripts that part directly.
- Genuinely unverified in this sandbox: the interactive program against a real terminal (does a tool card actually look right in a real 24-bit-color iTerm2 or a 16-color SSH session; does the live elapsed clock visibly tick). Worth an explicit human pass before trusting this fully - same caveat Phase 1 recorded, still true.

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `internal/tui/session/reduce_test.go` (+6 tests) | Tool calls land as their own `Part` with real input/output attached; reasoning is a distinct part, excluded from `Text()`; a tool's own error doesn't touch the turn-level `Err`; **the interrupt-mid-tool contract** (`TestState_Interrupted_MarksAnyPendingToolCallInterrupted`) - a pending call gets marked `ToolInterrupted`, a completed one is left alone; `todo_write` replaces `State.Todos` wholesale, not append; Finish-frame metadata populates Model/Usage/DurationMS |
| `internal/tui/component/toolcard/card_test.go` | **The Phase 2 TUI gate's golden-per-card requirement** - one golden per registered renderer × representative statuses (21 cases: pending/done/error/interrupted across read_file, list_dir, glob, grep, write_file, edit_file, multi_edit, run_shell - including a non-zero exit and a timed-out shell card - todo_write, todo_read, and the generic fallback). Plus a fuzz-shaped robustness sweep (`TestToolCard_NeverPanicsOnEmptyOrMalformedIO`) over every registered renderer × every status × empty/malformed input, and a narrow-width sweep (0–5 cols) against the border/padding arithmetic |
| `internal/tui/component/toolcard/integration_test.go` (4 tests) | **The real find this phase's own testing turned up were it wrong**: proof the hand-mirrored JSON structs (`readFileOutput`, `editFileOutput`/`editResult`, `shellOutput`, `listDirOutput`) actually match the real Go tools' wire shape, not just each other |
| `internal/tui/page/chat_test.go` (+3 golden scenarios × 2 widths, +1 assertion test) | `TestChat_Golden_ToolTurn` / `_MidRun` / `_InterruptedMidTool` are the plan's named manual-smoke scenario as a golden, including the page-level interrupt-mid-tool render (a tool card actually showing "interrupted" in the transcript, not just the underlying state flag); `TestChat_ElapsedTicksWhileStreaming` checks the live clock advances while streaming and freezes exactly once at the turn's end |
| `internal/tui/component/status/bar_test.go`, `component/todo/panel_test.go` | Cost shown only for a catalog-known model, never a misleading `$0.00`; width-pressure field-dropping keeps tokens/elapsed over mode/workspace/model; the todo panel counts correctly, names only the in-progress item (never a pending one), and never panics at degenerate widths |

### Things that cost time - read before repeating them

- **The width-fitting bug in `component/status/bar.go`** (measuring the ANSI-styled string instead of the raw one) is worth its own line here even though it's already in Deviations: it is the second time in this project a bug was invisible specifically *because* the test/dev environment auto-disables color (lipgloss detects non-tty output), and the first time (none recorded - this is the first) won't be the last. Any width/truncation logic touching a `lipgloss.Style.Render` output needs its measurement taken *before* styling, every time, on principle, not just when a test happens to catch it - a test here would not have caught it either, since this sandbox never renders color.
- **`internal/ai/tools.Definition.Execute` returns `any`, not `json.RawMessage`.** Calling a real tool directly (as `integration_test.go` does) needs an extra `json.Marshal` on the result to get the same bytes the wire protocol would carry - obvious in hindsight, easy to first try passing the typed struct straight into a function expecting `json.RawMessage` and get a confusing type error instead.
- **`chatapi.NewHandler`'s eleven-argument constructor** (already flagged in the Phase 1 entry) came up again for `integration_test.go`'s sibling test infrastructure - not hit this time only because this phase's real-tool test calls `tools.Defaults` directly rather than standing up a full handler; worth remembering that shortcut exists for a test that only needs real tool execution, not a full request/response round trip.
- **`lipgloss.NewStyle().Border(...).Width(n)` counts `n` as content width, not the rendered block's total width.** `toolcard/card.go`'s `card()` helper has to subtract border (2) and padding (2) before setting `Width`, or a card asked to fill an 80-column terminal renders at 84. Got this right on the first pass by testing against the golden files' actual column counts rather than trusting the arithmetic by eye - worth doing that check again if this function is ever touched.

### What Phase 3 can now assume

- `session.ToolCall`/`ToolStatus` is the shape approval dialogs read from - a `data-tool-approval` frame (not yet reduced; Phase 3's job) will need its own `Part` kind or a field on an existing tool `Part`, and `abandonPendingTools`' pattern (scan the current message's parts, act on anything still pending) is the template for whatever the approval-timeout/dismiss path needs.
- `component/toolcard`'s registry (`registry.go`) is the place a new tool gets a dedicated renderer - git, task, propose_plan and an approval-aware `Compact` view (this phase's cards are all post-hoc; an approval card has to render *before* the tool has run, from `Input` alone) are the concrete Phase 3/4 additions the plan names.
- `component/status`'s `Info.Mode` field is real, just statically fed `"interactive"` today - Phase 3's live mode switching is a one-line change to what `page.Chat.statusBar()` passes in, not a new field.
- The injectable-clock pattern (`now func() time.Time`, set directly in same-package tests) is available anywhere else Bubble Tea code needs wall-clock time in a golden test - no new infrastructure needed, just the same field on the next `tea.Model` that needs it.

---

## Phase 3 - Interaction - landed 2026-08-18

Approval dialog on the existing rail, live permission-mode switching, a `/`-triggered slash-command palette, a model picker, and a thread switcher with `--thread` resume. `internal/tui/app` grows from a one-page pass-through into a small router; `internal/tui/client.Client` grows from one streaming method into six.

### What landed

| Item | Files |
|---|---|
| Approval modeling: `ApprovalRequest`, `ToolAwaitingApproval` status, `State.PendingApproval` | `internal/tui/session/state.go` |
| `data-tool-approval` frame reduction, and a real bug fix in the same file (below) | `internal/tui/session/reduce.go` |
| Wire-parts reconstruction and the resubmission builder - `BuildApprovalResubmission`, mirroring `approvals.go`'s `approvalAnswer` and `parts.go`'s `toolCallPart` | `internal/tui/session/resubmit.go` (new) |
| `ReplayThread` - persisted parts → live `State`, the thread switcher's resume path and the same renderer a live turn uses | `internal/tui/session/replay.go` (new) |
| `component/approval` - the modal itself, rendering from input alone (the "nothing has run yet" contract) | `internal/tui/component/approval/dialog.go` (new package) |
| `component/editor` - the slash-command list, prefix matching, and the composer's completion row | `internal/tui/component/editor/slash.go` (new package) |
| `Client` interface: `SubmitApproval`, `ListThreads`/`GetThread`/`DeleteThread`, `ListModels`; `SendMessageRequest` grows `PermissionMode`/`ChatModel` | `internal/tui/client/client.go`, `http.go` |
| `page/threads.go`, `page/models.go` - list/search/select/delete pickers, each a small self-contained `tea.Model` | `internal/tui/page/{threads,models}.go` (new) |
| `page/nav.go` - the navigation messages (`OpenThreadsMsg`, `ThreadChosenMsg`, …) that let pages talk to `app.Model`'s router without importing each other | `internal/tui/page/nav.go` (new) |
| `page.Chat` grows: approval-key interception, slash-command execution, `SetMode`/`SetModel`/`LoadThread`, a live `Mode` in the status bar | `internal/tui/page/chat.go` |
| `app.Model` becomes a router: `New`/`Resume`, three pages, dispatch on `page.Open*Msg`/`*ChosenMsg`/`PickerCancelledMsg` | `internal/tui/app/app.go` |
| `--mode` and `--thread` flags | `cmd/amiro/tui.go`, `main.go` |
| `keys.DefaultApprovalKeyMap` (y/a/n), `DefaultPickerKeyMap`, and `Threads`/`Models`/`Palette` on `ChatKeyMap` | `internal/tui/keys/keys.go` |
| A real, unrelated bug found and fixed: the desktop app's approval answer used the wrong wire key | `src/types/chat.ts` |

### Deviations from the plan, and why

- **A real, pre-existing bug in the desktop app, found while building the TUI's half of the same rail and fixed here rather than left for someone else to hit:** `ManualToolConfirmTag` (`src/types/chat.ts`) built its answer with `lib/tag.ts`'s generic `tag()` helper, whose wire key is `__$ref__`. `approvals.go`'s `parseApprovalAnswer` - and this file's own `isApprovalAnswer` twenty lines below, in `tool-presenters/types.ts` - both key off `__tag`. Every "Approve" click in the desktop app sent `{__$ref__:"manual-tool-confirm", confirm, scope}`, which `parseApprovalAnswer`'s `Tag != "manual-tool-confirm"` check silently rejected: the confirmation object round-tripped back to the model as if it were the tool's own result, and the approval was never actually applied. Nothing failed loudly - both sides used the string `"manual-tool-confirm"`, just keyed differently, which is exactly the kind of thing a type system doesn't catch and a byte-level contract test does (`src/types/chat.test.ts`, new). Fixed by giving `ManualToolConfirmTag` its own `create` that keys on `__tag` directly, rather than fixing `tag()`'s `DEFAULT_KEY` - that key is shared with `VercelAIWorkflowToolTag`/`VercelAIMcpToolTag`, which have no such cross-language contract to honor. This had to be fixed, not just noted: the plan's own manual-smoke step ("grant always allow in the TUI, confirm the desktop app stops asking") is meaningless if the desktop app's *own* approve button doesn't work yet.
- **A second real bug, this time in Phase 1's own `session.Reduce`:** a continuation (an approval answered) resumes with the *same* message id `RunTurn` minted before it paused - `runner.go`'s own doc comment states this is deliberate ("one message however many times it had to stop"). `Reduce`'s `FrameStart` case unconditionally appended a fresh `Message`, which would have split one turn into two transcript rows and orphaned the already-rendered awaiting-approval tool call in the first one, the mirror-image of the persistence bug Phase 1 found and fixed server-side. Caught by `TestReduce_FrameStart_ContinuationReusesTheSameMessage` before it ever reached a golden. Fixed: `FrameStart` now checks whether the last message's id and role already match and continues it instead of appending.
- **The client can never learn a resolved approval's real tool output, and the TUI does not try to pretend otherwise.** `resolveApprovals` executes an approved call and folds its real result directly into persisted history, server-side, without ever streaming it back as a frame - by design, the same rail the browser has always used. `BuildApprovalResubmission` marks the answered call `ToolDone`/`ToolError` locally purely for how the transcript reads from that point on; the real output only becomes visible if the thread is reloaded (`page/threads.go`'s resume path, which replays the real persisted parts). This is not a TUI-specific gap - the desktop app's own tool card has read "pending" (via `isApprovalAnswer`) until a reload for as long as the approval rail has existed; Phase 3 just made this explicit instead of quietly matching it.
- **The plan's `component/dialog/modal.go`/`confirm.go`/`picker.go` did not get built as generic primitives.** `component/approval/dialog.go` is a pure `Render(width, req, input) string` function in the same style as `toolcard.Render` and `todo.Render` - no shared modal/confirm/picker abstraction, because there is exactly one modal (the approval dialog) and two pickers (threads, models) that share almost nothing beyond "list, filter by typing, select, cancel" - which lives as `keys.DefaultPickerKeyMap`, not a rendering component. Building a generic picker component for two call sites this different in content (a list of threads with delete vs. a flat list of model names) would have been the abstraction the top-level engineering guidance calls out directly: three similar lines beat a premature one.
- **The approval dialog renders *inside* the scrollable transcript (`render()`'s job), not as a fourth fixed-height chrome row alongside the header/todo-panel/status-bar.** Its height varies with the call's input (a `write_file` body vs. a one-line shell command), and `chromeHeight()`'s whole point is a *fixed* budget `refreshTranscript` can subtract before computing viewport height. Appending it to the transcript means it scrolls and wraps exactly like a tool card already does, with zero changes to the chrome-height arithmetic - and it means Ctrl+C-while-a-dialog-is-open naturally falls through to "quit" (the turn already isn't `sending` once suspended) rather than needing a new state to reconcile.
- **Ctrl+P does not open a second, separate palette.** Appendix B calls it "command palette"; the composer typing `/` already opens one (`component/editor`'s suggestion list). Ctrl+P primes the composer with `/` and focuses it rather than building a detached list-and-select UI that would have to stay in sync with the same `editor.Commands` table. One palette, two ways to open it.
- **The model picker reads only `GET /api/chat/models`, not `GET /api/ai/providers` as well.** The plan's Phase 3 row names both; `/api/chat/models` (`chatapi.Handler.Models`) already returns exactly `internal/ai/bifrost.ListModels`'s output filtered to providers with a configured key - the one thing a picker that selects a *usable* model needs. `/api/ai/providers` additionally exposes unconfigured providers and raw API keys, neither of which a model picker has any use for; wiring a second endpoint in to read fields nothing renders would be exactly the kind of unrequested abstraction the project's own conventions warn against.
- **Slash-command Tab-completion accepts the top remaining match, not a cycled selection.** The palette is four commands long (`mode`, `threads`, `models`, `help`); a selection cursor for a list this short is machinery with no problem to solve yet.

### Verification actually run

```bash
go build ./... && go vet ./...                                                          # clean
gofmt -l internal/tui cmd/amiro                                                          # clean -- pre-existing drift elsewhere untouched
go test ./...                                                                            # all green
go test -count=1 ./tests/... ./internal/httpserver/... ./internal/api/chat/... \
        ./internal/tui/... ./internal/secrets/...                                        # uncached, all green
go build -o amiro ./cmd/amiro && ./amiro --mode bogus                                    # rejects cleanly; --mode/--thread parse correctly
pnpm test                                                                                 # 29 files / 354 tests (28/351 baseline + src/types/chat.test.ts) -- the desktop gate
npx tsc --noEmit -p tsconfig.json                                                         # clean
```

Golden regeneration: `go test ./internal/tui/page/... -run TestChat_Golden_ApprovalDialog -update`.

**A real, pre-existing flake found in this phase's own repeated-run verification, not caused by this phase:** `go test -count=3` (and above) on `internal/tui/page` intermittently fails `TestChat_Golden_ToolTurn`/`_MidRun`/`_InterruptedMidTool` - Phase 2 goldens, untouched here. Root cause tracked down and confirmed, not just observed: `component/status/bar.go`'s `estimateCost` calls `pricing.DefaultCatalog()`, a process-wide singleton whose `DefaultCatalog()` constructor starts a background goroutine (`StartBackgroundSync`) that fetches live pricing data from `raw.githubusercontent.com` over the real network. In a sandbox with outbound network access (this one; confirmed with a plain `curl`), that fetch can complete in well under a second, and once it does, `anthropic/claude-sonnet-5` - absent from the static fallback prices the golden was recorded against - gains a cost entry, which lengthens the status bar's joined string past 120 columns and triggers the width-elision branch, replacing the full line the golden expects with just `"4380 tok  ·  6s"`. Reproduced deterministically at `-count>=3` in isolation (`go test -run 'TestChat_Golden_ToolTurn$' -count=6`); a normal `go test ./internal/tui/...` (fresh process, `-count=1`, matching every command this log and the last two phases' actually ran) passed cleanly across 5 separate invocations. **Not fixed here** - it is a Phase 2 design issue (a golden test's determinism depending on a live, uncontrolled network singleton) with a real fix (inject the catalog into `status.Render` instead of reaching for the global) that touches `component/status`'s public signature and is out of this phase's scope. Recorded here so the next person who runs `-count=3+` doesn't lose time re-diagnosing it, and does not read it as something Phase 3 broke.

Manual smoke, same sandbox constraints as every phase so far (no TTY, no live model provider) - substituted with the strongest available proxy, same reasoning as Phase 1/2:
- **"Grant 'always allow' in the TUI; confirm the desktop app stops asking in that thread"** is proven at the mechanism level rather than by clicking two real UIs: `TestHTTPClient_ApprovalRail_AlwaysAllowStopsAskingInTheSameThread` sends a message that triggers a gated `run_shell` call, answers it through `SubmitApproval` with `scope:"always"` - the exact bytes `BuildApprovalResubmission` produces - then starts a *second, independent* `SendMessage` turn against the same thread that asks for the identical command, and asserts no second `data-tool-approval` frame appears. This is a real, not simulated, guarantee: both calls hit the same `chat.RunTurn` → `permission.Engine` → `h.grants.For(threadID)` path with no per-surface branch anywhere that could make a TUI-originated grant and a browser-originated one disagree. What is genuinely unverified is the pixel-level experience - an actual desktop window actually re-rendering without a prompt - which needs a live browser this sandbox does not have.
- `TestHTTPClient_ApprovalRail_SuspendAndResubmit` is the "read the suspend, answer it, watch the turn continue and persist as one row" half of the same smoke, also end-to-end over real HTTP, real auth, real permission engine, real SQLite.

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `internal/tui/session/approval_test.go` (5 tests) | The `data-tool-approval` frame reduces into `PendingApproval` + `ToolAwaitingApproval` correctly; the `FrameStart` continuation bug (above) stays fixed; `BuildApprovalResubmission`'s exact wire bytes for approve-once, always-allow and deny, including the `__tag` the backend requires; the no-pending-approval guard |
| `internal/tui/session/replay_test.go` (3 tests) | Persisted parts (text/reasoning/tool/metadata) decode back into the same `Message`/`Part` shape live streaming produces; a thread reopened mid-suspension reopens the dialog; a call merely left at `input-available` with no approval data part does **not** falsely reopen one |
| `internal/tui/client/http_test.go` (+2 tests) | **The Phase 3 backend gate.** `TestHTTPClient_ApprovalRail_SuspendAndResubmit` and `_AlwaysAllowStopsAskingInTheSameThread` - see Manual smoke above; both drive the real router, real auth, real permission engine, a real (if disk-scoped) `run_shell` tool, and real persistence |
| `internal/tui/component/approval/dialog_test.go` (5 tests) | Command-shaped calls show the literal command; the compound-command warning; the raw-JSON fallback for a non-command call; the reason line; a robustness sweep over empty/malformed input at narrow widths (mirrors `toolcard`'s own) |
| `internal/tui/component/editor/slash_test.go` (5 tests) | Prefix filtering, stopping once arguments start, `Parse`'s name/args split, and that `RenderSuggestions` never panics |
| `internal/tui/page/approval_test.go` (9 tests, incl. **the Phase 3 TUI gate's approval dialog golden**) | `TestChat_Golden_ApprovalDialog` (both widths); the dialog genuinely blocks composer input and a second `SendMessage`; y/a/n each resubmit with the exact `(confirm, scope)` pair; **the mode-switch test** (`TestChat_SlashMode_*`) - `/mode plan` changes `PermissionMode`, the status bar, and every subsequent `SendMessage`'s request; an invalid `/mode` is rejected with an inline error rather than silently degrading; `/threads`/`/models` and Ctrl+T/Ctrl+O all yield the right navigation message |
| `internal/tui/page/threads_test.go`, `models_test.go` (7 tests) | List/filter/select/delete for both pickers, driven directly against `fakeClient` |
| `internal/tui/app/app_test.go` (6 tests) | The router: `Open*Msg` switches the active page and sizes it; `*ChosenMsg`/`PickerCancelledMsg` switch back to Chat with the choice applied; `Resume`/`New` apply `--thread`/`--mode` before the program's first frame |
| `internal/tui/component/toolcard/card_test.go` (+18 cases) | `ToolAwaitingApproval` added to the existing empty/malformed-input robustness sweep across every registered renderer |
| `src/types/chat.test.ts` (3 tests, new file) | **The desktop gate's regression pin** for the `__tag` bug above - `ManualToolConfirmTag.create`'s exact JSON shape, byte-compatible with `approvals.go`'s `parseApprovalAnswer` |

### Things that cost time - read before repeating them

- **The two real bugs above (the frontend's `__$ref__` vs `__tag` key, and `Reduce`'s `FrameStart` duplicating a continued message) were both found by building the resubmission path end to end and asking "would the *other* surface actually accept these exact bytes", not by reasoning about either side in isolation.** Neither was reachable from either surface's own existing test suite: the frontend's tests never asserted on `ManualToolConfirmTag.create`'s output shape (only on rendering logic downstream of it), and the TUI's own `Reduce` tests, written before Phase 3, never sent a second `FrameStart` with a repeated `MessageID` because nothing before this phase ever needed to. Worth remembering as a general lesson, not just these two instances: a protocol shared by two independently-evolving codebases needs a test that constructs the actual bytes one side sends and asserts the other side's parser accepts them, in both languages, not just unit tests of each side's own logic.
- **`resolveApprovals` never streams a resolved call's real output back as a frame - this is easy to assume is a bug and isn't one.** It runs before the tool loop even starts, folding the answer straight into persisted history for the *next* model step to read; the client that resubmitted never gets a `tool-output-available` frame for that specific call. Spent real time here confirming this wasn't something Phase 3 needed to fix before realizing the desktop app has had exactly the same limitation since the approval rail was built (`isApprovalAnswer` in `tool-presenters/types.ts` exists specifically because a resubmitted-but-unresolved-client-side tool part still shows "pending"). `BuildApprovalResubmission`'s local optimistic status update (Done/Error) is the TUI's equivalent, not a workaround for a TUI-specific gap.
- **The pricing-catalog flake (see Verification above) took real time to pin down** because it only reproduces at `-count>=3` in a process with real network access - a plain `-count=1` run, which is what every verification command in this log and the last two phases' actually used, never shows it. Worth checking `-count=3+` at least once per phase from here on specifically *because* it caught this, but do not spend time chasing a `component/status`-related golden failure under repetition without first checking whether `pricing.DefaultCatalog()`'s background sync is the reason - it almost certainly is.
- **`chatapi.NewHandler`'s eleven-argument constructor (flagged in Phase 1 and Phase 2) came up again** for the approval-rail client tests' `testServer` helper (already existing infra, reused rather than rebuilt) - worth remembering `nil` is correct for every argument beyond `chatRepo, exportRepo, engine, ..., providerRepo, nil` when a test only needs the chat route and real tool loading, not MCP/workflow/agent wiring.
- **A fake `Engine` used for an approval test must call `hooks.OnTextDelta` itself if it wants text to actually stream.** `StepResult.Text` alone is only used for logging/accumulation after `StreamStep` returns - `runToolLoop`'s `sw.TextStart`/`-Delta`/`-End` calls all live *inside* the hooks a real engine invokes while streaming. A first draft of `approvalEngine`/`alwaysAllowEngine` returned `StepResult{Text: "..."}` without calling `hooks.OnTextDelta` and produced a turn that finished cleanly with zero text frames - silent, not a test failure, until the test asserted on the streamed text specifically.

### What Phase 4 can now assume

- `internal/tui/client.Client` now has six methods, not one - `ListThreads`/`GetThread`/`DeleteThread`/`ListModels`/`SubmitApproval` are the pattern Phase 4's settings page and `@`-mention resolution should extend, not a parallel ad hoc HTTP call from a page.
- `session.PersistedMessage`/`ReplayThread` is the seam for anything else that needs to turn a fetched thread back into live `State` - `/compact` and `/export` (Phase 4) read a thread the same way the thread switcher does.
- `component/editor`'s `Commands` table is where `@`-mention support and any new slash command register themselves; the composer's suggestion-row wiring in `page.Chat` already generalizes to "whatever `editor.Suggest` returns," not specifically the four Phase 3 commands.
- `page.Chat.SetMode`/`SetModel` are the two setters Phase 4's settings page should call through, not reimplement - the same rule Phase 1's `resolveSession` doc comment states for identity ("read the signed-in user through the same `*client.HTTPClient`, not re-derive it") applies here to turn-level configuration.
- `app.Model`'s router (`active` + `page.Open*Msg`/`*ChosenMsg`/`PickerCancelledMsg`) is the pattern Phase 4's settings page and `page/mcp.go` slot into - a fourth `active` case and a fourth pair of navigation messages, not a redesign.
- The approval rail's wire contract (`session.resubmit.go`'s mirrors of `approvals.go`/`parts.go`) is now covered by a byte-level test on both sides of the language boundary (`src/types/chat.test.ts` ↔ `internal/tui/session/approval_test.go`) - worth the same treatment for any other cross-language wire shape Phase 4 introduces, given this phase found a real, silent, already-shipped bug exactly there.

---

## Phase 4 - Mentions and configuration - landed 2026-08-18

`@`-mentions (agents, MCP servers/tools, workflows, Amiro's own tools), a YAML config layer with a four-way precedence chain, a settings page for AI provider keys, and `/compact`/`/export` slash commands. Two more real, pre-existing, silently-broken bugs found and fixed along the way - one in the same "does the wire contract actually work" spirit as Phase 3's `__tag` fix.

### What landed

| Item | Files |
|---|---|
| `client.Mention`, `Agent`/`MCPServer`/`Workflow`/`ProviderStatus`, and six new `Client` methods (`ListAgents`, `ListMCPServers`, `ListWorkflows`, `ExportThread`, `ListProviders`, `SetProviderKey`) plus `SubmitApproval`'s siblings `SendMessageRequest.Mentions`/`.CompactNow` | `internal/tui/client/client.go`, `http.go` |
| `component/editor/mention.go` - `Mentionable`, `SuggestMentions`/`ReplaceLastToken` (the `@` half of slash's completion machinery), the curated `DefaultToolMentions` list | `internal/tui/component/editor/mention.go` (new) |
| `internal/tui/config` - the whole §2.8 YAML layer: `Load`, `Overrides`, four-way precedence, degrade-not-fail on a missing or malformed file | `internal/tui/config/config.go` (new package) |
| `page/settings.go` - provider-key picker + entry, the same `GET`/`POST /api/ai/providers` the desktop settings screen uses | `internal/tui/page/settings.go` (new) |
| `page/mentions.go` - fetches agents/MCP servers/workflows once at startup and merges them with the static tool list | `internal/tui/page/mentions.go` (new) |
| `page.Chat` grows: mention completion (Tab-accept, `pendingMentions`), `/compact`, `/export`, `/settings`, a non-error `notice` line | `internal/tui/page/chat.go` |
| `app.Model` grows a fourth page (`activeSettings`) and `SetModel` for `--model`/`config.yaml`'s `defaultModel` | `internal/tui/app/app.go` |
| `--model` flag; `internal/tui/config.Load` wired in ahead of `app.New`/`app.Resume` | `cmd/amiro/tui.go`, `main.go` |
| `chat.WithForceCompact`/`consumeForceCompact` - the backend half of `/compact`, a context flag consumed once (approver.go's own pattern, not a new parameter) | `internal/api/chat/compact.go`, `runner.go`, `route.go` |
| A real, pre-existing bug in `Export`'s HTTP handler, fixed: it now returns the export id both existing frontend callers already expected | `internal/api/chat/export.go`, `internal/httpserver/chat_routes_test.go` |

### Deviations from the plan, and why

- **A second real, pre-existing, silently-broken bug found this phase, unrelated to Phase 3's but the same shape:** `chatapi.Handler.Export` (`POST /api/chat/export`) returned `{"message": "Chat exported successfully"}`. Both existing frontend callers - `src/lib/backend/chat-api.ts`'s `exportChat` and `chat-export-popup.tsx`'s `.ifOk((exportId) => { const link = ...${exportId}... })` - read the resolved JSON body directly as the export's id string. `apiJson` does no unwrapping, so `exportId` in the desktop app was the whole `{message: "..."}` object, and the "copy share link" button silently produced `.../export/[object Object]`. Nothing in the existing test suite checked the body shape, only the status code. Fixed by encoding the bare id `ExportChat` already returns, matching what both callers were always written to expect; `TestRouter_ChatExportSucceedsForOwner` now asserts the body decodes as a JSON string and that `GET /api/export/<that id>` actually resolves, not just that the POST returned 200. This had to be fixed rather than merely noted: the TUI's own `/export` needs the same id back to tell the user anything useful, and building it against the bug would have made the TUI equally broken.
- **`/compact` forces compaction via a context flag consumed once, not a new parameter on `runToolLoop`.** `runToolLoop` has upward of a dozen call sites across `internal/api/chat`'s own test suite (`tool_loop_test.go`, `tool_scheduler_test.go`, `approvals_test.go`, `approver_test.go`, `event_log_test.go`), none of which have any reason to know a manual compact was requested. A new parameter would have been a wide, purely mechanical diff across files this phase has no other reason to touch. `chat.WithForceCompact(ctx, bool)` follows `approver.go`'s own already-established precedent for exactly this situation (request-scoped, optional, correct zero behavior) - a pointer-to-bool stored in the context, consumed and cleared on first read, so a multi-step turn forces its history check once, not every step (repeatedly re-summarizing an already-summarized history would be both wasteful and wrong). No existing call site's signature changed.
- **`/compact` is a real turn, not a control-plane-only request.** `RunTurn`'s compaction check runs inside the tool loop, immediately ahead of the model call it's about to make - there is no "compact with nothing else happening" entry point on the server, and building one would be a second, TUI-only path through code the plan's whole point is not duplicating. `/compact` sends a short fixed instruction ("Compact the conversation history to free up context.") through the exact same `SendMessage` path a normal message uses, with `CompactNow: true` riding along; the model's own reply to that instruction is incidental, since the actual compaction already happened by the time it's asked to reply.
- **`page/settings.go`'s scope is provider keys only, not "defaults."** The plan's Part 3 folder listing says "provider keys, defaults" for this page, but permission-mode and model defaults already have their own live-switching surfaces from Phase 3 (`/mode`, the model picker) and now a config-file layer (this phase's `internal/tui/config`) - a third place to set the same two values would be a place for them to disagree, not a convenience. Provider keys have no other home: they are DB-backed (`ProviderRepository`, the same one `GET/POST /api/ai/providers` already exposes to the desktop settings screen), and Phase 4's own desktop-gate row ("settings written by the TUI appear in the desktop app") is specifically about that DB-backed surface, not the YAML file.
- **`SetProviderKey` looks up an existing connection by provider slug before saving, rather than always creating one.** Found while writing the "update in place" test: `ProviderRepository.Set`'s own contract is "empty id always creates a new row, no dedup" - the same shape as any create-or-update endpoint that pushes the decision onto the caller. A client that always sent an empty id (the obvious first draft) would grow a duplicate `provider_config` row every time a user re-entered the same provider's key, which the settings page's own list view would then show twice. `HTTPClient.SetProviderKey` now calls `ListProviders` first and threads the existing id through when the provider is already configured.
- **No `schema.json` generation.** The plan calls it "one `go generate`" and names it as a nice-to-have beside the YAML file itself; nothing in this tree yet consumes a JSON Schema for `config.yaml` (no editor integration, no validation step), so generating one now would be a file with no reader. `internal/tui/config.Config`'s two fields are small enough that adding schema generation later, once something actually wants it, costs nothing this phase skipped ahead on.
- **No dedicated `page/mcp.go` ("MCP servers and their tools").** Not named in Part 4's Phase 4 bullet list (only in Part 3's folder sketch, undated); `@`-mentioning an MCP server or one of its tools already covers the access Phase 4 asks for, and a browsing/management page for MCP servers is a reasonable Phase 5+ addition rather than something this phase's own scope line calls for.
- **Mention resolution works by tracking *accepted* completions, not by re-parsing `@name` back out of the composer's text.** The desktop app's mention input is a rich-text editor where each mention is its own node carrying a JSON id; a terminal composer is a plain string with no such node. `component/editor/mention.go`'s own doc comment lays out the alternative considered and rejected (parsing text back into mentions) and why: it would have to reconstruct exactly what the desktop's rich editor gets for free, and get it wrong on the first ambiguous case (two different mentionables sharing a display name). Instead, `page.Chat.pendingMentions` accumulates a `client.Mention` the moment Tab accepts a completion, attaches to the next `SendMessage`, and clears - the known edge case (a user manually deletes the inserted "@Label" text after accepting) still sends the mention, a minor, documented trade-off rather than a silent one.

### Verification actually run

```bash
go build ./... && go vet ./...                                                          # clean
gofmt -l internal/tui cmd/amiro internal/api/chat internal/httpserver                    # clean -- pre-existing drift elsewhere untouched
go test ./...                                                                            # all green
go test -count=1 ./tests/... ./internal/httpserver/... ./internal/api/chat/... \
        ./internal/tui/... ./internal/secrets/...                                        # uncached, all green
for i in 1 2 3; do go test ./...; done                                                    # 3 separate process runs, all green (see Phase 3's
                                                                                           # pricing-catalog note for why -count=3+ *within one
                                                                                           # process* is not used as the flakiness check here)
go mod tidy                                                                               # promoted gopkg.in/yaml.v3 to a direct dependency;
                                                                                           # also dropped an actually-unused gorm.io/driver/sqlite
                                                                                           # require nobody had cleaned up since before this tree's
                                                                                           # sqlite access moved to glebarez/sqlite
pnpm test                                                                                 # 29 files / 354 tests, unchanged -- no frontend files touched this phase
```

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `internal/api/chat/compact_test.go` (4 tests) | `consumeForceCompact`'s consumed-exactly-once contract and its zero behavior; `/compact` actually forces compaction on a thread under the real 100k-token budget (`TestRunTurn_CompactNowForcesCompactionEvenUnderBudget`); the control case proving the same short thread does *not* compact without `CompactNow` |
| `internal/httpserver/chat_routes_test.go` (extended) | **The Export bug's regression pin** - the response body decodes as a bare string id, and that id actually resolves via `GET /api/export/{id}` |
| `internal/tui/client/http_test.go` (+6 tests) | **The Phase 4 backend gate ("mention-resolution tests cover the TUI's request shape")**: an agent mention (`{Type:"agent", AgentID}`) built exactly the way `toClientMention` builds it actually folds the agent's system prompt into the turn (`TestHTTPClient_Mentions_AgentMentionAppliesItsSystemPrompt`, via a system-prompt-capturing fake engine); a `defaultTool` mention overrides `ToolChoice: "none"`, matching `loadAppDefaultTools`'s documented behavior. Plus the desktop-gate pair: a key set via one `HTTPClient` is visible to an independent second one on the same server (`TestHTTPClient_SetProviderKey_IsVisibleToAnyOtherClientOfTheSameServer`), and re-saving the same provider updates in place rather than duplicating |
| `internal/tui/config/config_test.go` (4 tests, incl. **the Phase 4 TUI gate's "config precedence table test"**) | `TestLoad_PrecedenceTable` sets all four layers to *different* values and peels each one back in turn, proving the next layer down actually takes over - not just that the top layer wins once; a missing-everything zero-config case; a malformed project file degrading to the next layer instead of failing; a bare model name with no provider prefix |
| `internal/tui/component/editor/mention_test.go` (7 tests) | `SuggestMentions`' last-token/case-insensitive trigger and its "stop once the token is finished" cutoff (mirroring slash's own); `ReplaceLastToken` touches only the trailing word; `MCPToolMentions`' server-qualified display name vs. its bare wire name (`MentionName()`); the curated default-tool list's stated exclusions |
| `internal/tui/page/mentions_test.go` (6 tests, incl. **the Phase 4 TUI gate's "mention/slash completion tests"**) | `Init` actually fetches and merges all four mention categories; Tab accepts the top match and records it; `send()` attaches `pendingMentions` to the real request and clears them after; `/compact` carries `CompactNow` through the normal send path; `/export` calls `ExportThread` for the open thread and surfaces a non-error notice; `/settings` navigates |
| `internal/tui/page/settings_test.go` (5 tests) | The picker → key-entry → save flow calls `SetProviderKey` with the right provider/key; an empty key never round-trips to the server; Esc from key entry returns to the picker without leaving the page; Esc from the picker leaves it entirely |
| `internal/tui/app/app_test.go` (+1 test) | `OpenSettingsMsg` routes to the fourth page and `PickerCancelledMsg` returns to chat from it, the same round trip already covered for threads/models |

### Things that cost time - read before repeating them

- **The Export bug (like Phase 3's `__tag` bug) was only findable by reading what the frontend actually does with a response, not by reading the Go handler in isolation.** The Go code looked complete on its own terms - it called `ExportChat`, checked the error, wrote a 200. Only cross-referencing `chat-export-popup.tsx`'s `.ifOk((exportId) => ...)` against `apiJson`'s no-unwrapping behavior revealed that the shape being sent could never have worked. Worth repeating from Phase 3's own note: a protocol two codebases share needs a test that constructs the actual bytes one side sends (or reads) and checks the other side's real expectation, not just that each side's own logic is internally consistent.
- **`compaction.Compact`'s "nothing to compact" guard (`len(messages) <= KeepRecent+1`, `KeepRecent` = 12) fires before the token-budget check ever matters.** A first draft of the `/compact` test used a 3-message thread and could not get the forced path to actually invoke the summarizer no matter how low `MaxTokens` was forced - the short-history guard was the reason, not the force logic. Seeding at least 13 messages (`seedLongHistory`) is what a test forcing compaction on an otherwise-short thread actually needs.
- **A fake engine used as the compaction summarizer must handle `StepHooks{}` (all nil) without panicking.** `summarizerFor` calls `engine.StreamStep` with empty hooks -- `hooks.OnTextDelta` is nil there, only real for the turn's main model step. `runner_test.go`'s existing `textEngine` unconditionally calls `hooks.OnTextDelta`, which panics if reused as the summarizer; `compact_test.go`'s `compactAwareEngine` checks `hooks.OnTextDelta == nil` to tell the two calls apart. The same "does this fake engine assume hooks are always populated" question is worth asking before reusing any existing fake `Engine` for a new code path that calls `StreamStep` more than once per turn.
- **`ProviderConfigDTO.Models []string` has no `omitempty`, and `ProviderRepository.Set`'s update path unconditionally overwrites `existing.Models` with whatever was sent (empty, if omitted).** `SetProviderKey` does not send `Models` at all, so every save through it clears the connection's synced model list. This is existing, unrelated behavior of an endpoint this phase reused rather than redesigned - flagged here so a future settings-page feature that also wants to preserve or set the model list knows to look at this exact spot rather than rediscover it.
- **`go mod tidy` also removed `gorm.io/driver/sqlite` (and its transitive `mattn/go-sqlite3`) from `go.mod`.** Unrelated to this phase's work -- this tree's actual SQLite access has gone through the pure-Go `glebarez/sqlite` since before Phase 1 (per that phase's own build notes: "No cgo"), and nothing imports `gorm.io/driver/sqlite` any more. `go mod tidy` correctly noticed on its first real run since that migration. Kept rather than reverted: it is a strictly more accurate manifest, verified with a full `go build ./... && go test ./...` afterward, and reverting it would mean carrying a known-unused cgo dependency forward on purpose.

### What Phase 5 can now assume

- `internal/tui/client.Client` is now nine methods wide (six added Phase 3, six more this phase, `SendMessage`/`SubmitApproval` besides) - Phase 5's `--connect`/attach work and multi-client tests exercise the same interface, not a new one; nothing about attaching to a remote sidecar changes what methods a page can call.
- `internal/tui/config.Load` takes a `workDir` parameter specifically so a multi-workspace or multi-client future isn't locked into one process-wide config -- Phase 5's per-connection settings (if any) can call it again with a different root rather than needing a second config mechanism.
- `component/editor`'s `Commands` and `Mentionable` candidate list are both plain data (a slice, filtered by prefix) -- anything Phase 5 or 6 wants completable just needs to land in one of those two lists, not a new completion engine.
- The "two independent `HTTPClient` values against the same server" test pattern (`TestHTTPClient_SetProviderKey_IsVisibleToAnyOtherClientOfTheSameServer`) is the direct precedent for Phase 5's own multi-client tests -- it is already proof that this tree has no per-connection state hiding anywhere it shouldn't.

---

## Phase 5 - Attach and multi-client - landed 2026-08-18

`amiro --connect <url> --token <tok>` (explicit attach, bypassing attach-or-embed discovery entirely) and proof that multi-client-on-one-thread already works with zero new state: two independent `HTTPClient`s against one server converge on the same persisted thread, and an approval suspended by one connection can be resolved by another.

### What landed

| Item | Files |
|---|---|
| `client.Connect` - the explicit-attach counterpart to `Discover`/`StartEmbedded`: takes a URL and a shared secret instead of a lock file, proves liveness with a real `/health` round trip, never falls back to anything | `internal/tui/client/connect.go` (new) |
| `transport.sessionKey` - attach-or-embed transports (`Discover` or `StartEmbedded`) share `sessionSecretKey`; `connectTransport` gets a per-server key instead | `cmd/amiro/serve.go` |
| `connectTransport`, `resolveConnection` - the `--connect`-vs-attach-or-embed choice, made in one place every entrypoint calls through | `cmd/amiro/serve.go` |
| `sessionKeyForServer` - `sessionSecretKey + ":" + url`, so a session for one `--connect` target is never read back for another, or for this machine's own desktop session | `cmd/amiro/session.go` |
| `resolveSession` reads/writes `t.sessionKey` instead of the hardcoded constant; doc comment extended to name `--connect` as the same "stranger's process" case implicit attach already refuses to auto-provision against | `cmd/amiro/session.go` |
| `--connect`/`--token` flags on the default TUI command and on `auth login`/`logout`/`whoami` | `cmd/amiro/tui.go`, `cmd/amiro/auth.go`, `cmd/amiro/main.go` (usage text) |
| Layer 5 multi-client e2e: two independent `HTTPClient`s, one embedded server, one thread - shared history and a cross-client approval resubmit | `internal/tui/client/multiclient_test.go` (new) |
| Attach-mode client tests against `httptest` (the TUI gate) | `internal/tui/client/connect_test.go` (new) |
| `--connect`'s safety-rule tests: requires `--token`, never auto-provisions, per-server session scoping | `cmd/amiro/connect_test.go` (new) |

### Deviations from the plan, and why

- **No new multi-client *mechanism* was needed - this phase is almost entirely tests plus one new attach path.** The plan's Part 7 risk table and Part 5 testing table both frame Phase 5 as proving a property, not building one: `chatapi.Handler.grants` (`permission.Store`, keyed by thread id) is a single process-wide instance built once in `NewHandler` and shared by every request that server ever serves (`internal/api/chat/handler.go:160`); there is no per-connection map, cache, or session-affinity anywhere in the request path a second `HTTPClient` could fall on the wrong side of. `TestMultiClient_BothClientsSeeTheSamePersistedThread` and `TestMultiClient_ApprovalSuspendedByOneClientIsResolvableByAnother` (`internal/tui/client/multiclient_test.go`) passed on the first run, with no server-side changes - the honest way to report that is "verified," not "built."
- **`--token` in `amiro --connect <url> --token <tok>` is the sidecar's shared secret (`X-Amiro-Token`, `middleware.RequireToken`'s gate), not the signed-in user's session bearer token.** Appendix A names one flag with one meaning to check against the actual gate structure: `middleware.RequireToken` wraps *every* route except two path-prefix exemptions (`/storage/`, the MCP OAuth callback) - including `POST /api/auth/login` itself - so no request of any kind reaches an explicitly-connected server without it. `--token` is therefore non-optional and non-derivable for `--connect`, every single invocation, forever - there is no fallback to try. Identity (the *session* bearer token, `Authorization: Bearer`) is the separate, already-existing `resolveSession` concern, resolved per-server the normal way once `--token` gets a caller past the front door.
- **A stored session for a `--connect` target is looked up under `sessionKeyForServer(url)`, never `sessionSecretKey`.** The obvious first draft reuses the same secrets-store key attach-or-embed already uses (`"amiro:session"`) for `--connect` too, since it is the same `internal/secrets.KeyStore` on the same machine either way. That would be wrong the moment a user has both a desktop app on this machine *and* connects to a second, unrelated server: logging into the remote target would silently overwrite (or be silently shadowed by) this machine's own desktop-default session, since both would compete for one global slot. Caught before it shipped by asking the same question Phase 3/4's real bugs came from - "what does the *other* thing that reads this value actually expect" - this time about a value on the *same* side of the wire, not across languages. `TestConnectTransport_SessionIsScopedPerServer` pins it: a session parked under the shared key is proven **not** to be picked up for an unrelated `--connect` target.
- **`connectTransport` never has an `embedded` field set, which is precisely what makes `resolveSession`'s existing `t.embedded == nil` check already correct for `--connect` with zero new branching.** The safety rule ("an explicitly-attached server is a stranger's process, do not auto-provision against it") was already implemented for implicit attach in Phase 1; `--connect` needed no new conditional, only a `transport` value shaped the same way implicit attach's own "found a lock file" branch already is. `TestConnectTransport_NeverAutoProvisionsAnIdentity` asserts the error mentions "not signed in" and never mentions "provisioning" - the regression this guards is a future edit accidentally loosening that `nil` check, not anything wrong today.
- **`client.Connect` lives in `internal/tui/client`, not `cmd/amiro`**, mirroring `Discover`/`StartEmbedded`'s existing placement and keeping the "only `internal/tui/client` knows a transport exists" rule intact - `cmd/amiro/serve.go`'s `connectTransport` is a thin wrapper choosing *which* client-package constructor to call, the same shape `resolveTransport` already had for `Discover` vs. `StartEmbedded`.
- **`--token` used without `--connect` is a hard error (`"--token has no effect without --connect"`), not a silently-ignored flag.** A flag that only does something in combination with another, unenforced, is exactly the kind of thing that costs someone a debugging session the day they typo `--conect`.
- **No frontend changes.** Nothing in Phase 5's own scope touches the desktop app's code at all - the "desktop gate" is a property of the backend having no per-connection state (proven above), not a wire or UI change. `pnpm test` was run to confirm the baseline is unaffected, not because anything under `src/` was edited this phase.

### Verification actually run

```bash
go build ./... && go vet ./...                                                          # clean
gofmt -l internal/tui cmd/amiro                                                          # clean -- pre-existing drift elsewhere untouched
go test ./...                                                                            # all green
go test -count=1 ./tests/... ./internal/httpserver/... ./internal/api/chat/... \
        ./internal/tui/... ./internal/secrets/... ./cmd/amiro/...                        # uncached, all green
for i in 1 2 3; do go test ./...; done                                                    # 3 separate process runs, all green (Phase 3's
                                                                                           # pricing-catalog flake note still applies to
                                                                                           # -count=3+ *within one process*, not used here)
go build -o amiro ./cmd/amiro                                                             # builds clean
pnpm test                                                                                 # 29 files / 354 tests, unchanged -- the desktop gate
```

Manual smoke, same sandbox constraints as every phase so far (no TTY, no live model provider):
- `./amiro --connect http://127.0.0.1:1 --token whatever` and `./amiro --connect <url>` (no `--token`) both fail immediately with a clean, specific message and exit 1 - no hang, no stack trace, no attempt to embed a fallback server.
- **The real manual-smoke scenario ("desktop app open, `amiro --connect` to it, drive the same thread from both") run as far as this sandbox allows**, via a standalone probe program built inside `backend-go/cmd/` and deleted immediately after (kept out of the tree; the same pattern Phase 1's own manual smoke used for `client.Discover`/`StartEmbedded`): `client.StartEmbedded` boots a **real, fully-wired backend** (real `appwiring`, real SQLite, real MCP manager - the exact thing the desktop app's sidecar is) standing in for "the desktop app is already running"; `client.Discover` finds it (attach-or-embed unaffected); a bogus port is correctly refused by `client.Connect`; `client.Connect` then attaches to the real server with its real shared secret, registers an account, and signs in - all through the same `--connect` code path `cmd/amiro` uses; a second, fully independent `HTTPClient` - literally standing in for "the desktop app's own connection" - signs in with the same session token and is shown to agree with the first client on identity and thread list. Full transcript kept in this entry's own verification run, not just asserted:
  ```
  Discover found the embedded server (attach-or-embed unaffected)
  Connect correctly refuses a server that isn't actually there
  Connect attached explicitly to the real embedded server, health check passed
  registered and signed in via --connect as Ada <ada@example.com>
  a second, independent client on the same session/server agrees on identity
  both clients see 0 / 0 threads (should match, both empty pre-chat)
  == PROBE PASSED ==
  ```
- **Genuinely unverified, and said plainly rather than glossed over:** actually driving a real chat turn through this probe (rather than just identity/thread-listing calls) needs a configured LLM provider key this sandbox does not have; and nothing here replaces an actual Tauri desktop window actually re-rendering a live SSE stream while a real terminal, in a real TTY, is typing into the same thread. `TestMultiClient_*` (`internal/tui/client/multiclient_test.go`) is the strongest available substitute for the chat-turn half - real router, real auth, real persistence, real approval rail, fake engine only where a live model would otherwise be required, the same substitution every phase's backend gate has used. The desktop-window half has no substitute better than what Phase 1 already recorded: this sandbox has no TTY and no browser.

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `internal/tui/client/connect_test.go` (4 tests, incl. **the Phase 5 TUI gate's "attach-mode client test against httptest"**) | `Connect` succeeds against a real `httptest` server with the right token and streams a real turn through it exactly like an attached client; a missing token, a wrong token, and an unreachable URL each fail cleanly rather than hang or panic |
| `internal/tui/client/multiclient_test.go` (2 tests, **the Phase 5 backend gate**) | `TestMultiClient_BothClientsSeeTheSamePersistedThread` - two independent `HTTPClient`s interleave sends on one thread and each sees the other's writes, in order, with no duplication; `TestMultiClient_ApprovalSuspendedByOneClientIsResolvableByAnother` - a suspend opened by one connection is resolved by a second that never saw the original request, proving the approval rail's state lives in the database keyed by thread, not in anything held by the connection that opened the stream |
| `cmd/amiro/connect_test.go` (5 tests) | `connectTransport` requires and validates `--token` before any other call; `resolveSession` against a `--connect`'d server with no stored session fails with "not signed in", explicitly never mentioning "provisioning"; a session stored under `sessionKeyForServer` **does** authenticate; a session stored under the shared `sessionSecretKey` (simulating this machine's own desktop session) is proven **not** picked up for an unrelated `--connect` target |

### Things that cost time - read before repeating them

- **The multi-client property this phase's own exit criteria asks for was already true before this phase touched anything.** Confirming that - rather than assuming a green test means "nothing to report" - took reading `permission.Store`'s own doc comment and `NewHandler`'s call site to find the one sentence that proves it (`internal/agent/permission/session.go`: "Store hands out one Session per conversation... One request cannot hold the grants, because the approval round trip *is* a second request"), then writing a test that exercises that claim with two literally-distinct client values rather than trusting the sentence. Worth doing again for any future phase that touts a property as a design decision rather than an implementation: write the test that would fail if the sentence were wrong, even (especially) when it's expected to pass.
- **Deciding what `--token` means in Appendix A took re-deriving the middleware chain, not just re-reading the plan text.** The plan's own §2.5 sentence - "the same token authenticates both the embedded and the attached server, alongside the sidecar's shared secret" - reads at first pass as if the *session* token were the one Appendix A's `--token` names. `internal/middleware/auth.go`'s `RequireToken` wrapping *every* route (`internal/httpserver/router.go`'s `handler = middleware.RequireToken(cfg.AuthToken, ...)`, applied last, outermost) settled it: there is no route, including `/api/auth/login` itself, an explicitly-connected client can reach without the shared secret, so that has to be what a flag named `--token` on a bare `--connect` (no separate session flag) supplies.
- **The standalone probe needed `internal/appwiring.ReadLock`/`LoopbackURL` to recover the embedded server's real port and token** - `client.Discover`'s returned `*HTTPClient` doesn't expose its own base URL (by design: nothing above `internal/tui/client` should ever need one), so proving `client.Connect` against the *same* server `Discover` just found meant reading the lock file directly, the same way `Discover` itself does internally. Building the probe inside `backend-go/cmd/` (a real module member, briefly) rather than the session scratchpad was necessary for exactly this reason: `internal/appwiring` cannot be imported from outside the module at all.

### What Phase 6 can now assume

- `resolveConnection(ctx, cfg, connectURL, token)` is the one place a transport gets chosen - `amiro run` (Phase 6, headless) should call it too if it ever needs to run against something other than an embedded server, rather than re-deriving the attach-or-embed-or-connect choice a third time.
- `client.Connect` and `client.Discover` are siblings with the same shape (`(ctx, ...) -> (*HTTPClient, error-or-ok)`, liveness-checked, never falling back) - any future explicit-target transport (an IDE extension picking a specific workspace's server, say) is a third sibling, not a special case bolted onto either existing one.
- The multi-client guarantee this phase tested (`internal/tui/client/multiclient_test.go`) holds for *any* two clients of one server process, regardless of how each one's transport was resolved - attach-or-embed, `--connect`, or a future IDE extension's own connection all end up as plain `*HTTPClient` values hitting the same `chatapi.Handler`, with nothing in the request path that distinguishes them. Phase 6's headless `amiro run` inherits this for free: running it against an already-open desktop thread is not a new scenario to test, it's the same one this phase already covered.

---

## Phase 6 - Headless - landed 2026-08-18

`amiro run "<prompt>" [--json] [--yes]`: one turn through `chat.RunTurn` directly, no server, no client, no TUI - the in-process path plan §2.2 explicitly carves out for this and the evaluation harness. Two real bugs found by actually running it, not just building it.

### What landed

| Item | Files |
|---|---|
| `runHeadlessTurn` - parse flags, build an `appwiring.App` with no bound port, resolve an identity, run one turn through `app.Chat.RunTurn` directly | `cmd/amiro/run.go` (new) |
| `runOutput` / `.exitCode()` - the `--json` schema and the 0/1/2 exit-code contract, both pure and independent of any live model | `cmd/amiro/run.go` |
| `resolveHeadlessUser` - in-process mirror of `resolveSession`'s stored-session-then-desktop-default rule, using `auth.Service.ValidateSession`/`EnsureDesktopDefaultUser` directly instead of an HTTP round trip | `cmd/amiro/run.go` |
| `textEmitter` (default) / `uimessage.NewDiscardWriter()` (`--json`) - which `Emitter` amiro run hands to `RunTurn`, and `errorCapturingEmitter` wrapping either one | `cmd/amiro/run.go` |
| `partitionRunArgs` - flags-can-trail-the-prompt argument splitting, replacing a bare `flag.FlagSet.Parse` | `cmd/amiro/run.go` |
| `withStdoutSuppressed` / `argsRequestJSON` - keeps bifrost's own stdout logging out of `--json`'s output | `cmd/amiro/run.go` |
| `run` wired into `main.go`'s dispatch and usage text | `cmd/amiro/main.go` |
| Pure unit tests for the schema, exit codes, and argument handling (the backend gate) | `cmd/amiro/run_test.go` (new) |

### Deviations from the plan, and why

- **`amiro run` does not call `resolveConnection`, contradicting Phase 5's own "what Phase 6 can now assume" note.** That note assumed headless would want a transport the way the TUI does. Re-reading the plan itself while building this settled it the other way: §2.2 says outright - "In-process direct calls do not disappear -- they remain the path for `amiro run` (headless, Phase 6) and the eval harness, which genuinely have no client. `RunTurn` serves both" - and Part 3's file list puts `run.go` under `cmd/amiro/` with no client dependency implied, next to `appwiring`'s own doc comment naming "the headless runner needs the same graph without a listener at all" as one of the two reasons that package exists. A headless one-shot has no long-lived session to share with anything else and no reason to attach to someone else's server; it owns a fresh `appwiring.App` for exactly the one turn's lifetime and closes it. Worth recording plainly: a forward-looking note in one phase's entry is a prediction, not a constraint -- the plan text itself is the authority, and this is the second time in this log a "what the next phase can assume" note turned out to need correcting once the next phase actually started (the first was implicit, this one is explicit).
- **RunTurn's error contract is not what a first read of its signature suggests, and this cost a real, shipped bug before it was caught by this phase's own manual smoke test.** `RunTurn`'s doc comment says a failure *after* streaming starts is written into the stream as an error frame, with `TurnResult` still returned and `error` still nil -- true, and easy to read past, because "returns `(TurnResult, error)`" reads like the normal Go contract where a non-nil error is checked and everything works if you check it. A first version of `runHeadlessTurn` did exactly that: checked `runErr`, found it nil on a turn that had actually failed with "no keys found for provider: openai and model: gpt-4.1" (this sandbox's own environment -- no provider configured), and reported exit 0 with no error anywhere. Caught by literally running the built binary rather than trusting the test suite (the pure unit tests below never call `RunTurn` at all, since it needs a live model this sandbox does not have -- they could not have caught this on their own). Fixed with `errorCapturingEmitter`, which wraps whichever `Emitter` amiro run is using and remembers the last `Error(...)` frame; `runHeadlessTurn` folds that into `runErr` if `RunTurn`'s own return didn't already carry one. This is the same class of finding as Phase 3's `__tag` bug and Phase 4's Export bug: the contract a docstring states and the contract a caller assumes are not automatically the same thing, and the only way to find the gap is to exercise the real path, not read the signature.
- **Appendix A's own documented invocation does not parse with a bare `flag.FlagSet.Parse`, and this too was only caught by running the built binary.** `amiro run "<prompt>" [--json] [--yes]` puts flags *after* the prompt; Go's `flag` package stops parsing at the first non-flag argument, so that exact invocation left `--json` sitting unrecognized in `fs.Args()`, silently concatenated onto the prompt text instead of being read as a flag. The first sign was `--json` producing followed only by log lines then a plain-text error message. `partitionRunArgs` splits `argv` into recognized flags (consuming a following value only for the flags that take one) and everything else, joined into the prompt, regardless of where in `argv` each flag falls -- so `amiro run "<prompt>" --json`, `amiro run --json "<prompt>"`, and everything interleaved between all parse the same way.
- **`--json`'s "one JSON value on stdout" promise needed a third fix, for a different reason than either bug above.** `internal/ai/bifrost.NewClient` leaves `schemas.BifrostConfig.Logger` nil, so `bifrost.Init` falls back to its own default logger, which writes structured JSON straight to `os.Stdout` at Info level -- on by default, and true of every entrypoint that builds a bifrost client (`cmd/server`'s sidecar and the TUI's embedded server already do this on startup; it just never mattered before because nothing was piping their stdout into `jq`). Reconfiguring that logger globally belongs to `internal/ai/bifrost`, if anywhere -- doing it here would change the sidecar's and the embedded TUI server's own startup logs too, well outside this phase's scope, for a problem that is specific to `amiro run --json`'s contract. `withStdoutSuppressed` redirects `os.Stdout` through a drained `os.Pipe()` for the duration of `runHeadlessTurn` only when `--json` was requested (checked with a cheap pre-scan, `argsRequestJSON`, before flags are even parsed, since the suppression has to wrap backend construction too) -- contained entirely to this one call, in this one binary invocation, restored before the one JSON line prints.
- **`amiro run` has no approval-resubmission path.** A turn that suspends (`Suspended: true` in the log, no `--yes`) is reported and the process exits 2 -- there is no headless equivalent of `SubmitApproval`/`BuildApprovalResubmission`. Building one would mean either a second, `amiro run`-only wire shape for resuming a paused assistant message (the exact duplication `internal/tui/session/resubmit.go`'s own doc comment already warns against creating a second time) or making `amiro run` a client after all, contradicting the in-process design this phase's own first deviation just justified. The documented remedy is simpler and already sufficient for a one-shot CI-style invocation: rerun with `--yes`, or use `--mode plan` (nothing in plan mode is gated in the first place).
- **`amiro run` does not support `--connect`.** `--connect` is a client concept (an explicit transport to somebody else's server); `amiro run` has no client at all, by design, so there is nothing for it to attach to. Running an agent turn against a thread that lives on someone else's server, headlessly, is a real future need, but it is a *different* feature (`amiro run` growing a client mode, or a `--connect`-aware sibling command) rather than a gap in this phase's own scope.

### Verification actually run

```bash
go build ./... && go vet ./...                                                          # clean
gofmt -l internal/tui cmd/amiro                                                          # clean -- pre-existing drift elsewhere untouched
go test ./...                                                                            # all green
go test -count=1 ./tests/... ./internal/httpserver/... ./internal/api/chat/... \
        ./internal/tui/... ./internal/secrets/... ./cmd/amiro/...                        # uncached, all green
for i in 1 2 3; do go test ./...; done                                                    # 3 separate process runs, all green
go build -o amiro ./cmd/amiro                                                             # builds clean
pnpm test                                                                                 # 29 files / 354 tests, unchanged -- no frontend touched
```

Manual smoke -- the plan's own row for this phase ("`amiro run \"...\" --json | jq` in CI") is the *only* manual smoke a headless command actually needs, since there is no TUI and no desktop surface to compare against, and it is run for real, against a real embedded backend, in this sandbox:

```
$ AMIRO_APP_DATA_DIR=$(mktemp -d) amiro run "say hello" --json 2>/dev/null | jq -r '.error'
no keys found for provider: openai and model: gpt-4.1
$ echo $?   # (PIPESTATUS[0], amiro run's own exit code)
1
```

This is the strongest available proxy for "the whole thing works end to end" in a sandbox with no configured LLM provider: a real `appwiring.App` (real SQLite, real MCP manager, real bifrost client) is built, a real user is provisioned and signed in, `chat.RunTurn` is actually called and actually attempts a real model call -- which fails for the one reason this environment cannot avoid (no provider key), exactly the same "no live LLM provider" caveat every phase so far has recorded, not a bug in anything this phase built. What that failure incidentally proved, because it required the whole pipeline downstream of "no error path taken" to be exercised for real: `--json` prints exactly one well-formed JSON value on stdout with nothing else mixed in (the `withStdoutSuppressed` fix, verified by piping through the real `jq` binary present in this sandbox), the exit code is 1 as `exitCode()` promises for a failed turn, and `resolveHeadlessUser` successfully auto-provisioned and signed in a desktop-default account against the fresh `AppDataDir` with no manual login step.

**Genuinely unverified, stated plainly:** a turn that actually completes with real assistant text (needs a configured provider key this sandbox does not have), and the `--yes`/suspended path against a *real* gated tool call and a *real* model deciding to call one (the pure `TestRunOutputFrom_SuspendedForApproval` test proves the schema/exit-code half of this without a model; the "a model actually asks for something gated, `--yes` actually answers it" half needs one).

### New tests, and what each is guarding

| Test | Guards |
|---|---|
| `cmd/amiro/run_test.go` - `TestRunOutputFrom_*`, `TestRunOutput_JSONSchema*` (the Phase 6 backend gate's "`--json` log schema test") | A clean finish carries no `suspended`/`approval`/`error` keys at all (`omitempty` actually omits, not `null`/`false`); a suspended turn carries both; `log` is `session.Event`'s own JSON shape verbatim, not a flattened summary; a nil `*session.Log` (RunTurn's own zero-value-on-error contract) never panics `runOutputFrom` |
| `TestExitCode_Table` (the Phase 6 backend gate's "exit codes" half) | 0/1/2 map to clean-finish/error/suspended exactly, and error takes precedence over suspended if a caller ever managed to set both |
| `TestPartitionRunArgs_*` | **The regression pin for the trailing-flags bug this phase's own manual smoke found**: flags after the prompt, before it, and interleaved all split correctly; `--model=value` does not swallow the next positional word |
| `TestArgsRequestJSON` | The stdout-suppression pre-scan recognizes `--json` and `--json=true` and does not false-positive on an unrelated argument |
| `TestSplitProviderModel_*` | `--model`'s "provider/model" vs. bare-model-name parsing, mirroring `internal/tui/config`'s own `parseModel` |

### Things that cost time - read before repeating them

- **Both of this phase's real bugs (the swallowed mid-stream error, and the unparsed trailing `--json`) were invisible to the pure unit tests and could only be found by actually running the built binary.** This is worth stating as a general lesson for headless/CLI work specifically: a CLI's contract with a human or a script is "the actual bytes that land on stdout/stderr and the actual process exit code for the actual argv a user would type" -- and pure logic tests, however thorough, test the functions the code author already believed were the relevant ones. `runOutputFrom`/`exitCode()`'s tests were airtight and still could not have caught either bug, because both bugs were about *what got passed into* those functions, not about the functions themselves. The fix in both cases was the same discipline this whole arc keeps re-learning at a different layer each time (Phase 3's `__tag`, Phase 4's Export id, now this): construct the actual invocation and read the actual output, not just the code that is supposed to produce it.
- **`internal/ai/bifrost.NewClient` has no logging configuration today, and every entrypoint that builds one inherits whatever `bifrost.Init`'s default logger does.** This was already true before this phase (`cmd/server` and the embedded TUI server both print the same `{"level":"info",...}` lines to their own stdout on startup) -- it just never mattered until something piped that stdout somewhere machine-readable. Worth a real fix in `internal/ai/bifrost` itself (wire `schemas.BifrostConfig.Logger` to something configurable, or at least default it to stderr) the next time anything else needs clean stdout from a process that builds a bifrost client -- out of scope here, but now on record rather than quietly worked around a second time somewhere else.
- **`bifrostai.Usage`'s zero value is not `nil`** -- `runOutput.Usage *bifrostai.Usage` needed `omitempty` and a genuinely nil pointer (never constructing an empty `&bifrostai.Usage{}`) to actually disappear from `--json`'s output on a turn that never got usage data (every failed-before-completion case in this sandbox). Confirmed by reading the schema test's own JSON output rather than assuming `omitempty` on a pointer field does what it should -- it does, but only if nothing upstream constructs a non-nil-but-empty one, which `chat.TurnResult.Usage` already never does (`addUsage` returns `nil` when both operands are nil).

### What Phase 7 (if any) can now assume

Phase 6 is the last phase this plan's Part 4 names. Nothing forward-looking is owed here the way Phases 0-5 owed the next phase a foothold -- but for whoever eventually revisits this tree:

- `cmd/amiro` now has three genuinely different execution shapes living side by side, and they are not interchangeable: `runTUI`/`runAuth` (client of a resolved transport, `internal/tui/client`), and `runHeadless` (in-process `chat.RunTurn`, no client, no transport). Anything added to `cmd/amiro` should pick one of these two shapes deliberately, not blend them -- the plan's own §2.2 carve-out is the one place blending was ever intended, and it is already spent on `amiro run` and the eval harness.
- `runOutput`/`.exitCode()` is the pattern for any future headless-style command that needs both a human-readable and a `--json` machine-readable form from one execution: one struct, one place that decides what happened, two printers reading from it, and the process-exit side effect kept out of anything a test needs to drive.
- The `internal/ai/bifrost` stdout-logging gap (this entry's own "things that cost time" note) is real, pre-existing, and affects every entrypoint, not just this one -- worth fixing at the source before it costs a third workaround somewhere else.

---

## Entry template for the next phase

```markdown
## Phase N - <name> - landed <date>

### What landed
| Item | Files |

### Deviations from the plan, and why

### Verification actually run
(commands, and the result of each - backend AND desktop, per the plan's Part 5 exit table)

### New tests, and what each is guarding

### Things that cost time - read before repeating them

### What Phase N+1 can now assume
```

---

## 2026-10-17: Go harness retired, Rust-only native surface and desktop review

### Summary
The legacy Go test harness (tests/cmd/amirotest, tests/harness/, tests/suites/) and the last remaining Go fixture (tests/fixtures/mcp/server/main.go) have been retired. Amiro native surfaces are now Rust-only:
* Desktop shell: Tauri and Rust (src-tauri/) with lib renamed to `amiro_desktop` and license set to `MIT`
* Native testkit: std-only offline Rust test harness (tests/rust/, package `amiro-testkit`) with real file and binary checks
* Backend: Node adapter runtime (adapter/src/server.mjs) bridging to the external engine daemon
* Web and E2E: Vitest and Playwright

### Verification
* `cargo test --offline` in tests/rust: 16 passed, 0 failed.
  - Real CLI tests for bin/amiro (branding, --version, --help, engine delegation via AMIRO_RUNTIME_BIN, missing engine exit 127).
  - Real sidecar launcher script generation test (src-tauri/build-sidecar.sh staging binaries/backend-<triple>).
  - Real MCP JSON-RPC protocol test against tests/fixtures/mcp/server/server.mjs via child process pipes.
  - Real file and license checks asserting zero own Go files, adapter route structure, and Tauri configuration.
* `cargo check --offline` in src-tauri: executed offline, blocked by missing system package `pkg-config` (and GTK/WebKit headers) on this Linux host.

### Tauri Packaging Plan for Review
1. Current phase: The Tauri launcher script (src-tauri/build-sidecar.sh) execs node against adapter/src/server.mjs during local preview.
2. In-progress backend: Native backend (backend/) and runtime (runtime/) are being actively implemented.
3. Target distribution packaging: Once native backend achieves parity, build-sidecar will compile and stage the native backend binary directly into src-tauri/binaries/ without any Node or shell launcher dependency.


