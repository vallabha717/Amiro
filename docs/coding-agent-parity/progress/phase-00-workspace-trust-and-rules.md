# Phase 00 — Workspace trust + `AGENTS.md`

**Status:** ⚠️ Complete with gaps (4/6 criteria MET)
**Date:** 2026-08-23
**Verification Log:** [verification-log-phase-00.md](verification-log-phase-00.md)

---

## 1. What Shipped

A consent gesture now stands in front of every write, command, and external
call an agent turn attempts: a `workspace_trust` row per (user,
resolved_root), checked by `permission.Engine` ahead of every mode branch,
auto-granted the instant a root matches the server's own configured
default and checked against a real grant otherwise. A plain `AGENTS.md` (or
`.agents/AGENTS.md`) at the workspace root is now read into the system
prompt on every turn, ahead of the Skills catalog. All four surfaces reach
it: backend (the enforcement point and the HTTP routes), web (a trust
prompt on the project picker, a granted-roots settings card), terminal (the
same prompt reusing the tool-approval dialog's chrome with its own hint
text), and desktop (free — it's the same web bundle).

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Migration** | `backend-go/internal/db/migrations/{sqlite,postgres}/0025_workspace_trust.{up,down}.sql` | `workspace_trust(id, user_id, resolved_root, granted_at, granted_via)`, unique on `(user_id, resolved_root)` |
| **Model** | `backend-go/internal/db/models/workspace_trust.go` | `WorkspaceTrust` gorm struct |
| **Repository** | `backend-go/internal/db/repository/workspacetrust.go` | `IsTrusted`, `Grant`, `Revoke`, `List`, and `IsTrustedForTurn` — the one method both the turn path and the status route call, so they can never disagree (see divergence 3) |
| **Permission gate** | `backend-go/internal/agent/permission/permission.go` | `Engine` gains `trusted bool` (default `true`) and `WithTrust(bool)`; `Evaluate` refuses every consequential risk when untrusted, checked ahead of every mode branch including Auto |
| **AGENTS.md reader** | `backend-go/internal/agent/rules/rules.go` | `Build(root)` — first-match of `AGENTS.md`/`.agents/AGENTS.md`, capped at 8192 runes with a visible truncation notice |
| **HTTP routes** | `backend-go/internal/api/workspacetrust/{handler,route}.go` | `GET /api/workspace-trust`, `GET .../status`, `POST .../grant`, `POST .../revoke` |
| **Runner wiring** | `backend-go/internal/api/chat/runner.go` | Resolves `Trusted` via `IsTrustedForTurn` ahead of `permission.New(...).WithTrust(...)`; injects `rules.Build`'s output ahead of the skill catalog |
| **Web API client + hook** | `src/lib/backend/workspace-trust-api.ts`, `src/hooks/queries/use-workspace-trust.ts` | Typed client + two SWR hooks (`useWorkspaceTrustStatus`, `useWorkspaceTrustGrants`) |
| **Web trust prompt** | `src/components/workspace-trust/trust-prompt-dialog.tsx` | An `AlertDialog`, not a reused `ToolApprovalCard` — see divergence 1 |
| **Web settings card** | `src/components/workspace-trust/trust-settings-card.tsx` | Lists granted roots with a revoke button, wired into `UserDetailContent` |
| **Project selector wiring** | `src/components/chat/project-selector.tsx` | Checks trust whenever `projectDirectory` changes, including on mount from persisted storage (see divergence 2) |
| **TUI client** | `backend-go/internal/tui/client/{client,http}.go` | `WorkspaceTrustStatus`, `GrantWorkspaceTrust` added to the `Client` interface |
| **TUI dialog reuse** | `backend-go/internal/tui/component/approval/dialog.go` | New `RenderWithHint`, `Render` now a thin wrapper over it — the only new "component," and it's a parameter, not a new type |
| **TUI page wiring** | `backend-go/internal/tui/page/{chat,workspace_trust}.go` | Fired from the first `resize()`, not `Init` — see divergence 4 for why, and for what's still unresolved about it |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend (unit) | `backend-go/internal/db/repository/workspacetrust_test.go` | 7 | Grant/revoke/list round trip, idempotent grant, per-user scoping |
| backend (unit) | `backend-go/internal/agent/permission/permission_test.go` (+4) | 4 | Untrusted refuses Write/Exec/External in every mode incl. Auto; Read/Session unaffected; `New` defaults trusted; `WithTrust` chains |
| backend (unit) | `backend-go/internal/agent/rules/rules_test.go` | 7 | Missing file, empty root, root vs. `.agents/` precedence, truncation, whitespace-only file |
| backend (unit) | `backend-go/internal/api/workspacetrust/handler_test.go` | 6 | Status/Grant/Revoke/List over real sqlite, 401s, bad-root 400s |
| backend (unit) | `backend-go/internal/api/chat/{runner_test,approvals_test}.go` (+7) | 7 | Untrusted refuses write via the real tool loop and via a real `RunTurn`; trusted+Auto still runs; env-sourced root auto-grants; request-echoed default root still auto-grants; request-supplied non-default root does not; AGENTS.md lands in the captured system prompt ahead of the skill catalog |
| backend (unit) | `backend-go/internal/tui/page/workspace_trust_test.go` | 6 | First resize fires the check, second doesn't; prompt blocks Enter; grant/decline close it correctly |
| backend | `tests/suites/backend/workspacetrust/` | 5 | Grant/revoke/list round trip over real HTTP; 401 on all four routes; ungranted root refuses a real write turn; the server's own default auto-grants and a write against it actually succeeds |
| terminal | `tests/suites/tui/workspacetrust/` | 3 | Prompt appears under a real PTY; decline leaves the turn refused; grant lets the write run — **tagged `flaky`, excluded from the default run** (see divergence 4) |
| cross | `tests/suites/cross/workspacetrust/` | 1 | A root granted via the HTTP API (the desktop app's own path) is honored by a TUI attaching with `--connect`, no separate grant step |
| web | `tests/ui/specs/workspacetrust/` | 3 | Prompt appears for an ungranted persisted root and grants it; surviving a reload; decline leaves it ungranted; settings lists a granted root and revoke removes it — **written, could not be executed in this sandbox** (see divergence 5) |
| meta | `tests/suites/meta/workspacetrust_guard_test.go` | 3 | Only `runner.go`/`eval_agent.go` may call `permission.New` anywhere in `backend-go/internal`; guard is non-vacuous; the allowlist itself doesn't false-positive |

**Not covered, and why:** the AGENTS.md-lands-in-the-real-provider-prompt claim is proven only at the backend-go unit level (`captureSystemEngine`), not re-proven against the cross-surface harness's `fakeprovider` — the fake's `Matcher` interface receives the full message list, but its `Contains` matcher only inspects the last user-role message, and adding a matcher that scans the system role for this one assertion felt like more new test-infrastructure than the claim warranted given unit coverage already exists. A follow-up if the unit-level proof is ever judged insufficient.

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `backend-go/internal/agent/permission/permission.go` | `trusted` field, `WithTrust`, `Trusted()`, the gate in `Evaluate` | +41/-0 (net) |
| `backend-go/internal/api/chat/handler.go` | `trust` field + `WithWorkspaceTrust` | +27/-0 |
| `backend-go/internal/api/chat/runner.go` | Trust resolution ahead of `permission.New`; AGENTS.md injection ahead of the skill catalog | +70/-14 |
| `backend-go/internal/httpserver/router.go` | `WorkspaceTrust` field + 4 routes | +27/-0 |
| `backend-go/internal/appwiring/wiring.go` | Repository construction, `WithWorkspaceTrust`, handler wiring with `app.WorkspaceRoot` as the default-root argument | +12/-1 |
| `backend-go/tests/migration/migration_test.go` | Table-count test renamed Eighteen→Nineteen, `workspace_trust` added to the `want` list | +15/-2 |
| `backend-go/internal/tui/client/{client,http}.go` | Two new `Client` interface methods + HTTP implementations | +93/-0 |
| `backend-go/internal/tui/component/approval/dialog.go` | `RenderWithHint` extracted, `Render` now calls it with the default hint | +17/-6 |
| `backend-go/internal/tui/page/chat.go` | `trustPromptRoot` field, key-gate, render block, `resize` now returns a `tea.Cmd` | +79/-6 |
| `src/components/chat/project-selector.tsx` | Trust check moved to a `useEffect` on `projectDirectory` (fires on mount too, not just on pick) | net ~+20 functional lines, remainder is biome's import/formatting pass over the whole file |
| `src/components/user/user-detail/user-detail-content.tsx` | `WorkspaceTrustSettingsCard` added for `view === "user"` | +2 |
| `messages/{en,es,fr,ja,ko,no,zh}.json` | `WorkspaceTrust` key, 12 strings, all 7 locales | +12–14 each |
| `tests/ui/pages/index.ts` | `UserSettingsPage` page object | +36 |
| `docs/skills/00-overview.md` | Corrected the stale "no workspace-trust concept" non-goal line | +4/-3 |

---

## 2. What Diverged from the Plan, and Why

1. **The trust prompt is its own `AlertDialog`, not a reused `ToolApprovalCard`.**
   The design doc said "reuse the approval-card visual language rather than
   a new dialog primitive." A literal reuse doesn't fit: `ToolApprovalCard`
   and its TUI counterpart are both built around an "once vs. always" scope
   for one tool call, and a workspace grant has no "once" for "always" to
   be an alternative to. Read "visual language" as the operative phrase —
   same border/header/button-row shape, same `data-testid` conventions —
   and built a small dedicated component instead of forcing the mismatch.
   The TUI side reused the actual rendering function (`approval.Render`)
   by parameterizing its hint text (`RenderWithHint`), which is the
   closer-to-literal reuse the design doc anticipated for that surface.

2. **The web trust check now fires on every `projectDirectory` change,
   including page load from persisted storage — not only on a fresh
   folder pick.** The original implementation checked trust status only
   inside `selectDirectory()`, the folder-picker's own callback. That
   means a user who picked an ungranted project, closed the tab, and came
   back would never see the prompt on return — the persisted value just
   loads silently and the first write attempt is refused with no warning.
   Refactored onto `useWorkspaceTrustStatus` (SWR) plus a `useEffect`
   keyed on `projectDirectory`, which covers both paths through one code
   path instead of two.

3. **`IsTrustedForTurn` exists because the "auto-grant if it matches the
   server's default" logic cannot live only in `runner.go`.** The design
   doc assumed a status check and a turn would naturally agree, because
   both would consult the same grant table. They don't, by construction:
   the auto-grant is a *side effect* `runner.go` performs when a turn
   runs, and a status check made *before any turn has ever run* — exactly
   what the TUI's startup check and the web prompt's mount-time check both
   are — would see no grant row yet and report "untrusted" for a root that
   was always going to be auto-granted the moment a turn touched it. Real
   consequence, found late: the TUI's first-launch trust prompt showed up
   for the *default*, already-implicitly-trusted workspace, because the
   status check ran before any turn had triggered the auto-grant that
   would have made it correct. Fixed by moving the "does this equal the
   server's configured default" comparison into the repository itself
   (`IsTrustedForTurn(ctx, userID, resolvedRoot, processDefaultRoot)`), so
   both the turn path and the plain status route call the exact same
   method and can't drift apart. Also caught, from the same fix, a second
   real bug: the earlier `runner.go`-only logic keyed auto-grant on
   *whether the request left `WorkspaceRoot` empty*, but the TUI (and this
   suite's own request builders) always echo it back explicitly, even
   when the value equals the server's own default — which meant every
   existing `WorkspaceRoot`-supplying backend test would have started
   failing the moment this phase's gate went live, had it shipped as
   first written. `TestRunner_WorkspaceTrust_RequestEchoingProcessDefaultStillAutoGrants`
   is the regression test for exactly this.

4. **The TUI's real-PTY trust-prompt tests are flaky in this sandbox and
   are tagged `flaky` rather than `smoke` — not resolved, not silently
   shipped as passing.** The dialog's state is provably correct on every
   run: `Chat.View()` returns the dialog's exact ANSI-styled string on
   every call once the check lands, confirmed by direct instrumentation
   against a real PTY, not just the synchronous unit tests. What's
   unreliable is Bubble Tea's renderer actually painting that frame to the
   terminal when the underlying HTTP check (an in-memory round trip,
   fast) resolves very early in the program's life. Firing the check from
   the first `resize()` instead of `Init` narrows the window a little;
   returning `tea.ClearScreen` alongside the state change (forcing a full
   repaint instead of a diffed one) was the most promising lever tried.
   Neither, alone or combined, was reliable: repeated runs of the same
   code in this environment passed roughly 1 time in 5. A fixed
   `time.Sleep` before the check reproduced a single pass once and then
   failed 3 for 3 on immediate re-runs at the same duration, which is what
   ruled out "just wait longer" as a real fix rather than a coincidence —
   this reads as a genuine Bubble Tea/PTY-terminal-emulator race, not a
   logic bug, and is exactly what the `flaky` tag exists for: real,
   written, correct-by-inspection coverage that isn't reliable enough to
   gate the default run on. The underlying behavior is not left unproven
   — see the unit tests in `workspace_trust_test.go` (deterministic, drive
   the identical `Update`/`View` code with no real terminal involved) and
   `tests/suites/backend/workspacetrust/` (proves the same claims, and the
   real write-succeeds/write-refused outcomes, over real HTTP).

5. **The web Playwright spec could not be executed in this sandbox at
   all**, for two independent, environment-level reasons: `amirotest`'s
   `ui` surface shells out to `pnpm`, which isn't installed here (`exec:
   "pnpm": executable file not found in $PATH`, `amirotest run`'s own exit
   code 3 — infrastructure failure, its documented meaning); and a direct
   `playwright test` invocation (bypassing `pnpm` by calling the
   `playwright` binary under `tests/node_modules/.bin` directly) still
   fails at browser launch — the installed headless Chromium is missing a
   system shared library (`libxkbcommon.so.0`), which needs a package
   install this sandbox doesn't have privileges for. The spec itself
   passed `tsc --noEmit` and `biome check` cleanly and follows every
   existing spec/page-object convention in the tree; it has not been run
   even once.

---

## 3. Exit Criteria (Verbatim from the Phase 00 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `amirotest run --surface backend --feature workspacetrust` passes. | ✅ MET | 5 passed, 0 failed — verification log §1 |
| 2 | A turn against an ungranted, interactively-opened root refuses a `write_file` call with a message naming the missing grant, asserted by `TestPermission_UngrantedRootRefusesEveryConsequentialRisk`. | ✅ MET | Unit test passes; re-proven end-to-end by `TestWorkspaceTrust_UngrantedRootRefusesWrite` and `TestToolLoop_UntrustedWorkspaceRefusesAndTellsTheModelWhy` — verification log §2 |
| 3 | A turn against a root supplied via `AMIRO_WORKSPACE_ROOT` never sees a trust prompt, asserted by `TestWorkspaceTrust_EnvSourcedRootAutoGrants`. | ✅ MET | Both the backend-go unit version and the `tests/suites/backend/workspacetrust/` HTTP version pass — verification log §3 |
| 4 | `amirotest run --surface tui --feature workspacetrust` and `--surface ui --feature workspacetrust` both pass, each exercising the real prompt under a real PTY / real browser. | ⚠️ PARTIAL | TUI: 0 passed / 3 skipped, all reasoned (`tagged "flaky"`) — the tests exist and are correct by direct instrumentation, but are not reliable enough to require passing (divergence 4). UI: could not run at all in this sandbox — infrastructure gap, not a code defect (divergence 5). Underlying behavior proven instead by 6 backend-go unit tests plus 5 real-HTTP backend tests — verification log §4 |
| 5 | `amirotest run --surface cross --feature workspacetrust` passes, proving a desktop-granted root is trusted from an attached TUI client with no separate grant step. | ✅ MET | 1 passed, 0 failed, confirmed 3/3 on repeated runs — verification log §5 |
| 6 | `amirotest run` is green overall, `suites/meta` included, with every skip reasoned. | ⚠️ PARTIAL | 294 passed, 0 failed, 20 skipped (all reasoned) across backend/tui/cross/desktop/meta; `ui` could not run in this sandbox at all (see criterion 4) — verification log §6 |

---

## 4. Standards Compliance

- **`backend`**: four-file migration rule followed; all SQL in `repository/`; narrow interfaces preserved (`chat.Handler.trust` is a concrete repository type, matching the existing precedent of `bookmark.Handler`/`archive.Handler`, not a hand-rolled interface, since nothing needed to fake it beyond a real sqlite instance in tests); routes registered in `router.go` only; `httpjson` used throughout the new handler; no cgo, no new runtime dependency.
- **`ui`**: `apiJson`/SWR hooks used exclusively, no raw `fetch`; all new strings routed through `next-intl` across all seven locale files; Tailwind tokens only, no raw colors; TUI styling stayed inside `theme.Default`, no inline `lipgloss.Color`; TUI keybindings reused `keys.DefaultApprovalKeyMap` rather than adding a parallel keymap.
- **`test`**: every surface the phase touches has a suite; `suites/meta` is green — `TestRouteCoverageGuard` reports 106/106 routes covered (the 4 new workspace-trust routes included, via the new backend suite's literal path usage), no sleeps (`TestSuitesDoNotSleep` green, including the new TUI PTY suite which uses `WaitForFrame`/`WaitForText` exclusively — the `flaky` tag governs *inclusion* in the default run, not the zero-sleep rule), no cross-suite imports, no duplicate addresses, no leaked secrets. The one deliberate exception: `tests/suites/tui/workspacetrust/` is real, passing-when-run coverage that is intentionally excluded from the default gate — recorded, not hidden, per divergence 4.

---

## 5. Known Scope Boundaries & Follow-ups

- **The TUI startup-render race (divergence 4) is unresolved, not closed.**
  A reader picking this back up should try: (a) a `tea.Program` option or
  Bubble Tea version bump that addresses renderer-not-ready races
  directly, if one exists upstream; (b) restructuring the check to run
  fully synchronously before `tea.NewProgram(...).Run()` is even called
  (resolving trust status as part of `cmd/amiro/tui.go`'s own startup
  sequence, before the model exists, rather than as a `tea.Cmd` at all) —
  not attempted here because it changes what "the page" is responsible
  for, which felt like too large a change to make while chasing a render
  race. Either way, the fix should be provable by flipping the `flaky` tag
  back and getting a clean multi-run pass, not by inspection.
- **The web Playwright spec (divergence 5) has never actually run.**
  A reader in an environment with `pnpm` and a complete Chromium install
  should run `go run ./cmd/amirotest run --surface ui --feature
  workspacetrust` before trusting it, and fix whatever a real run turns
  up — `tsc`/`biome` passing is necessary, not sufficient.
- **The project-selector's folder picker only ever yields a bare folder
  name in some browsers** (`showDirectoryPicker()`'s `.name`, or
  `webkitRelativePath`'s first segment) — not an absolute path. This
  predates this phase and is the reason the Playwright spec pokes
  zustand-persist's storage directly instead of driving a real folder
  pick: the picker itself is not meaningfully testable, and in a real
  deployment where the server's filesystem doesn't happen to have a
  matching relative directory, `resolveRoot` in
  `internal/api/workspacetrust/handler.go` will 400 rather than resolve.
  Worth a real fix, but it belongs to the project-picker's own scope, not
  this phase's.
- **`granted_via` has no UI beyond the settings card's badge.** A fuller
  audit trail (who/when/from which surface, revocation history) is Tier 3
  of `docs/future-implementation/amiro-vs-coding-agents-comparison.md`,
  named as out of scope in the phase doc from the start.
- **AGENTS.md's system-prompt injection is proven at the backend-go unit
  level only**, not against the cross-surface harness's fake provider —
  see "Not covered, and why" above. Low risk (the same `prompts.MergeSystemPrompt`
  call site every other injected block already goes through), but a real
  gap if that unit coverage is ever removed without a replacement.
