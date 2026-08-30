# Verification Log — Phase 04 (Background agent runs)

**Date:** 2026-08-29
**Machine notes:** Same sandboxed dev container as Phases 0–3
(`personal-dev-workstation`, Linux 6.12.94, x86_64). A real bubblewrap
sandbox backend is available (confirmed live by every command below that
reports `sandbox_backend`), so this phase's own sandbox-honesty criterion
runs its positive branch and skips with an explicit pointer to the
deterministic proof, the same pattern Phase 2 already established. `pnpm`
is still absent (`amirotest run --surface ui` cannot launch); no Tauri
runtime exists in this sandbox (`--surface desktop` was not attempted, no
build target exists for it here). No live GitHub or network calls were
made anywhere in this phase's tests.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1 — `amirotest run --surface backend --feature backgroundjob`

```
$ go test ./suites/backend/backgroundjob/... -v
=== RUN   TestBackgroundJob_RefusesAgainstUntrustedRoot
--- PASS: TestBackgroundJob_RefusesAgainstUntrustedRoot (3.47s)
=== RUN   TestBackgroundJob_RefusesPlanAndInteractiveModes
--- PASS: TestBackgroundJob_RefusesPlanAndInteractiveModes (0.39s)
=== RUN   TestBackgroundJob_ContinuesAfterClientDisconnects
--- PASS: TestBackgroundJob_ContinuesAfterClientDisconnects (0.56s)
=== RUN   TestBackgroundJob_ConcurrencyCapRefusesNamingRunningJobs
--- PASS: TestBackgroundJob_ConcurrencyCapRefusesNamingRunningJobs (5.51s)
=== RUN   TestBackgroundJob_RefusesUnsandboxedShellRatherThanFallingBack
    backgroundjob_test.go:240: a real sandbox backend is available in this environment -- this criterion's environment-independent proof lives in internal/ai/tools's TestTerminalExecutor_RequireSandboxRefusesRatherThanFallingBack, which forces the none backend directly rather than depending on absence (run_shell output: {Output:should-not-run-unsandboxed Error: Sandboxed:true})
--- SKIP: TestBackgroundJob_RefusesUnsandboxedShellRatherThanFallingBack (0.57s)
=== RUN   TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes
--- PASS: TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes (5.56s)
PASS
ok  	amiro/tests/suites/backend/backgroundjob	16.072s
```

✅ 5 passed, 1 reasoned skip, 0 failed. **MET.**

---

## Criterion 2 — `TestBackgroundJob_ContinuesAfterClientDisconnects`

Already shown above (criterion 1's run) — the same test, PASS, real dropped
connection (the creating client's `context.WithCancel` is canceled
immediately after the response returns; a second, independent client polls
the job to `done`). ✅ **MET.**

---

## Criterion 3 — `TestBackgroundJob_RefusesAgainstUntrustedRoot` and `TestBackgroundJob_RefusesUnsandboxedShellRatherThanFallingBack`

Both shown above. The first is a plain PASS. The second SKIPs with a named
reason and points at the deterministic proof:

```
$ go test ./internal/ai/tools/... -run TerminalExecutor -v
=== RUN   TestTerminalExecutor_ReportsSandboxStatus
--- PASS: TestTerminalExecutor_ReportsSandboxStatus (0.02s)
=== RUN   TestTerminalExecutor_RunInBackgroundStillWorks
--- PASS: TestTerminalExecutor_RunInBackgroundStillWorks (0.00s)
=== RUN   TestTerminalExecutor_RequireSandboxRefusesRatherThanFallingBack
--- PASS: TestTerminalExecutor_RequireSandboxRefusesRatherThanFallingBack (0.01s)
=== RUN   TestTerminalExecutor_RequireSandboxAlsoGatesTheBackgroundPath
    terminal_sandbox_test.go:90: this machine has a real sandbox backend -- nothing to refuse
--- SKIP: TestTerminalExecutor_RequireSandboxAlsoGatesTheBackgroundPath (0.00s)
PASS
ok  	amiro/backend/internal/ai/tools	0.043s
```

⚠️ First name **MET literally**. Second name **MET conditionally** — same
honest, environment-dependent split Phase 2's own
`TestSandbox_FallsThroughToUnsandboxedAndSaysSo` already established, for
the identical reason: this black-box test module cannot force "no sandbox
backend" from outside the process.

---

## Criterion 4 — `TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes`

This test failed on first attempt and caught a real production bug
(progress record §2, divergence 6) before passing:

```
$ go test ./suites/backend/backgroundjob/... -run TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes -v
=== RUN   TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes
    backgroundjob_test.go:318: timed out after 20s waiting for the job to be resumed and reach the provider again after restart
        last attempt: status = "failed" (error: "request cancelled while waiting for stream response: context canceled"), want running (resumed)
--- FAIL: TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes (25.86s)
FAIL
```

Root cause and fix in `backend-go/internal/api/chat/runner.go`/
`backgroundjob_sync.go`: `ctxCanceled` is now read directly off `ctx.Err()`
rather than inferred from `loopErr` via `errors.Is`. After the fix:

```
$ go test ./suites/backend/backgroundjob/... -run TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes -v
=== RUN   TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes
--- PASS: TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes (5.56s)
PASS
ok  	amiro/tests/suites/backend/backgroundjob	5.563s
```

The regression test added for this fix, in the `chat` package's own unit
suite:

```
$ go test ./internal/api/chat/... -run 'CtxCanceled|BackgroundJob' -v
=== RUN   TestSyncBackgroundJob_CtxCanceledIsInterruptedEvenWhenTheEngineErrorDoesNotUnwrap
--- PASS: TestSyncBackgroundJob_CtxCanceledIsInterruptedEvenWhenTheEngineErrorDoesNotUnwrap (0.16s)
=== RUN   TestSyncBackgroundJob_NoOpWhenThreadHasNoJob
--- PASS: TestSyncBackgroundJob_NoOpWhenThreadHasNoJob (0.14s)
=== RUN   TestSyncBackgroundJob_AutoPRFollowUpCreatesJobBranchAndSuspendsAtPush
--- PASS: TestSyncBackgroundJob_AutoPRFollowUpCreatesJobBranchAndSuspendsAtPush (0.17s)
=== RUN   TestSyncBackgroundJob_AutoPRNeverStartsTwice
--- PASS: TestSyncBackgroundJob_AutoPRNeverStartsTwice (0.16s)
PASS
ok  	amiro/backend/internal/api/chat	0.654s
```

✅ **MET**, including the trust-grant-still-valid check on resume (proven
separately at the unit level below).

```
$ go test ./internal/agent/background/... -v
=== RUN   TestWorker_StartRunsTurnAndMarksJobDone
--- PASS: TestWorker_StartRunsTurnAndMarksJobDone (0.16s)
=== RUN   TestWorker_StartMarksJobSuspendedOnAlwaysAskGate
--- PASS: TestWorker_StartMarksJobSuspendedOnAlwaysAskGate (0.16s)
=== RUN   TestWorker_ShutdownCancelsRunningJobAndMarksInterrupted
--- PASS: TestWorker_ShutdownCancelsRunningJobAndMarksInterrupted (0.16s)
=== RUN   TestWorker_ResumeInterrupted_OnlyResumesJobsWithValidTrustAndRoot
--- PASS: TestWorker_ResumeInterrupted_OnlyResumesJobsWithValidTrustAndRoot (0.21s)
PASS
ok  	amiro/backend/internal/agent/background	0.713s
```

---

## Criterion 5 — `amirotest run --surface cross --feature backgroundjob`

```
$ go test ./suites/cross/backgroundjob/... -v
=== RUN   TestCrossSurface_JobStartedFromTheTerminalIsVisibleFromTheWebAPI
--- PASS: TestCrossSurface_JobStartedFromTheTerminalIsVisibleFromTheWebAPI (6.92s)
PASS
ok  	amiro/tests/suites/cross/backgroundjob	6.921s
```

This test runs a real `amiro run "cross-surface background job check"
--background --json --connect <url> --token <token>` subprocess against
the harness's backend, decodes its `--json` output, then fetches the same
job id through a second, independent client standing in for the web
panel, asserting `ID`/`ThreadID`/`Prompt` all match exactly. ✅ **MET.**

---

## Criterion 6 — `amirotest run --surface desktop --feature backgroundjob`

Not run — no Tauri build or runtime exists in this sandbox to run it
against (the identical constraint Phase 2's progress record names for its
own never-attempted macOS `sandbox-exec` verification). ❌ **NOT MET**, for
lack of an environment to run it in, not for lack of the underlying
mechanism — see criterion 4, which proves the same graceful-shutdown path
against the real server binary the desktop sidecar also is.

---

## Criterion 7 — `amirotest run` overall, `suites/meta` included

```
$ go run ./cmd/amirotest run --surface backend,meta,cross
run 2026-08-29T17-59-16Z-58f00d
  providers: replay · parallel: 4

── meta ──
ok  	amiro/tests/suites/meta	1.196s
── backend ──
ok  	amiro/tests/suites/backend/admin	2.746s
ok  	amiro/tests/suites/backend/archive	1.673s
ok  	amiro/tests/suites/backend/auth	2.797s
ok  	amiro/tests/suites/backend/backgroundjob	21.064s
ok  	amiro/tests/suites/backend/bookmark	2.307s
ok  	amiro/tests/suites/backend/chat	103.589s
ok  	amiro/tests/suites/backend/checkpoint	5.533s
ok  	amiro/tests/suites/backend/config	0.258s
ok  	amiro/tests/suites/backend/export	1.921s
ok  	amiro/tests/suites/backend/gitremote	7.189s
ok  	amiro/tests/suites/backend/lifecycle	0.827s
ok  	amiro/tests/suites/backend/matrix	2.082s
ok  	amiro/tests/suites/backend/mcp	3.402s
ok  	amiro/tests/suites/backend/migration	0.892s
ok  	amiro/tests/suites/backend/models	0.641s
ok  	amiro/tests/suites/backend/perf	0.075s
ok  	amiro/tests/suites/backend/providers	2.793s
ok  	amiro/tests/suites/backend/resilience	95.703s
ok  	amiro/tests/suites/backend/sandbox	8.628s
ok  	amiro/tests/suites/backend/search	2.961s
ok  	amiro/tests/suites/backend/security	25.221s
ok  	amiro/tests/suites/backend/skills	37.401s
ok  	amiro/tests/suites/backend/smoke	1.649s
ok  	amiro/tests/suites/backend/storage	1.937s
ok  	amiro/tests/suites/backend/thread	2.900s
ok  	amiro/tests/suites/backend/user	2.297s
ok  	amiro/tests/suites/backend/workflow	2.124s
ok  	amiro/tests/suites/backend/workspacetrust	2.175s
── cross ──
ok  	amiro/tests/suites/cross/approvals	6.678s
ok  	amiro/tests/suites/cross/attachembed	0.583s
ok  	amiro/tests/suites/cross/backgroundjob	1.168s
ok  	amiro/tests/suites/cross/checkpoint	0.041s
ok  	amiro/tests/suites/cross/concurrent	2.102s
ok  	amiro/tests/suites/cross/connectscope	2.749s
ok  	amiro/tests/suites/cross/export	1.166s
ok  	amiro/tests/suites/cross/mcpsharing	2.406s
ok  	amiro/tests/suites/cross/providerkeys	1.405s
ok  	amiro/tests/suites/cross/servetui	1.186s
ok  	amiro/tests/suites/cross/sharedconfig	1.348s
ok  	amiro/tests/suites/cross/skills	1.609s
ok  	amiro/tests/suites/cross/threadvisibility	1.163s
ok  	amiro/tests/suites/cross/workspacetrust	0.831s

# Amiro test run 2026-08-29T17-59-16Z-58f00d

**PASSED** · 273 passed · 0 failed · 15 skipped · 2m 12s

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    227 |      0 |      14 |   5m 39s |
| cross   |     21 |      0 |       1 |    23.5s |
| meta    |     25 |      0 |       0 |     1.3s |
```

Every skip reasoned (12 pre-existing tag exclusions / PARTIAL-NOT-MET
resilience rows Phase 2 already recorded, this phase's own sandbox-honesty
skip, one pre-existing `flaky`-tagged cross-surface checkpoint test, and
the pre-existing postgres-live-tagged migration test).

```
$ go run ./cmd/amirotest run --surface tui --feature backgroundjob
── tui ──
ok  	amiro/tests/suites/tui/backgroundjob	0.007s

**PASSED** · 0 passed · 0 failed · 1 skipped · 871ms

## Skipped
- `tui/backgroundjob/TestTUI_Runs_OpensListsAndCancels` — tagged "flaky", which run.tags.exclude excludes
```

Confirmed the tag exclusion is enforced by harness config, not liftable via
a `go test` build tag:

```
$ go test ./suites/tui/backgroundjob/... -run TestTUI_Runs_OpensListsAndCancels -v -tags flaky
=== RUN   TestTUI_Runs_OpensListsAndCancels
    backgroundjob_test.go:27: tagged "flaky", which run.tags.exclude excludes
--- SKIP: TestTUI_Runs_OpensListsAndCancels (0.04s)
PASS
```

`ui` was not attempted — confirmed `pnpm` is still absent:

```
$ which pnpm; pnpm --version
/bin/bash: line 1: pnpm: command not found
```

✅ **MET for backend, meta, cross** (273/273, 15 reasoned skips). `tui`'s
one test is written/vetted but skipped by the pre-existing `flaky`
exclusion (not this phase's own bug — see progress record divergence 8).
`ui` cannot launch in this sandbox (divergence 7). `desktop` has no runtime
here (criterion 6).

---

## Full backend-go regression

```
$ cd backend-go && go build ./... && go vet ./... && go test ./... 2>&1 | grep -v "^ok\|no test files"
DONE
```

Zero non-passing lines — every package (including every package this
phase touched: `internal/db/models`, `internal/db/repository`,
`internal/agent/background`, `internal/ai/tools`, `internal/api/chat`,
`internal/api/backgroundjob`, `internal/appwiring`, `internal/httpserver`,
`internal/tui/{client,page,app,component/editor}`, `cmd/amiro`) builds,
vets, and tests clean. The `/runs` slash-palette golden files were
regenerated once (`-update`) to reflect the new line and re-verified
clean afterward.

---

## Full frontend regression

```
$ npx tsc --noEmit
(no output -- clean)

$ npx vitest run
 Test Files  30 passed (30)
      Tests  363 passed (363)

$ npx biome lint src/components/background-jobs/ src/lib/backend/background-jobs-api.ts \
    src/hooks/queries/use-background-jobs.ts 'src/app/(chat)/runs/' \
    src/components/layouts/app-sidebar-menus.tsx tests/ui/pages/index.ts tests/ui/specs/runs/runs.spec.ts
Checked 7 files in 37ms. No fixes applied.
```

No new frontend unit tests were added this phase (the new components are
thin API-glue/rendering code; the behavioral proof lives in the real-HTTP
backend suite and the cross-surface test) — 363/363 is the pre-existing
suite passing unmodified, confirming no regression.
