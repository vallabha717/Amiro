# Verification Log — Phase 00 (Discovery core and the read API)

**Date:** 2026-08-20
**Run ID:** 2026-08-20T10-11-29Z-6bb1e2
**Machine notes:** Linux x86_64, pure Go (no cgo), Node.js / pnpm, SQLite in-memory / file fixtures. Cargo not on PATH (desktop webview specs cleanly skipped as documented).

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: `amirotest run --surface backend --feature skills` passes in under 30s.

```
$ cd tests && go run ./cmd/amirotest run --surface backend --feature skills
run 2026-08-20T07-18-38Z-5fff78
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T07-18-38Z-5fff78
  providers: replay · parallel: 4

── backend ──
ok      amiro/tests/suites/backend/skills       3.870s

# Amiro test run 2026-08-20T07-18-38Z-5fff78

**PASSED** · 13 passed · 0 failed · 0 skipped · 5.0s
Started 2026-08-20T07:18:38Z · selection: --surface backend --feature skills · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |     13 |      0 |       0 |     3.8s |


Artifacts: /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T07-18-38Z-5fff78
```

**Verdict:** ✅ MET — All 13 tests passed in 5.0s (under 30s budget).

---

## Criterion 2: A test asserts that a skill present in **all four** user-scope directories appears exactly once in `GET /api/skills`, with `source: ".agents"` and three entries in `shadows`.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_SourceOrderBreaksSameScopeTie -v
=== RUN   TestSkills_SourceOrderBreaksSameScopeTie
--- PASS: TestSkills_SourceOrderBreaksSameScopeTie (0.81s)
PASS
ok      amiro/tests/suites/backend/skills       0.812s
```

**Verdict:** ✅ MET — `TestSkills_SourceOrderBreaksSameScopeTie` asserts that when a skill is present across `~/.agents`, `~/.amiro`, `~/.claude`, and `~/.codex`, it returns exactly 1 item with `source: ".agents"` and 3 entries in `shadows` (`.amiro`, `.claude`, `.codex`).

---

## Criterion 3: A test asserts a project-scope skill named `code-review` wins over a user-scope skill of the same name, and that the user-scope one is reported as shadowed rather than dropped silently.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_ProjectBeatsUserForSameName -v
=== RUN   TestSkills_ProjectBeatsUserForSameName
--- PASS: TestSkills_ProjectBeatsUserForSameName (0.84s)
PASS
ok      amiro/tests/suites/backend/skills       0.845s
```

**Verdict:** ✅ MET — `TestSkills_ProjectBeatsUserForSameName` asserts project-scope `code-review` wins over user-scope, and the user-scope skill is reported in `winner.Shadows` with the reason string.

---

## Criterion 4: A test asserts a skill whose `SKILL.md` has no `description` is absent from the list **and** present in `diagnostics` with a reason string.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_MissingDescriptionIsSkippedWithReason -v
=== RUN   TestSkills_MissingDescriptionIsSkippedWithReason
--- PASS: TestSkills_MissingDescriptionIsSkippedWithReason (2.17s)
PASS
ok      amiro/tests/suites/backend/skills       2.176s
```

**Verdict:** ✅ MET — `TestSkills_MissingDescriptionIsSkippedWithReason` confirms description-less skills are omitted from `items` and reported in `diagnostics` with error severity and reason.

---

## Criterion 5: `go test ./suites/meta/... -v` passes, including the new sources-table guard, and the guard is proven non-vacuous by a test that fails it on a mutated table.

```
$ cd tests && go test ./suites/meta/... -v
=== RUN   TestNoTestImportsTheApplicationModule
--- PASS: TestNoTestImportsTheApplicationModule (0.57s)
=== RUN   TestSuitesDoNotImportEachOther
--- PASS: TestSuitesDoNotImportEachOther (0.02s)
=== RUN   TestSuitesDoNotSleep
--- PASS: TestSuitesDoNotSleep (0.04s)
=== RUN   TestEveryTestAddressIsUnique
    boundary_test.go:165: 296 unique addresses across 70 features
--- PASS: TestEveryTestAddressIsUnique (0.02s)
=== RUN   TestConfigExample_MatchesTheDefaults
--- PASS: TestConfigExample_MatchesTheDefaults (0.00s)
=== RUN   TestConfigExample_ParsesBackToExactlyTheDefaults
--- PASS: TestConfigExample_ParsesBackToExactlyTheDefaults (0.00s)
=== RUN   TestConfig_MissingFileIsAValidConfiguration
--- PASS: TestConfig_MissingFileIsAValidConfiguration (0.00s)
=== RUN   TestTeardown_LeavesNoProcessAndNoBoundPort
--- PASS: TestTeardown_LeavesNoProcessAndNoBoundPort (0.08s)
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide/first
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/first
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide/second
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/second
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/first
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/second
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.00s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/first (0.11s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/second (0.11s)
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:279: Route coverage: 103 total routes in router.go (103 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.02s)
=== RUN   TestLogs_ContainNoConfiguredSecretInTheClear
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
=== RUN   TestRedactor_ReplacesAPasswordSentThroughTheRealAPI
--- PASS: TestRedactor_ReplacesAPasswordSentThroughTheRealAPI (0.33s)
=== RUN   TestSkillsSourcesGuard
    skills_sources_test.go:198: Verified all 8 scan root sources match between docs/skills/01-discovery-and-precedence.md and internal/skills/sources.go
--- PASS: TestSkillsSourcesGuard (0.00s)
=== RUN   TestSkillsSourcesGuard_IsNonVacuous
--- PASS: TestSkillsSourcesGuard_IsNonVacuous (0.00s)
=== RUN   TestUISpecs_DoNotUseHardcodedWaits
    ui_guard_test.go:93: Verified 20 UI spec files: 0 hardcoded waits found.
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.00s)
=== RUN   TestUISpecs_GuardIsNonVacuous
--- PASS: TestUISpecs_GuardIsNonVacuous (0.00s)
PASS
ok      amiro/tests/suites/meta 1.209s
```

**Verdict:** ✅ MET — All meta tests pass, including `TestSkillsSourcesGuard` and `TestSkillsSourcesGuard_IsNonVacuous` proving that mutation of sources table in doc or code fails the check.

---

## Criterion 6: `cd backend-go && go build ./... && go build -tags embedui ./...` both succeed; `GOOS=windows go build ./...` still succeeds.

```
$ cd backend-go && go build ./... && go build -tags embedui ./... && GOOS=windows go build ./...
(exit code 0, no errors)
```

**Verdict:** ✅ MET — All three build configurations (untagged, embedui tag, Windows cross-compile) compile cleanly without cgo dependencies.

---

## Criterion 7: `amirotest run` is green overall, `suites/meta` included, with every skip reasoned.

```
$ cd tests && go run ./cmd/amirotest run
run 2026-08-20T10-11-29Z-6bb1e2
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T10-11-29Z-6bb1e2
  providers: replay · parallel: 4

── meta ──
ok      amiro/tests/suites/meta 0.711s
── backend ──
ok      amiro/tests/suites/backend/admin        1.976s
ok      amiro/tests/suites/backend/agent        1.340s
ok      amiro/tests/suites/backend/archive      1.322s
ok      amiro/tests/suites/backend/auth 2.065s
ok      amiro/tests/suites/backend/bookmark     1.771s
ok      amiro/tests/suites/backend/chat 84.912s
ok      amiro/tests/suites/backend/config       0.191s
ok      amiro/tests/suites/backend/export       1.905s
ok      amiro/tests/suites/backend/lifecycle    0.656s
ok      amiro/tests/suites/backend/matrix       1.772s
ok      amiro/tests/suites/backend/mcp  1.830s
ok      amiro/tests/suites/backend/migration    0.772s
ok      amiro/tests/suites/backend/models       0.521s
ok      amiro/tests/suites/backend/perf 0.049s
ok      amiro/tests/suites/backend/providers    1.629s
ok      amiro/tests/suites/backend/resilience   86.884s
ok      amiro/tests/suites/backend/search       2.008s
ok      amiro/tests/suites/backend/security     7.533s
ok      amiro/tests/suites/backend/skills       6.983s
ok      amiro/tests/suites/backend/smoke        1.225s
ok      amiro/tests/suites/backend/storage      2.664s
ok      amiro/tests/suites/backend/thread       5.126s
ok      amiro/tests/suites/backend/user 2.890s
ok      amiro/tests/suites/backend/workflow     2.301s
── tui ──
ok      amiro/tests/suites/tui/approval 4.124s
ok      amiro/tests/suites/tui/auth     2.131s
ok      amiro/tests/suites/tui/chat     4.481s
ok      amiro/tests/suites/tui/config   2.693s
ok      amiro/tests/suites/tui/headless 3.685s
ok      amiro/tests/suites/tui/launch   2.820s
ok      amiro/tests/suites/tui/palette  1.053s
ok      amiro/tests/suites/tui/pickers  0.520s
ok      amiro/tests/suites/tui/rendering        2.992s
── ui ──

Running 26 tests using 4 workers

  ✓   1 …etails form (16.0s)
  ✓   2 …reate agent (13.4s)
  ✓   3 …hboard tabs (16.7s)
  ✓   4 …gn-in inputs (7.0s)
  ✓   5 … no threads (14.2s)
  ✓   6 …on on reload (8.1s)
  ✓   7 …ves /sign-up (7.6s)
  ✓   8 … admin views (8.7s)
  ✓   9 …notification (6.0s)
  ✓  10 …l selection (10.0s)
  ✓  11 …d completes (18.9s)
  ✓  12 …een threads (24.8s)
  ✓  13 …r to sign in (8.2s)
  ✓  14 …PA fallback (19.9s)
  ✓  15 …ing the test (7.9s)
  -  16 … the default suite)
  ✓  17 …or not-found (8.6s)
  ✓  18 …rver trigger (8.9s)
  ✓  19 …w end-to-end (8.4s)
  ✓  20 …nsive layout (5.0s)
  ✓  21 …nfiguration (12.4s)
  ✓  22 …ers properly (6.1s)
  ✓  23 …consistently (6.5s)
  ✓  24 …ctly to chat (7.9s)
  ✓  25 …and examples (8.8s)
  ✓  26 …consistently (7.7s)

  1 skipped
  25 passed (1.3m)
── cross ──
ok      amiro/tests/suites/cross/agentmention   0.860s
ok      amiro/tests/suites/cross/approvals      5.144s
ok      amiro/tests/suites/cross/attachembed    0.541s
ok      amiro/tests/suites/cross/concurrent     1.819s
ok      amiro/tests/suites/cross/connectscope   2.403s
ok      amiro/tests/suites/cross/export 0.962s
ok      amiro/tests/suites/cross/mcpsharing     1.722s
ok      amiro/tests/suites/cross/providerkeys   0.831s
ok      amiro/tests/suites/cross/servetui       0.872s
ok      amiro/tests/suites/cross/sharedconfig   0.796s
ok      amiro/tests/suites/cross/threadvisibility       0.686s
── desktop ──
ok      amiro/tests/suites/desktop/data 0.700s
ok      amiro/tests/suites/desktop/discovery    1.024s
ok      amiro/tests/suites/desktop/ipc  0.041s
ok      amiro/tests/suites/desktop/lifecycle    0.192s
ok      amiro/tests/suites/desktop/orphans      0.214s
ok      amiro/tests/suites/desktop/packaging    0.026s
ok      amiro/tests/suites/desktop/ports        0.292s
ok      amiro/tests/suites/desktop/skills       0.412s
ok      amiro/tests/suites/desktop/ui-parity    0.035s
ok      amiro/tests/suites/desktop/webview      0.343s

# Amiro test run 2026-08-20T10-11-29Z-6bb1e2

**PASSED** · 258 passed · 0 failed · 17 skipped · 3m 15s
Started 2026-08-20T10:11:29Z · selection: --surface meta,backend,tui,ui,desktop,cross · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    157 |      0 |      11 |   3m 38s |
| cross   |     18 |      0 |       0 |    16.1s |
| desktop |     12 |      0 |       5 |     2.8s |
| meta    |     15 |      0 |       0 |    809ms |
| tui     |     31 |      0 |       0 |    23.8s |
| ui      |     25 |      0 |       1 |   4m 32s |


## Skipped

- `backend/migration/TestMigration_PostgresSchemaHandlingAndSkip` — tagged "live", which run.tags.exclude excludes
- `backend/perf/TestPerf_BackendColdStartToHealthy` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_DashboardFirstContentfulPaint` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_FirstStreamedTokenAfterSubmit` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_MemoryAfter100Turns` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_RepomapOverLargeWorkspace` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_TUILaunchToFirstFrameAttached` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_TUILaunchToFirstFrameEmbedded` — tagged "slow", which run.tags.exclude excludes
- `backend/perf/TestPerf_ThreadListWith500Threads` — tagged "slow", which run.tags.exclude excludes
- `backend/resilience/TestResilience_AuthExpiryNotCoveredHere` — PARTIAL, the phase document's "a session expiring mid-turn": the mid-turn credential loss is proven by TestResilience_SessionEndedMidTurnLeavesThreadRecoverable, but by DELETING the session row (auth.Service.Logout), not by letting one age out. auth.SessionTTL is a 30-day const in backend-go/internal/auth/token.go with no environment or config hook, so no test can advance a session past it; ValidateSession's ErrSessionExpired branch is therefore unexercised while its ErrSessionNotFound branch is. Closing it needs either a configurable TTL on the application side or a harness-owned way to write a past ExpiresAt, and writing the row directly would break the rule that this module talks to Amiro only over its public surfaces.
- `backend/resilience/TestResilience_DatabaseFaultsNotCoveredHere` — NOT MET, two rows of the phase document's Database class: (1) a full disk on write needs a size-capped filesystem, which needs mount privileges this unprivileged runner does not have -- closing it needs a harness fixture that mounts a small filesystem in a privileged CI step and exports its path; (2) a postgres connection dropped mid-transaction needs a postgres instance, and there is none here -- harness/backend/db.go already provisions one schema per test on the postgres driver, so what is missing is the postgres fixture (a container the run brings up and a DSN it configures), which does not exist yet. The locked-file and corrupt-file rows are proven by the two tests above.
- `desktop/lifecycle/TestLifecycle_FullAppStartsSidecarAndLoadsWebview` — cargo not found on PATH; desktop.enabled=auto skips cleanly (set desktop.enabled: true to make a missing toolchain a hard failure instead)
- `desktop/packaging/TestPackaging_TauriBuildProducesAWorkingInstalledApp` — tagged "slow", which run.tags.exclude excludes
- `desktop/ports/TestPorts_CollisionRecoveryAndTwoInstancePolicy` — cargo not found on PATH; desktop.enabled=auto skips cleanly (set desktop.enabled: true to make a missing toolchain a hard failure instead)
- `desktop/ui-parity/TestUIParity_SmokeSpecsPassAgainstTheDesktopWebview` — cargo not found on PATH; desktop.enabled=auto skips cleanly (set desktop.enabled: true to make a missing toolchain a hard failure instead)
- `desktop/webview/TestWebview_RealTauriWebviewLoadsTheDashboard` — cargo not found on PATH; desktop.enabled=auto skips cleanly (set desktop.enabled: true to make a missing toolchain a hard failure instead)
- `ui/errors/uncaught page error fails the test (expected-fail probe; run in isolation, not part of the default suite)` — deliberately-failing probe for Criterion 7 -- run with AMIRO_RUN_EXPECTED_FAIL_SPECS=1 in isolation, see file comment

Artifacts: /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T10-11-29Z-6bb1e2
```

**Verdict:** ✅ MET — 258 tests passed, 0 failures, 17 reasoned skips.

---

## New test coverage actually runs

```
$ cd tests && go run ./cmd/amirotest list --surface backend
...
  backend/skills  (13 tests)
      backend/skills/TestSkills_BoundsTripAndAreReported
      backend/skills/TestSkills_ColonInDescriptionLoadsViaRetry
      backend/skills/TestSkills_DiscoversSkillInEachOfTheEightRoots
      backend/skills/TestSkills_EmptyMachineReturnsEmptyListWithNoError
      backend/skills/TestSkills_GetSkill_ReturnsSkillAndDetails
      backend/skills/TestSkills_MissingDescriptionIsSkippedWithReason
      backend/skills/TestSkills_NameDirectoryMismatchLoadsWithWarning
      backend/skills/TestSkills_ProjectBeatsUserForSameName
      backend/skills/TestSkills_ProjectParamNonAbsRejected
      backend/skills/TestSkills_SourceOrderBreaksSameScopeTie
      backend/skills/TestSkills_SymlinkedDuplicateAppearsOnce
      backend/skills/TestSkills_UnauthenticatedIs401
      backend/skills/TestSkills_UnparseableYAMLIsSkippedWithReason

$ cd tests && go run ./cmd/amirotest list --surface desktop
...
  desktop/skills  (1 tests)
      desktop/skills/TestDesktop_UntaggedSidecarServesSkillsAndDiscoversHome

$ cd tests && go run ./cmd/amirotest run --surface backend --feature skills
**PASSED** · 13 passed · 0 failed · 0 skipped · 5.0s
```

---

## Guards

```
$ cd tests && go test ./suites/meta/... -v
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:279: Route coverage: 103 total routes in router.go (103 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.02s)
=== RUN   TestSkillsSourcesGuard
    skills_sources_test.go:198: Verified all 8 scan root sources match between docs/skills/01-discovery-and-precedence.md and internal/skills/sources.go
--- PASS: TestSkillsSourcesGuard (0.00s)
=== RUN   TestSkillsSourcesGuard_IsNonVacuous
--- PASS: TestSkillsSourcesGuard_IsNonVacuous (0.00s)
PASS
```

---

## Regression check

```
$ pnpm check
Checked 455 files in 350ms. No fixes applied.
> tsc --noEmit
Test Files  29 passed (29)
     Tests  354 passed (354)

$ cd backend-go && go build ./... && go vet ./... && go test ./...
ok      amiro/backend/internal/skills   0.005s
ok      amiro/backend/internal/api/skills       0.005s
ok      amiro/backend/internal/httpserver       0.217s

$ cd tests && go run ./cmd/amirotest run
**PASSED** · 258 passed · 0 failed · 17 skipped · 3m 15s
```

---

## Notes

- Total passed test count in the cross-surface harness increased by 16 tests (from 242 to 258) across backend (+13), desktop (+1), meta (+1), and cross (+1 with timing fix for PTY stabilization).
- Zero database migrations required for this phase.

---

# Phase 0 Remediation — Verification Log (2026-08-20)

**Run ID:** 2026-08-20T10-40-35Z-e65a4a

## 1. Backend Builds & Cross-Compilation

```
$ cd backend-go && go build ./... && go build -tags embedui ./... && GOOS=windows go build ./...
(exit code 0, no errors)
```

## 2. Unit & Integration Tests (skills, api/skills, httpserver)

```
$ cd backend-go && go test ./internal/skills/... ./internal/api/skills/... ./internal/httpserver/...
ok      amiro/backend/internal/skills   0.010s
ok      amiro/backend/internal/api/skills       0.006s
ok      amiro/backend/internal/httpserver       25.273s
```

## 3. Meta Guards (including waivers and sources guard)

```
$ cd tests && go test ./suites/meta/... -v
=== RUN   TestNoTestImportsTheApplicationModule
--- PASS: TestNoTestImportsTheApplicationModule (0.54s)
=== RUN   TestSuitesDoNotImportEachOther
--- PASS: TestSuitesDoNotImportEachOther (0.02s)
=== RUN   TestSuitesDoNotSleep
--- PASS: TestSuitesDoNotSleep (0.03s)
=== RUN   TestEveryTestAddressIsUnique
    boundary_test.go:165: 299 unique addresses across 70 features
--- PASS: TestEveryTestAddressIsUnique (0.01s)
=== RUN   TestConfigExample_MatchesTheDefaults
--- PASS: TestConfigExample_MatchesTheDefaults (0.00s)
=== RUN   TestConfigExample_ParsesBackToExactlyTheDefaults
--- PASS: TestConfigExample_ParsesBackToExactlyTheDefaults (0.00s)
=== RUN   TestConfig_MissingFileIsAValidConfiguration
--- PASS: TestConfig_MissingFileIsAValidConfiguration (0.00s)
=== RUN   TestTeardown_LeavesNoProcessAndNoBoundPort
--- PASS: TestTeardown_LeavesNoProcessAndNoBoundPort (2.59s)
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide/first
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/first
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide/second
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/second
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/first
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/second
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.01s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/second (0.14s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/first (0.14s)
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:279: Route coverage: 103 total routes in router.go (103 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.03s)
=== RUN   TestLogs_ContainNoConfiguredSecretInTheClear
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
=== RUN   TestRedactor_ReplacesAPasswordSentThroughTheRealAPI
--- PASS: TestRedactor_ReplacesAPasswordSentThroughTheRealAPI (0.32s)
=== RUN   TestSkillsSourcesGuard
    skills_sources_test.go:198: Verified all 8 scan root sources match between docs/skills/01-discovery-and-precedence.md and internal/skills/sources.go
--- PASS: TestSkillsSourcesGuard (0.00s)
=== RUN   TestSkillsSourcesGuard_IsNonVacuous
--- PASS: TestSkillsSourcesGuard_IsNonVacuous (0.00s)
=== RUN   TestUISpecs_DoNotUseHardcodedWaits
    ui_guard_test.go:93: Verified 20 UI spec files: 0 hardcoded waits found.
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.01s)
=== RUN   TestUISpecs_GuardIsNonVacuous
--- PASS: TestUISpecs_GuardIsNonVacuous (0.00s)
PASS
ok      amiro/tests/suites/meta 3.715s
```

## 4. Skills Backend Feature Suite (with list body omission and project param validation)

```
$ cd tests && go run ./cmd/amirotest run --surface backend --feature skills
run 2026-08-20T10-32-17Z-bf9bb8
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T10-32-17Z-bf9bb8
  providers: replay · parallel: 4

── backend ──
ok      amiro/tests/suites/backend/skills       4.744s

# Amiro test run 2026-08-20T10-32-17Z-bf9bb8

**PASSED** · 15 passed · 0 failed · 0 skipped · 5.8s
Started 2026-08-20T10:32:17Z · selection: --surface backend --feature skills · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |     15 |      0 |       0 |     4.7s |


Artifacts: /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T10-32-17Z-bf9bb8
```

## 5. Performance Budget (200 skills benchmark)

```
$ cd tests && AMIRO_TEST_RUN_TAGS_EXCLUDE= AMIRO_TEST_RUN_TAGS_INCLUDE=slow go test ./suites/backend/perf/ -run TestPerf_SkillsDiscoveryOver200Skills -v
=== RUN   TestPerf_SkillsDiscoveryOver200Skills
    skills_test.go:51: PERF skills.discovery_200_skills = 29.0ms (budget 1.00s)
             trend: no prior runs recorded -- threshold only
--- PASS: TestPerf_SkillsDiscoveryOver200Skills (0.96s)
PASS
ok      amiro/tests/suites/backend/perf 0.966s
```

## 6. Full Cross-Surface Regression Run

```
$ cd tests && go run ./cmd/amirotest run
run 2026-08-20T10-40-35Z-e65a4a
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T10-40-35Z-e65a4a
  providers: replay · parallel: 4

── meta ──
ok      amiro/tests/suites/meta 0.703s
── backend ──
ok      amiro/tests/suites/backend/admin        1.787s
ok      amiro/tests/suites/backend/agent        1.260s
ok      amiro/tests/suites/backend/archive      1.358s
ok      amiro/tests/suites/backend/auth 2.104s
ok      amiro/tests/suites/backend/bookmark     1.871s
ok      amiro/tests/suites/backend/chat 80.341s
ok      amiro/tests/suites/backend/config       0.179s
ok      amiro/tests/suites/backend/export       1.901s
ok      amiro/tests/suites/backend/lifecycle    0.651s
ok      amiro/tests/suites/backend/matrix       1.961s
ok      amiro/tests/suites/backend/mcp  2.020s
ok      amiro/tests/suites/backend/migration    0.796s
ok      amiro/tests/suites/backend/models       0.492s
ok      amiro/tests/suites/backend/perf 0.100s
ok      amiro/tests/suites/backend/providers    1.390s
ok      amiro/tests/suites/backend/resilience   83.726s
ok      amiro/tests/suites/backend/search       1.663s
ok      amiro/tests/suites/backend/security     6.989s
ok      amiro/tests/suites/backend/skills       8.362s
ok      amiro/tests/suites/backend/smoke        1.419s
ok      amiro/tests/suites/backend/storage      2.801s
ok      amiro/tests/suites/backend/thread       4.694s
ok      amiro/tests/suites/backend/user 3.378s
ok      amiro/tests/suites/backend/workflow     2.755s
── tui ──
ok      amiro/tests/suites/tui/approval 4.420s
ok      amiro/tests/suites/tui/auth     1.279s
ok      amiro/tests/suites/tui/chat     3.075s
ok      amiro/tests/suites/tui/config   2.427s
ok      amiro/tests/suites/tui/headless 2.242s
ok      amiro/tests/suites/tui/launch   1.897s
ok      amiro/tests/suites/tui/palette  0.771s
ok      amiro/tests/suites/tui/pickers  0.394s
ok      amiro/tests/suites/tui/rendering        2.368s
── ui ──

Running 26 tests using 4 workers

  ✓   1 …ate agent (10.6s)
  ✓   2 …oard tabs (13.2s)
  ✓   3 …ails form (13.1s)
  ✓   4 …-in inputs (5.0s)
  ✓   5 …no threads (9.5s)
  ✓   6 … on reload (7.0s)
  ✓   7 …dmin views (8.0s)
  ✓   8 …s /sign-up (5.9s)
  ✓   9 … selection (9.9s)
  ✓  10 …tification (6.0s)
  ✓  11 …completes (17.5s)
  ✓  12 …n threads (20.4s)
  ✓  13 …to sign in (7.2s)
  ✓  14 … fallback (17.3s)
  ✓  15 …g the test (6.9s)
  -  16 …he default suite)
  ✓  17 … not-found (5.5s)
  ✓  18 …er trigger (8.0s)
  ✓  19 …end-to-end (5.7s)
  ✓  20 …ive layout (3.2s)
  ✓  21 …iguration (12.1s)
  ✓  22 …s properly (5.7s)
  ✓  23 …ly to chat (8.5s)
  ✓  24 …nsistently (6.2s)
  ✓  25 …d examples (8.3s)
  ✓  26 …nsistently (4.4s)

  1 skipped
  25 passed (1.0m)
── cross ──
ok      amiro/tests/suites/cross/agentmention   0.565s
ok      amiro/tests/suites/cross/approvals      4.458s
ok      amiro/tests/suites/cross/attachembed    0.340s
ok      amiro/tests/suites/cross/concurrent     1.329s
ok      amiro/tests/suites/cross/connectscope   1.910s
ok      amiro/tests/suites/cross/export 0.884s
ok      amiro/tests/suites/cross/mcpsharing     1.308s
ok      amiro/tests/suites/cross/providerkeys   0.641s
ok      amiro/tests/suites/cross/servetui       0.783s
ok      amiro/tests/suites/cross/sharedconfig   0.601s
ok      amiro/tests/suites/cross/threadvisibility       0.595s
── desktop ──
ok      amiro/tests/suites/desktop/data 0.505s
ok      amiro/tests/suites/desktop/discovery    0.874s
ok      amiro/tests/suites/desktop/ipc  0.035s
ok      amiro/tests/suites/desktop/lifecycle    0.189s
ok      amiro/tests/suites/desktop/orphans      0.171s
ok      amiro/tests/suites/desktop/packaging    0.026s
ok      amiro/tests/suites/desktop/ports        0.333s
ok      amiro/tests/suites/desktop/skills       0.423s
ok      amiro/tests/suites/desktop/ui-parity    0.032s
ok      amiro/tests/suites/desktop/webview      0.283s

# Amiro test run 2026-08-20T10-40-35Z-e65a4a

**PASSED** · 263 passed · 0 failed · 18 skipped · 2m 55s
Started 2026-08-20T10:40:35Z · selection: --surface meta,backend,tui,ui,desktop,cross · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    159 |      0 |      12 |   3m 32s |
| cross   |     18 |      0 |       0 |    13.1s |
| desktop |     12 |      0 |       5 |     2.5s |
| meta    |     15 |      0 |       0 |    795ms |
| tui     |     34 |      0 |       0 |    18.4s |
| ui      |     25 |      0 |       1 |   3m 49s |
```

## 7. TypeScript & Linter Check

```
$ pnpm check
Checked 455 files in 414ms. No fixes applied.
> tsc --noEmit
Test Files  29 passed (29)
     Tests  354 passed (354)
```

## Remediation Test Count Movement Summary

| Metric | Before Remediation | After Remediation | Delta | Reason |
|---|---|---|---|---|
| **Total Passed** | 258 | 263 | +5 | +2 backend skills tests (`ListResponse_OmitsBodyAndResources`, `ProjectParam_ValidationAndSymlinks`), +3 TUI approval subtests explicitly tracked |
| **Total Failed** | 0 | 0 | 0 | Clean run |
| **Total Skipped** | 17 | 18 | +1 | +1 new `slow`-tagged perf test (`TestPerf_SkillsDiscoveryOver200Skills`) |
| **Backend Passed** | 157 | 159 | +2 | New integration coverage for JSON body omission & symlink project validation |
| **TUI Passed** | 31 | 34 | +3 | Isolated subtests in `TestApproval_AllFourPermissionModes` |
| **Waivers** | 0 | 0 | 0 | `waivers.yaml` remains `waivers: []` (103/103 routes covered) |

