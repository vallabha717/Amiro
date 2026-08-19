# Phase 7: Cross-Surface, Resilience, and Performance Progress Report

## 1. What shipped

Phase 7 delivers four new suites — `suites/cross/` (11 journeys across 11
feature directories), `suites/backend/resilience/` (9 fault classes, 31
tests), `suites/backend/perf/` (8 budgets with a persisted trend), and
`suites/backend/security/` (8 checks, 2 through a real dashboard-auth code
path) — plus the two harness gaps the plan explicitly warned would be hit:
`run.retries` and `run.costCeilingUsd` were validated since Phase 1 but
never enforced; both are now real. Fixing Phase 5's `streaming.spec.ts`
gap, which Phase 7's entire cross-surface premise depends on, was done
first, as instructed.

This phase found and fixed one genuine, previously-undiscovered data race
in shared harness code (`harness/logging/redact.go`), affecting every
suite that starts backends in parallel — the default execution mode. It
also found and recorded five real defects in the application (not fixed;
out of this module's scope): `cmd/server` installs no auth rate limiter,
a typed-nil `*web.Handler` panics an untagged build on any non-API route,
`/api/ai/providers` leaks a runtime provider key to any authenticated
non-admin user, a public thread export republishes tool-call raw
input/output verbatim, and `page.Chat`'s `/export` confirmation is never
rendered (a message-not-refreshed bug in `backend-go/internal/tui/page/chat.go`).

**Files:**

| File | LOC | What it is |
|---|---|---|
| `tests/cmd/amirotest/fakeprovider_cmd.go` | 39 | Detached fake-provider process — the streaming.spec.ts prerequisite fix |
| `tests/cmd/amirotest/backend_cmd.go` | +60/-8 | `--fake` wiring: spawns/seeds/tears down the detached fake provider |
| `tests/cmd/amirotest/main.go` | +2 | `internal-fakeprovider` dispatch |
| `src/components/message-parts.tsx` | +2 | `data-role="user"/"assistant"` — the actual selector bug |
| `tests/ui/pages/index.ts` | +6 | `assistantMessageBubbles()` |
| `tests/ui/specs/chat/streaming.spec.ts` | ~+8/-4 | Asserts assistant content, not "a bubble appeared" |
| `tests/fixtures/workspaces/large/` | 600 files, 2 committed docs | Deterministic repomap perf fixture — 25 packages, 4,800 symbols |
| `tests/harness/run/cost.go` | 55 | `RecordCost`/`TotalCost` — `run.costCeilingUsd`'s enforcement plumbing |
| `tests/harness/run/summary.go` | +50 | `Retried`/`TotalCostUSD`, last-attempt-per-address totals |
| `tests/harness/run/run.go` | +8 | `EnvAttempt` |
| `tests/harness/harness.go` | +25 | `attempt` field/env, per-attempt `TestID`, `RecordCost` call |
| `tests/cmd/amirotest/run.go` | +110 | `retryFailures`, `stillFailing`, `stripRunFlag`, `checkCostCeiling` |
| `tests/harness/config/defaults.go` | 1 line | `cross` added to the default `run.surfaces` |
| `tests/harness/logging/redact.go` | +12 | `sync.RWMutex` — the data race fix |
| `tests/suites/cross/attachembed/` | 92 | Attach-or-embed, second process never starts a second backend |
| `tests/suites/cross/connectscope/` | 163 | `--connect` session scoping, 3 tests |
| `tests/suites/cross/threadvisibility/` | 142 | TUI → dashboard, no restart |
| `tests/suites/cross/agentmention/` | 122 | Dashboard → TUI, `@`-completion |
| `tests/suites/cross/sharedconfig/` | 173 | `defaultModel`, TUI half proven, sidecar half NOT MET |
| `tests/suites/cross/providerkeys/` | 195 | Dashboard-added key, immediately usable by a running TUI |
| `tests/suites/cross/concurrent/` | 290 | Convergence under concurrent writes |
| `tests/suites/cross/approvals/` | 445 | Cross-client approval, both directions + ownership boundary |
| `tests/suites/cross/mcpsharing/` | 265 | MCP config shared, visible + `@`-completable |
| `tests/suites/cross/export/` | 224 | TUI export readable signed-out |
| `tests/suites/cross/servetui/` | 272 | `amiro --serve --port N` shares one backend with the TUI |
| `tests/suites/backend/resilience/*.go` (12 files) | 2,997 | 9 fault classes, 29 pass / 2 recorded NOT MET+PARTIAL |
| `tests/harness/fakeprovider/rule.go` | +77 | `ResetMidStream` — the one new fake-provider capability this phase needed |
| `tests/suites/backend/perf/*.go` (4 files) | 1,074 | 8 budgets, all `slow`-tagged, trend-recorded |
| `tests/suites/backend/security/*.go` (10 files) | 1,999 | 8 checks, incl. 2 through real dashboard-auth |
| `tests/suites/cross/README.md`, `tests/suites/backend/{resilience,perf,security}` doc comments | — | What each suite owns |
| `docs/testing/progress/verification-log-phase-07.md` | — | One section per criterion, real output |
| `docs/testing/progress/phase-07-cross-surface.md` | — | This file |

**By the numbers:** ~8,450 LOC of new Go across 4 suites and 24 feature
directories, plus ~260 LOC of surgical changes to 8 existing harness/CLI
files and one product file (`message-parts.tsx`, additive markup only).
280 unique test addresses across 68 features system-wide (up from 237 at
the start of this phase); the full default run (now including `cross`)
passed at 243 passed, 0 failed — see the verification log's Criterion 7
section for the exact number and command.

## 2. What diverged from the plan, and why

**Divergence 1 — the streaming.spec.ts fix required a real architecture
decision, not a one-line selector change.** The plan's own diagnosis (no
provider configured for UI-surface backends, plus a selector matching any
bubble) was correct, but closing it needed a fake-provider process that
survives past `amirotest backend start`'s own exit — that CLI command
prints its JSON and calls `os.Exit` almost immediately, while the backend
it spawned (a separate, detached OS process) keeps running for the rest
of a UI test. An in-process `httptest.Server`-based `cassette.Proxy` (what
`harness.Fake()` uses for Go suites) would die the instant `backend start`
returned. The fix is a second detached process (`internal-fakeprovider`,
spawned via `os.Executable()` self-exec), registered in `backends.json`
for the same crash-resilient cleanup the backend itself gets. `data-role`
on the two message-bubble components was the other missing half — neither
carried any attribute distinguishing them, so "a bubble appeared" was
satisfied by the user's own echoed message alone. Both fixes verified live
against the actual Next.js build (`scripts/build-ui.sh` re-run, not
assumed) — all 3 chat specs and the full 25-spec UI suite pass.

**Divergence 2 — `fixtures/workspaces/large` needed a real design decision:
deterministic and committed, not generated at test time.** Chosen for
reproducibility and CI speed: 600 Go files, 25 packages, 8 cross-package
"calls" per file so `repomap.Build`'s pagerank/refs step has real edges to
walk. Package directories are named `_pkg000`–`_pkg024` — the leading
underscore is load-bearing, not decoration: without it, `go build ./...`
in the `tests` module tries to compile these files as real packages and
fails on the deliberately-unresolved cross-package calls. `repomap.Build`'s
own walker does not apply that convention (only `.`-prefixed dirs are
skipped), so it still sees and parses every file. Verified directly: a
throwaway `Build` call against the fixture (74ms, 600 files, 4,800
symbols) before any suite code was written against it.

**Divergence 3 — `run.retries`, once actually enforced, needed a real
answer to "what happens to the retried attempt's artifacts," which the
plan implied but did not spell out.** `config.example.yaml`'s own existing
doc for `run.retries` already promised "every attempt is kept as
attempt-1/, attempt-2/, ..." — a promise nothing honoured, because nothing
retried at all. A naive retry would have the second attempt overwrite the
first's server logs/PTY casts/`http.ndjson` in place (same `TestID`,
same directory), destroying the exact evidence a retry investigation
needs. Fixed by suffixing `TestID` with `-attemptN` for any attempt past
the first, so each attempt gets its own artifact directory; verified by
inspecting `results.ndjson`'s `id` field directly, not just the pass/fail
outcome. Retries are logged as their own section in `summary.md`
(`## Retried`) unconditionally, per the plan's own risk section quoted in
the harness code: *"a test needing a retry gets investigated, not
retried."* Totals count only the final attempt's verdict — a retried pass
is one pass, never one pass plus one recorded failure — but the retry
itself can never disappear from the report.

**Divergence 4 — `run.costCeilingUsd` enforcement was built, but nothing
in this environment can prove it against real spend.** No live provider
keys exist here, and `cassette.CostTracker` only accumulates non-zero
spend in `live`/`record` mode — so the enforcement path (`RecordCost` →
`TotalCost` → `checkCostCeiling`, checked by the orchestrator after every
surface) was verified with synthetic cost entries written directly to
`costs.ndjson`, proven non-vacuous by breaking `checkCostCeiling`'s
comparison and watching the test fail, then reverting. This is the same
category of gap Phase 6 recorded for the Tauri stdin-piping assumption:
plausible and exercised at every level except the one that needs
hardware/credentials this environment does not have.

**Divergence 5 — `cross` was not in the default surface list at all.**
`harness/config/defaults.go`'s `Run.Surfaces` predates this phase (it was
`{meta, backend, tui, ui, desktop}`) and was never updated when `cross`
became a real, non-empty surface. Left alone, a bare `amirotest run` (no
flags) would silently never run any cross-surface test — exactly the
"surface selected, contributed nothing, read as green" failure mode
`selector.Resolve`'s own doc comment warns against, except worse: `cross`
wouldn't even be *selected*. Fixed as a one-line default change plus a
`config.example.yaml` regeneration (guarded by
`suites/meta/config_drift_test.go`, which still passes). This is why
Criterion 7's number in the verification log is the true default run,
`cross` included, not the 5-surface number this phase's early testing
produced before the gap was noticed.

**Divergence 6 — a genuine, previously-undiscovered data race in shared
harness code, found while independently verifying the other three
suites' work, fixed rather than routed around.** `suites/meta`'s own
`TestBackends_StartedConcurrentlyDoNotCollide` (Phase 1's own concurrency
guard) failed under `-race` when run as part of the full `suites/meta`
package: two backends started in parallel both call
`Logger.Redactor().Add()` (registering their own generated auth token) on
the *same* shared `Redactor` instance, racing on its `secrets []string`
slice against every concurrent `String()`/`Bytes()`/`JSON()` read from
ordinary log writes. This is not new to Phase 7 — `redact.go` predates it
entirely — but it is exactly the kind of latent bug this phase's emphasis
on `-race` and concurrent execution surfaces. Fixed with a `sync.RWMutex`
guarding `secrets` only (`fields` is write-once at construction and needs
none); proven non-vacuous by removing the lock and watching the race
reappear reliably (5/5 runs), then reverting and confirming 5/5 clean.

**Divergence 7 — a real, reproducible flake, traced to a shared harness
gap, and BROADER than first recorded here — corrected after peer review.**
Isolated re-runs of `suites/cross/servetui` alone (no contention from
other suites) failed roughly 1 run in 5–7, always at the same assertion:
`WaitForText` timing out on the fake provider's scripted reply even
though the backend answered. The cross-surface agent's own report had
already surfaced a plausible, independently-observed root cause —
`harness/pty`'s terminal emulator does not always replace a repaint
cleanly (frames can accumulate, long rows hard-wrap mid-token) — which
this flake is consistent with. This was first recorded as a `servetui`-
specific gap. **Peer review, running the true full default run (higher
contention than this module's isolated re-runs), observed the same
underlying gap trigger a retry in a second, unrelated test on a second
surface: `tui/rendering/TestRendering_RawANSIInModelOutputDoesNotBreakFrame`**
(attempt 1 failed, attempt 2 passed) — proving the pty-buffer gap is not
`servetui`-specific, and is contention-sensitive enough that isolated
re-runs here (5 attempts, no reproduction) understated it. **This has a
sharper consequence than "a known flake": with `run.retries: 1` as the
shipped default (`harness/config/defaults.go`, predates this phase),
every occurrence of this gap is currently being silently absorbed by a
retry in any run that doesn't inspect `summary.md`'s `## Retried` section
specifically** — exactly the outcome the phase doc's own risk section
warns against ("a test needing a retry gets investigated, not retried").
Recorded rather than fixed: repairing `harness/pty/buffer.go`'s CSI/erase
handling is real, separate surgery across a shared package every TUI,
desktop, and cross-surface test depends on, not a Phase 7-scoped change.
See Follow-ups for both the buffer fix and the `run.retries` default
question this raises for Phase 8.

**Divergence 8 — three of the nine cross-surface journeys are proven
only in the direction this environment can actually exercise, and say
so.** `sharedconfig`'s "the desktop sidecar honours it" half is not
merely untested — reading `cmd/server`'s own `main()` shows it never
reads `.amiro/config.yaml` at all (only `cmd/amiro`'s `internal/tui/config`
does, despite that package's doc comment claiming both read it).
Asserting either direction would either pin a bug as intended behaviour
or fail on a real gap this module isn't positioned to close — a product
decision, recorded as a Follow-up. `concurrent`'s "neither client shows
stale state" is proven at the API level (both converge, no write is
lost) because there is no push channel in the backend to make a
*rendered* staleness claim testable from Go at all. `export`'s TUI-side
on-screen confirmation is a real, separately-diagnosed rendering bug
(see "What shipped" above), documented rather than asserted against,
since forcing a workaround repaint did not resolve it and the suite's
author judged the diagnosis incomplete.

## 3. How it was verified

Every criterion has its own section in the verification log, with real
commands and real output — not summarized here. In short: every new test
file builds and vets clean (`go build ./...`, `go vet ./...`, `gofmt -l`
clean); every new suite passes standalone under `-race`
(`go test ./suites/cross/... -race`, `./suites/backend/resilience/...`,
`./suites/backend/perf/...` with `slow` tags included,
`./suites/backend/security/...`); `suites/meta`'s guards
(no-application-import, no-cross-suite-import, no-sleep,
unique-addresses, route-coverage, no-secret-leak, config-drift) all pass
against the final tree; the true full default run (`go run
./cmd/amirotest run`, no flags, `cross` now included) was executed twice
in the course of this verification, both times exit 0.

At least one non-vacuous proof (break the real behaviour or assertion,
observe a real failure with a real diagnostic, revert, confirm the revert
is byte-for-byte via `diff`) exists for: the attach-or-embed lock-file
invariant, all three `--connect` scoping tests (via the positive control),
the cost-ceiling check, the retried-totals accounting, the shared
`Redactor` data race, and — from the three suites verified rather than
authored directly — the repomap budget's own threshold logic, the CORS
`--allow-origin` flag, ownership-under-an-active-agent-loop, kill-mid-turn
intactness, the 20-way concurrency stress case, and a database-fault
case. Every revert was confirmed identical via `diff` before moving on.

## 4. Exit criteria — checked off against the phase doc's own list

1. **"`amirotest run --surface cross` passes, and every cross-surface
   journey above has a test."** MET. All 11 journeys have a test; the
   command passes (18 tests, 0 failed — see verification log).
2. **"Attach-or-embed is proven in both directions, and `--connect`
   session scoping is asserted."** MET. `attachembed` proves both
   directions (fresh embed, second-process attach, lock-file identity
   unchanged); `connectscope` proves a foreign session is refused, a
   shared-key session is refused, and a correctly-scoped session works.
3. **"Every resilience class produces a clean error and a recoverable
   state; no test hangs."** MET for 7 of 9 classes in full, MET for the
   backend-visible half of "backend crash," PARTIAL for Auth (session
   *deletion* proven, TTL *expiry* not — no config hook exists), NOT MET
   for 2 of 4 Database rows (full-disk, postgres — no privileged
   filesystem or postgres instance in this environment). Every gap is
   recorded with its precise reason and closing step, not silently
   skipped. "No test hangs" proven directly: a deliberately-shortened
   timeout produces a real diagnostic dump, not a bare deadline error.
4. **"Killing the backend mid-turn leaves a thread that is intact and
   resumable after restart."** MET, for the backend-owned half. SIGKILL
   (not a graceful stop) lands provably mid-turn; the thread's pre-crash
   messages compare byte-for-byte after restart; a further turn on the
   same thread succeeds. "The TUI reports it cleanly" and "the browser
   shows a disconnected state" are `suites/tui`/`suites/ui` rendering
   claims, explicitly out of this suite's scope.
5. **"Performance budgets are calibrated, recorded, and asserted in the
   nightly job."** MET for 7 of 8 budgets as literally specified; the
   dashboard-FCP budget is asserted against a real, defensible proxy
   (HTML time-to-first-byte) with the gap to real FCP stated plainly, not
   claimed as measured. All 8 are calibrated against this machine,
   recorded to a persisted trend file, and compared against up to the
   last 10 runs — regressions warn, they do not fail, per the plan's own
   "coarse, generous" framing.
6. **"Security checks pass, including through the dashboard."** MET.
   8/8 checks pass; 2 (workspace escape, ownership) are specifically
   re-asserted through the real browser-auth code path
   (`middleware.RequireTokenOrBrowser`), verified as a genuinely distinct
   admission path, not merely re-run through the same one under a new
   name.
7. **"The full default run (all surfaces, excluding `slow` and `live`)
   is under 10 minutes."** MET — see the verification log for the exact
   number, which is the true default run with `cross` included (a gap
   this phase found and fixed; see Divergence 5), not a subset.

## 5. Follow-ups surfaced

- **`harness/pty/buffer.go`'s terminal emulator has a real rendering-
  fidelity gap** (repaints can accumulate rather than replace; long rows
  hard-wrap mid-token). Diagnosed, not fixed — it is shared by every TUI,
  desktop, and cross-surface test. Confirmed (Divergence 7) to flake at
  least two tests across two surfaces: `suites/cross/servetui`
  (~1-in-5–7 in isolated re-runs here) and, per peer review's full-run
  observation, `suites/tui/rendering/TestRendering_RawANSIInModelOutputDoesNotBreakFrame`
  (contention-sensitive enough that this module's own isolated re-runs of
  that second test, 5 attempts, did not reproduce it — the full default
  run's higher contention did). Treat "at least these two" as a floor,
  not a ceiling, until the buffer itself is fixed.
- **`run.retries: 1` (the shipped default, predating this phase) is now
  actively masking the pty-buffer gap above, not just tolerating it.**
  Before Phase 7, retries were validated but inert, so this default cost
  nothing. Now that retries are real, every occurrence of the buffer gap
  silently passes on its second attempt in an ordinary `amirotest run` —
  visible only to someone who opens `summary.md`'s `## Retried` section
  specifically, not to someone reading the top-line pass count. This is
  precisely the outcome `harness/config/validate.go`'s own warning
  describes ("retries will hide a race rather than reveal it; CI should
  use 0") and precisely what the phase doc's risk section says a retry
  should never be allowed to do. **Phase 8 must set `run.retries: 0` in
  its CI config explicitly** — leaving the default at 1 for local/dev
  convenience is a defensible choice, but only if CI does not inherit it
  silently. This dependency did not exist before Phase 7 made retries
  real, and belongs in Phase 8's own entry checklist, not rediscovered
  there.
- **`sharedconfig`'s sidecar half needs a product decision**: should
  `cmd/server` read `.amiro/config.yaml`'s `defaultModel`, matching
  `internal/tui/config`'s own doc comment, or should that doc comment
  (and this phase's table row) be corrected instead? Either way, a test
  becomes writable once decided.
- **A postgres fixture does not exist** — needed to close the Database
  class's "postgres connection dropped mid-transaction" row.
  `harness/backend/db.go` already provisions a schema per test on the
  postgres driver; what's missing is a container the run brings up and a
  DSN it configures.
- **`auth.SessionTTL` (30 days, `backend-go/internal/auth/token.go`) has
  no config hook**, so no test can age a session past expiry without
  writing the sessions table directly (which would break the
  no-application-module rule). A configurable TTL closes the Auth
  class's remaining PARTIAL row.
- **Five application-level findings, recorded but not fixed** (out of
  this module's scope, routed here for whoever owns `backend-go`):
  `cmd/server` installs no auth rate limiter (an unthrottled
  `POST /api/auth/login` when bound beyond loopback); a typed-nil
  `*web.Handler` panics an untagged (non-`embedui`) build on any
  non-API/non-health route; `/api/ai/providers` is session-gated but
  neither role- nor user-scoped, so any authenticated non-admin can read
  another user's provider key in plaintext (`internal/api/ai/providers.go`
  assigns `APIKey: c.APIKey` raw into the response DTO, gated only by
  `session(...)`, not an admin check — peer review verified this
  independently and is escalating it to the user as fix-now, not a
  routine follow-up, since a credential leak is not the same class of
  gap as the other four); a public thread export republishes
  `exporterId`, `originalThreadId`, and every tool call's raw input and
  output verbatim; `page.Chat`'s `/export` command never calls
  `refreshTranscript()`, so its confirmation notice is never rendered.
- **Correction to a prior phase's claim, found while investigating the
  typed-nil finding above.** `docs/testing/progress/verification-log-phase-05.md`
  states `web.New()` "compiles and runs identically with and without
  `-tags embedui`" on the strength of `TestSidecar_*` (health, port
  binding, SIGTERM) passing on both builds. Those tests never hit a
  non-API route — the one path `router.go`'s `opts.UI != nil` check
  actually mounts a nil `*web.Handler` onto, since `Options.UI` is an
  `http.Handler` *interface* and a typed-nil pointer satisfies a
  non-nil-interface check. Phase 5's claim was true of everything it
  tested and false of the one thing it didn't — the same
  adjacent-green-substitution shape this project's own standards warn
  against elsewhere, now found in a passed verification log rather than
  in new code. `src-tauri/build-sidecar.sh` builds `cmd/server` with no
  `-tags embedui`, so the shipped desktop sidecar is the affected build.
- **A real dashboard FCP budget needs a Playwright-side companion** —
  this phase's own budget measures HTML time-to-first-byte, a defensible
  lower bound but not the metric the plan names.
- **`concurrent`'s staleness claim needs a Playwright companion too**,
  for the same reason: no push channel exists to make a *rendered*
  staleness check meaningful from a Go-only test.
- **The perf trend file (`tests/logs/perf-trend.ndjson`) is gitignored
  and lives only on the machine that ran it.** A nightly CI job needs to
  cache/restore this one file between runs, or every runner starts with
  no history and the trend comparison degrades to threshold-only (never
  to a false pass — just a quieter regression signal) on its first run.
