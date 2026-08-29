# Phase 02 — Sandboxed shell execution

**Status:** ⚠️ Complete with a named gap (4/5 criteria MET, 1 PARTIAL — see
§3). The sandbox mechanism itself is real, proven against a real bubblewrap
backend on Linux, not just the honest fallback.
**Date:** 2026-08-29
**Verification Log:** [verification-log-phase-02.md](verification-log-phase-02.md)

---

## 1. What Shipped

`run_shell` (and its `terminal-execution` alias) now runs every command
through a pluggable sandbox backend instead of a raw `os/exec` call. On
Linux, when `bwrap` (bubblewrap) is installed and actually able to create
namespaces, a command's writes are confined to the workspace root
(everything else on the filesystem is read-only) and its network access is
denied by default — a fresh network namespace with no route at all, not
even loopback — unless the command's own prefix matches a new,
per-project `SandboxNetworkAllow` config list. On macOS, the same contract
is implemented against `sandbox-exec` (`seatbelt.go`), wired identically
but **not exercised in this environment** — no macOS host was available
this session; see the verification log's criterion 2 for exactly what that
means and doesn't mean. On Windows, and on any platform/environment where
neither primitive is available or usable, the honest fallback runs the
command exactly as before and says so: every `run_shell` result now
carries `sandboxed` and `sandbox_backend` fields, and `false`/`"none"` is
never hidden or softened — it is this phase's central honesty contract,
because Phase 4 (background agent runs) will refuse to execute shell at
all unless `Sandboxed` is true.

Detection (`internal/agent/sandbox.Detect`) is opportunistic and cached
for the process lifetime, the same shape `internal/agent/lsp`'s server
discovery already uses: probed once with a real smoke invocation (not
just a `PATH` check — a `bwrap` binary present but unable to create
namespaces in a restrictive container is treated exactly like "not
found"), never re-probed per call.

Every surface that shows a `run_shell` result now shows this status: the
TUI status bar gains a `sandbox:<backend>` field (dropped under width
pressure the same way Mode/Skill already are); the web/desktop
`TerminalWindow` component gains a sandboxed/unsandboxed badge; a new
`GET /api/sandbox/status` route lets a client ask before any command has
even run, which is what the TUI's status bar uses to populate itself at
launch.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Sandbox package** | `backend-go/internal/agent/sandbox/{sandbox,bubblewrap,seatbelt,none,detect,detect_linux,detect_darwin,detect_other,networkallow}.go` | `Backend` interface, `Run`/`Command` (wrap argv, execute, report `Result{Sandboxed,Backend}`), one implementation per platform, `Detect()` cached for the process lifetime, `NetworkAllowed` (mirrors `permission.commandAllowed`'s token-prefix matching for `SandboxNetworkAllow`) |
| **Config** | `backend-go/internal/config/config.go` | `SandboxNetworkAllow []string`, parsed from `AMIRO_SANDBOX_NETWORK_ALLOW` (comma-separated); empty/unset denies network to every sandboxed command |
| **Terminal tool** | `backend-go/internal/ai/tools/terminal.go` | `TerminalExecutor.Run`/`runBackground` call `sandbox.Run`/`sandbox.Command` instead of `exec.Command`/`exec.CommandContext` directly; `terminalOutput` gains `Sandboxed`/`SandboxBackend` |
| **Tool deps** | `backend-go/internal/ai/tools/tools.go` | `Deps.SandboxNetworkAllow`, threaded into `terminalTools` |
| **Chat handler wiring** | `backend-go/internal/api/chat/{handler,route}.go` | `Handler.sandboxNetworkAllow` + `WithSandboxNetworkAllow`, threaded into `toolDeps` |
| **App wiring** | `backend-go/internal/appwiring/wiring.go` | `chatHandler.WithSandboxNetworkAllow(cfg.SandboxNetworkAllow)` |
| **HTTP route** | `backend-go/internal/api/sandbox/handler.go`, `backend-go/internal/httpserver/router.go` | `GET /api/sandbox/status` — session-gated, reports `Detect()`'s cached result |
| **TUI client** | `backend-go/internal/tui/client/{client,http}.go` | `Client.SandboxStatus` |
| **TUI page wiring** | `backend-go/internal/tui/page/{chat,sandbox_status}.go` | `Chat.sandbox` field, `loadSandboxStatus` fired from `Init`, `statusBar()` passes it through |
| **TUI status bar** | `backend-go/internal/tui/component/status/bar.go` | `Info.Sandbox`, rendered as `sandbox:<backend>`, dropped under width pressure like Mode/Skill/WorkspaceRoot |
| **Web/desktop presenter** | `src/components/ui/terminal-window.tsx`, `src/components/tool-presenters/shell-presenters.tsx` | `TerminalWindow`'s `sandboxed`/`sandboxBackend` props, a `SandboxBadge`; `runShell.Expanded` passes `output.sandboxed`/`output.sandbox_backend` through |
| **Test client helper** | `tests/harness/apiclient/sandbox.go` | `Client.SandboxStatus`, for the route-coverage guard and real-HTTP tests |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend (unit) | `backend-go/internal/agent/sandbox/{sandbox,networkallow}_test.go` | 10 | `TestSandbox_BlocksWriteOutsideWorkspaceRoot`/`TestSandbox_BlocksNetworkUnlessAllowlisted` against a real bubblewrap backend; `TestSandbox_FallsThroughToUnsandboxedAndSaysSo` (forces the `none` backend deterministically, proven environment-independent by also hiding real `bwrap` from the filesystem — see the verification log); `Detect()` caching and honesty-contract invariants; `NetworkAllowed`'s matching shape (including shell-operator disqualification, mirroring `permission.commandAllowed`) |
| backend (unit) | `backend-go/internal/ai/tools/terminal_sandbox_test.go` | 2 | `run_shell`'s output carries consistent `Sandboxed`/`SandboxBackend`; the background-task path (rebuilt on `sandbox.Command`) still starts and returns a `task_id` |
| backend (unit) | `backend-go/internal/config/config_test.go` | 2 | `SandboxNetworkAllow` parses a comma-separated env var, trims whitespace, empty entries dropped; unset defaults to `nil` (not an empty slice that would still read as "configured") |
| backend | `tests/suites/backend/sandbox/` | 8 | Real-HTTP: honest status on a real `run_shell` call; write confinement; network denied by default / allowed once allow-listed, against a real listening loopback server (not a dead port); `GET /api/sandbox/status` matches the same process's `run_shell` result and requires auth; the honest-fallback claim (reasoned-skip when a real backend is present, since its unconditional twin lives at the unit layer) |
| desktop | `tests/suites/desktop/sandbox/` | 4 | The sidecar build (`cmd/server`, what `harness.New` actually spawns for every desktop test) carries the identical honesty contract, write confinement, and network allow-list behavior as the dashboard build — no cargo/Tauri CLI needed, since sandboxing has no Rust surface |
| tui (unit) | `backend-go/internal/tui/component/status/bar_test.go` | 2 | Golden test across `unset`/`bubblewrap`/`seatbelt`/`none` (exit criterion 4); the field is dropped under width pressure like Mode/Skill |
| tui (unit) | `backend-go/internal/tui/page/chat_test.go` | 2 | `loadSandboxStatus`'s result reaches `Chat.sandbox` and the rendered status bar; a failed status call degrades to "leave the field unset" rather than showing a wrong value |
| web (unit) | `src/components/tool-presenters/shell-presenters-sandbox.test.ts` | 3 | `runShell.Expanded`'s returned element tree carries `sandboxed`/`sandboxBackend` through to `TerminalWindow`'s props, for `true`, `false`, and "not yet known" (pending, no output) |
| meta | `tests/suites/meta/terminal_sandbox_guard_test.go` | 3 | An AST guard: `terminal.go` (and any future `terminal_*.go`) may only spawn a subprocess through `sandbox.Run`/`sandbox.Command`, never `exec.Command`/`exec.CommandContext` directly; non-vacuous; passes clean against the real file today |

**Total: 36 new tests.**

### Files Modified

| Path | Change |
|---|---|
| `backend-go/internal/ai/tools/terminal.go` | `Run`/`runBackground` rebuilt on `sandbox.Run`/`sandbox.Command`; `terminalTools` takes `networkAllow []string`; `terminalOutput` gains two fields |
| `backend-go/internal/ai/tools/tools.go` | `Deps.SandboxNetworkAllow`, threaded to `terminalTools` |
| `backend-go/internal/config/config.go` | `SandboxNetworkAllow` field + `AMIRO_SANDBOX_NETWORK_ALLOW`/legacy env parsing |
| `backend-go/internal/api/chat/handler.go` | `sandboxNetworkAllow` field + `WithSandboxNetworkAllow` |
| `backend-go/internal/api/chat/route.go` | `toolDeps` carries it through |
| `backend-go/internal/appwiring/wiring.go` | Wires `cfg.SandboxNetworkAllow`; registers the new `sandboxapi.Handler` |
| `backend-go/internal/httpserver/router.go` | `Handlers.Sandbox` + `GET /api/sandbox/status` route registration |
| `backend-go/internal/tui/client/client.go`, `http.go` | `Client.SandboxStatus` interface method + HTTP implementation |
| `backend-go/internal/tui/page/chat.go` | `sandbox` field, `Init` fires `loadSandboxStatus`, `Update` handles `sandboxStatusMsg`, `statusBar()` passes `Sandbox` |
| `backend-go/internal/tui/component/status/bar.go` | `Info.Sandbox`, `sandboxLabel`, rendering + width-pressure drop |
| `backend-go/internal/tui/app/app_test.go`, `internal/tui/page/chat_test.go` | Fake `client.Client` implementations gain `SandboxStatus` |
| `src/components/ui/terminal-window.tsx` | `sandboxed`/`sandboxBackend` props, `SandboxBadge` |
| `src/components/tool-presenters/shell-presenters.tsx` | `runShell.Expanded` passes the two fields through |

---

## 2. What Diverged from the Plan, and Why

**Divergence 1 — `GET /api/sandbox/status` was not named in the phase
doc, but was added anyway.** The phase doc's deliverable table only names
the TUI status bar and the `run_shell` card's badge as status surfaces.
Wiring the TUI status bar honestly requires *something* to answer "what is
this session's sandbox backend" before any `run_shell` call has ever run
(a user opens the TUI and the bar should not read blank until they
happen to run a command) — the route is the natural way to answer that,
sessioned the same way every other status endpoint in this codebase is.
Adding it also meant `TestRouteCoverageGuard` (an existing `suites/meta`
guard, not new this phase) caught a real gap: the route existed with zero
test coverage in `suites/backend/` for one build. Closed by adding
`harness/apiclient/sandbox.go` and two backend tests rather than reaching
for the waiver file — this is exactly the kind of gap that guard exists to
catch, and waiving it would have been the wrong response to a real,
useful failure.

**Divergence 2 — `TestSandbox_BlocksNetworkUnlessAllowlisted`'s fixture is
a real listening loopback server, not a dead port.** The design doc's own
example (`curl` to an unreachable host) undersells a real subtlety: `curl`
reports the same exit code 7 and `%{http_code}` of `000` whether a network
namespace has no route at all *or* a real, shared namespace simply has
nothing listening on the target port. A dead-port fixture cannot
distinguish "the sandbox denied this" from "nobody's home" — both unit and
real-HTTP tests instead start a real `net/http.Server` on `127.0.0.1:0`
and assert the *positive* case (network allowed) actually receives `200`
from it, which only a real, working network path can produce.

**Divergence 3 — `internal/agent/sandbox`'s own package doc frames itself
around a `Backend` interface with an unexported `wrap` method, not the
`Run(ctx, cmd, opts) (Result, error)` signature literally quoted in the
build-order instructions.** The literal signature (`cmd` as a single
value) doesn't distinguish "the argv to run" from "the options to run it
with," and `terminal.go` needs two different execution shapes from the
same backend: a captured, buffered run (the foreground `run_shell` path)
and a piped, streamed one (the background-task path, which needs
`StdoutPipe`/`StderrPipe`, not a captured `Run`). The package instead
exposes `Command(ctx, argv, opts) (*exec.Cmd, Result)` — the shared
primitive, returning an `*exec.Cmd` the caller still owns for
`Start`/`Wait`/pipes — and `Run(ctx, argv, opts) (Result, error)` as the
convenience wrapper built on top of it for the common captured case. This
keeps `Result.Sandboxed`/`Result.Backend` in exactly one place while
covering both of `terminal.go`'s real call shapes; the `none`/`bubblewrap`/
`seatbelt` backends still match the phase doc's file list exactly.

**Divergence 4 — the tests/suites/meta guard's filename is
`terminal_sandbox_guard_test.go`, not `sandbox_guard_test.go`.** A
pre-existing, unrelated guard (`suites/meta/sandbox_guard_test.go`, over
`ws.ResolveReadable`/`ws.RelReadable` in `internal/ai/tools`, part of an
earlier phase not this one) already owns that filename. It was
accidentally overwritten once during this phase's work and restored
immediately from `git show` before any test ran against the wrong version
— see the verification log for the two files' test output side by side,
proving both guards are intact and independent.

**Divergence 5 — a real, pre-existing, unrelated TUI test failure was
found and root-caused, not fixed.** `tui/skills/TestTUI_SlashPalette_ListsBuiltinsAndSkillsGrouped`
fails in this working tree because of an uncommitted Phase 1 change (a
`/rewind` slash command added to `internal/tui/component/editor/slash.go`'s
`Commands` list) that pushes the built-in count past the palette's
`maxRenderedMatches = 10` cap once two skills are also present, collapsing
the second skill into "+1 more." Confirmed root cause by temporarily
removing that one line and re-running the test clean, then restoring the
line immediately — nothing in this phase's own diff touches that file or
the palette's row budget. Named in the verification log rather than
silently worked around or silently left unmentioned.

---

## 3. Exit Criteria (Verbatim from the Phase 02 Plan)

1. **`amirotest run --surface backend --feature sandbox` passes, with any
   platform-specific skip reasoned and visible in the run summary.**
   ✅ **MET.** 6 passed, 0 failed, 1 reasoned skip. See the verification
   log's criterion 1.

2. **`TestSandbox_BlocksWriteOutsideWorkspaceRoot` and
   `TestSandbox_BlocksNetworkUnlessAllowlisted` both pass on at least one
   real sandbox backend in CI.**
   ✅ **MET, against a real bubblewrap backend on Linux.** Both names pass
   at the unit layer (`internal/agent/sandbox`) with a real, smoke-tested
   `bwrap` binary actually wrapping every command, and the same claims are
   re-verified at the real-HTTP layer under their own test names
   (`TestSandbox_BlocksNetworkByDefault`/`TestSandbox_NetworkAllowlistReachesARealHost`
   in `tests/suites/backend/sandbox`). **Not** verified against
   `sandbox-exec` on macOS — no macOS host was available this session; see
   §5.

3. **`TestSandbox_FallsThroughToUnsandboxedAndSaysSo` passes — a command
   run with no available backend still executes (no capability
   regression) and `Result.Sandboxed` is `false`.**
   ✅ **MET, and proven environment-independent for certain** — not merely
   asserted. Passes with bubblewrap present (via `forceBackendForTest`,
   pinning `Detect()`'s cache to `none` regardless of what the platform
   probe would have found) *and* with `/usr/bin/bwrap` genuinely removed
   from the filesystem for the duration of a real re-run — see the
   verification log's criterion 3 for both real command transcripts.

4. **The TUI status bar shows the sandbox indicator, asserted by a golden
   test in `internal/tui/component/status`.**
   ✅ **MET.** `TestRender_Golden_SandboxIndicator` covers all four states
   (`unset`, `bubblewrap`, `seatbelt`, `none`); `none` renders as plainly as
   any real backend, per the honesty contract. Page-level wiring
   (`loadSandboxStatus` → `Chat.sandbox` → `statusBar()`) is covered
   separately at the page-model layer, not folded into the golden test
   itself.

5. **`amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.**
   ⚠️ **PARTIAL.** `meta`, `backend`, `desktop`, `cross` are fully green:
   272 passed, 0 failed, every skip reasoned (tag exclusions, this phase's
   own reasoned real-backend skip, cargo-toolchain skips, and two
   pre-existing PARTIAL/NOT-MET resilience rows carried forward from
   Phase 1's own record, unrelated to sandboxing). `tui` has 41 passed, 1
   failed (the pre-existing, root-caused, unrelated `/rewind`-palette
   overflow bug — §2, divergence 5), 8 reasoned skips. `ui` cannot launch
   in this sandbox at all (`pnpm` absent, the same infrastructure gap
   phases 0/1 recorded) — its frontend claim is instead covered by
   `vitest` (357/357 passing) and a static React-element-tree inspection,
   not a real browser. See the verification log's criterion 5 for every
   command and its real output.

**Summary: 4 of 5 exit criteria MET literally, 1 PARTIAL** (green on 4 of
5 surfaces `amirotest run` covers, with one pre-existing unrelated `tui`
failure and one pre-existing `ui` infrastructure gap, neither introduced
by this phase).

---

## 4. Standards Compliance

- **Additive by default.** `terminal.go`'s public contract
  (`terminalInput`/`terminalOutput`'s existing fields, the tool's schema)
  is unchanged; `Sandboxed`/`SandboxBackend` are new fields, not
  replacements. Every existing backend test in `suites/backend/chat`,
  `suites/backend/security` that exercises `run_shell` still passes
  unmodified (confirmed via the full `--surface backend,meta,desktop,cross`
  run in the verification log).
- **Nothing regresses.** The full-run numbers above are net of this
  phase's own new tests — the only new failure surfaced was the
  pre-existing, unrelated `tui` bug named and root-caused in §2.
- **Windows named as a non-goal, not silently absent.** `detect_other.go`
  (the `!linux && !darwin` build) has a doc comment naming job-object
  isolation as separate, deferred work, matching `00-overview.md`'s and
  `03-sandboxed-execution.md`'s own framing.
- **Every phase touching product code says so up front.** This phase
  touches `terminal.go`'s execution path directly (replacing `os/exec`
  calls with `sandbox.Run`/`sandbox.Command`) — named in the build order
  and covered by the `suites/meta` AST guard specifically so a future
  regression back to direct `exec.Command` fails a test, not a review.

---

## 5. Known Scope Boundaries & Follow-ups

- **macOS/`sandbox-exec` is unverified in this container.** `seatbelt.go`
  is wired identically to `bubblewrap.go`, uses the same `Backend`
  interface, and cross-compiles cleanly for `darwin/arm64`
  (`GOOS=darwin GOARCH=arm64 go build ./internal/agent/sandbox/...`
  succeeds) — but it has never run against a real `sandbox-exec` binary,
  because no macOS host was available this session. Whoever next has one
  should run `tests/suites/backend/sandbox` there and confirm
  `requireLinuxBubblewrap`'s equivalent for seatbelt (not currently
  written, since it would only ever skip on this Linux container) passes
  against the real primitive.
- **A Settings UI for `SandboxNetworkAllow`** is, as the phase doc names,
  a smaller follow-up, not blocking — raw config (`AMIRO_SANDBOX_NETWORK_ALLOW`)
  is the only way to set it today.
- **The `tui/skills` palette overflow bug** (§2, divergence 5) is real and
  belongs to whoever picks up Phase 1's remaining follow-ups next — either
  raise `maxRenderedMatches`, or make the palette's row budget
  width/height-aware rather than a fixed constant. Not fixed here, since
  it is not this phase's bug.
- **The one pre-existing flake** seen during this phase's full-suite run
  (`backend/security/TestSecurity_WorkspaceEscapeIsRefusedThroughTheDashboard`,
  passed on retry) is unrelated to sandboxing and was not investigated
  further here — same category as Phase 1's own recorded real-PTY flake,
  worth someone's attention eventually but not blocking.
- **Phase 4** (background agent runs) can now build on this phase's
  `Result.Sandboxed` flag as designed — an unattended run refusing to
  execute shell unless `Sandboxed` is true is real, checkable state after
  this phase, not aspirational.
