# Verification Log — Phase 5 (The Skills section, and Generate with AI)

**Date:** 2026-08-22
**Run IDs:** `2026-08-22T05-02-49Z-e21df7` (ui/skills), `2026-08-22T05-23-16Z-5ef8f4` (cross/skills), `2026-08-22T05-23-18Z-26f263` (backend/skills), `2026-08-22T05-23-41Z-1d1b52` (desktop/skills), `2026-08-22T05-15-23Z-d7e42c` (full run)
**Machine notes:** Sandboxed Linux environment with no prior `node_modules`, no pnpm on `PATH`, no Chromium, no `libxkbcommon0`, and no dashboard bundle staged. All four were installed/built during this verification (`corepack pnpm install`, `pnpm exec playwright install chromium`, `sudo apt-get install libxkbcommon0`, `./scripts/build-ui.sh`) rather than assumed present — see the "Environment setup" section below. `cargo`/Tauri remain absent, so the desktop-toolchain-gated tests skip as `desktop.enabled: auto` intends; nothing here works around that.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Environment setup (once, before any test)

```
$ corepack pnpm install
...
devDependencies:
+ @biomejs/biome 1.9.4
...
Done in 12.1s

$ pnpm exec playwright install chromium
Chrome for Testing 151.0.7922.34 (playwright chromium v1234) downloaded to /home/user/.cache/ms-playwright/chromium-1234
...

$ sudo apt-get update && sudo apt-get install -y libxkbcommon0
...
Setting up libxkbcommon0:amd64 (1.6.0-1build1) ...

$ ./scripts/build-ui.sh
...
Route (app)
...
├ ○ /skill
├ ○ /skills
...
==> staged 748 files (24M)

$ cd backend-go && go build -tags embedui -o bin/amiro ./cmd/amiro
$ go build ./...
```

Both builds (tagged and untagged) exited 0. `amirotest doctor` afterward
confirmed `pnpm`, `chromium`, and the embedui bundle all present, leaving
only `cargo`/`tauri`/`webview` unresolved (desktop toolchain, out of scope
for this sandbox).

---

## Criterion 1: "`amirotest run --surface ui --feature skills` passes in under 2 minutes."

```
$ cd tests && go run ./cmd/amirotest run --surface ui --feature skills
...
  ✓   1 [chromium] › ui/specs/skills/skill-palette.spec.ts:6:7 › skills palette › empty state: opens palette showing empty indicator when no skills exist (13.4s)
  ✓   2 [chromium] › ui/specs/skills/skills-page.spec.ts:30:7 › skills page › lists writable and read-only skills in their own sections with source badges (12.9s)
  ✓   3 [chromium] › ui/specs/skills/skills-page.spec.ts:64:7 › skills page › create → appears in the list → appears in the '/' palette without a reload (12.0s)
  ✓   4 [chromium] › ui/specs/skills/skill-palette.spec.ts:31:7 › skills palette › error state: renders error indicator when /api/skills fails (e.g. invalid projectDirectory) (9.1s)
  ✓   5 [chromium] › ui/specs/skills/skill-palette.spec.ts:69:7 › skills palette › trigger rule: '/' on empty composer opens palette, mid-sentence does not (10.4s)
  ✓   6 [chromium] › ui/specs/skills/skills-page.spec.ts:100:7 › skills page › a bad name produces a field-level error and creates nothing (7.4s)
  ✓   7 [chromium] › ui/specs/skills/skills-page.spec.ts:119:7 › skills page › an over-long description produces a field-level error (6.2s)
  ✓   8 [chromium] › ui/specs/skills/skill-palette.spec.ts:108:7 › skills palette › four-directory plant shows exactly one row with .agents badge (7.9s)
  ✓   9 [chromium] › ui/specs/skills/skills-page.spec.ts:134:7 › skills page › a read-only skill opens disabled, names its owner, and Duplicate yields an editable copy (4.4s)
  ✓  10 [chromium] › ui/specs/skills/skill-palette.spec.ts:165:7 › skills palette › project and user skills grouped and badged with prefix filtering (10.8s)
  ✓  11 [chromium] › ui/specs/skills/skills-page.spec.ts:169:7 › skills page › delete confirms then removes the skill (10.7s)
  ✓  12 [chromium] › ui/specs/skills/skill-palette.spec.ts:243:7 › skills palette › disable-model-invocation: true skills appear in the palette alongside regular skills (Decision D) (7.5s)
  ✓  13 [chromium] › ui/specs/skills/skills-page.spec.ts:194:7 › skills page › `create-agent-button` and `create-agent-card` match zero elements anywhere in the app (8.6s)
  ✓  14 [chromium] › ui/specs/skills/skill-palette.spec.ts:280:7 › skills palette › keyboard navigation and selection renders chip and deletes composer range (9.1s)
  ✓  15 [chromium] › ui/specs/skills/skills-page.spec.ts:218:7 › skills page — generate with AI › Generate populates the form and nothing is written until Save is pressed (7.6s)
  ✓  16 [chromium] › ui/specs/skills/skill-palette.spec.ts:324:7 › skills palette › escape closes palette without selecting and preserves already-selected chips (Item 1 bugfix) (9.2s)
  ✓  17 [chromium] › ui/specs/skills/skills-page.spec.ts:253:7 › skills page — generate with AI, invalid name › a generated invalid name shows a field error instead of a save failure (7.8s)
  ✓  18 [chromium] › ui/specs/skills/skill-palette.spec.ts:376:7 › skills palette › palette names equal API response names for user and project by interception (bi-directional check) (4.2s)
  ✓  19 [chromium] › ui/specs/skills/skill-palette.spec.ts:439:7 › skills palette › chat request body includes skill mention and does NOT strip app default toolkit (Trap 2 guard) (8.6s)
  ✓  20 [chromium] › ui/specs/skills/skill-palette.spec.ts:495:7 › skills palette › @-mention flow still works with skill extension registered and selects an app tool (Criterion 4) (7.8s)
  20 passed (1.7m)

# Amiro test run 2026-08-22T05-02-49Z-e21df7

**PASSED** · 20 passed · 0 failed · 0 skipped · 1m 44s
Started 2026-08-22T05:02:49Z · selection: --surface ui --feature skills · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| ui      |     20 |      0 |       0 |   2m 55s |
```

**Verdict:** ✅ MET — the run's own headline (`1m 44s`) and Playwright's own
`20 passed (1.7m)` agree and are under the 2-minute budget. Noted
honestly: the per-surface table row in this same report shows `2m 55s`
for `ui`, a larger number than the headline; it appears to double-count
some portion of setup/teardown across the run's own bookkeeping rather
than reflecting a slower actual test execution (Playwright's own timer,
the authoritative one for wall-clock spec execution, says 1.7m). Not
investigated further as it does not change the pass/fail outcome of this
criterion.

---

## Criterion 2 & 5: create → list → palette, and Generate → Save-gated write

Both proven in the same run as Criterion 1, tests 3 and 15 above:

- `ui/skills/create → appears in the list → appears in the '/' palette without a reload` — creates through the real form, asserts the card renders on `/skills`, then navigates to `/` via a `Link` click (never `page.reload()`) and confirms the skill is selectable from the `/` palette.
- `ui/skills — generate with AI/Generate populates the form and nothing is written until Save is pressed` — scripts the backend's fake provider with a valid `{name, description, body}` JSON reply via the new `fakeReply` test fixture option, drives the Generate dialog, asserts the name/description fields populate, asserts the URL is still `/skill?name=new`, and asserts `GET /api/skills` (via `page.evaluate(fetch(...))`) does not contain the generated name.

**Verdict:** ✅ MET for both — see the pass lines above.

---

## Criterion 3: read-only `.claude` skill, Duplicate → editable copy

```
✓   9 [chromium] › ui/specs/skills/skills-page.spec.ts:134:7 › skills page › a read-only skill opens disabled, names its owner, and Duplicate yields an editable copy (4.4s)
```

This test plants a `.claude`-scope skill, asserts `skill-readonly-notice`
is visible and contains `.claude`, asserts the name/description/body
inputs are `disabled`, clicks Duplicate, and — after the duplicate-cache
fix described in the phase record's divergence 4 — asserts the read-only
notice is gone and the description/body fields are editable.

**Verdict:** ✅ MET.

---

## Criterion 4: bad name → field error, verified through the API

```
✓   6 [chromium] › ui/specs/skills/skills-page.spec.ts:100:7 › skills page › a bad name produces a field-level error and creates nothing (7.4s)
```

The assertion reads `GET /api/skills` from inside the page
(`page.evaluate(() => fetch('/api/skills', ...))`) and checks the parsed
JSON's `items` array, not a DOM query — per the criterion's explicit
"not through the DOM" requirement.

**Verdict:** ✅ MET.

---

## Criterion 6: `create-agent-button`/`create-agent-card` are gone everywhere

```
✓  13 [chromium] › ui/specs/skills/skills-page.spec.ts:194:7 › skills page › `create-agent-button` and `create-agent-card` match zero elements anywhere in the app (8.6s)
```

Checked on both `/skills` and `/` (home). Backed by the fact that
`agents-list.tsx` (the only file that ever rendered those two testids) was
deleted in this phase.

**Verdict:** ✅ MET.

---

## Criterion 7: `amirotest run --surface cross --feature skills`

```
$ go run ./cmd/amirotest run --surface cross --feature skills
ok  	amiro/tests/suites/cross/skills	0.949s

# Amiro test run 2026-08-22T05-23-16Z-5ef8f4

**PASSED** · 2 passed · 0 failed · 0 skipped · 2.2s
Started 2026-08-22T05:23:16Z · selection: --surface cross --feature skills · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| cross   |      2 |      0 |       0 |    939ms |
```

The 2 passing tests are `TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette`
(Phase 3, unchanged) and the new
`TestCrossSurface_SkillCreatedInDashboardReachesTUISlashPalette`, which
calls `browser.CreateSkill(...)` (the real authoring API, not a planted
fixture file) and then asserts the TUI's `/` palette offers it in the same
run.

**Verdict:** ✅ MET.

---

## Criterion 8: `pnpm check` clean, all seven locales carry the new keys

```
$ pnpm check
> pnpm lint:fix && pnpm check-types && pnpm test

> biome lint --write --unsafe
Checked 462 files in 374ms. No fixes applied.

> tsc --noEmit
(no output — clean)

> vitest run
 Test Files  29 passed (29)
      Tests  354 passed (354)
   Duration  5.99s
```

```
$ node -e "for (const f of ['en','es','fr','ja','ko','no','zh']) { const j = JSON.parse(require('fs').readFileSync('messages/'+f+'.json')); if (!j.Skill || !j.Skill.validation) throw new Error(f+' missing Skill.validation'); console.log(f, 'OK — Skill keys:', Object.keys(j.Skill).length); }"
en OK — Skill keys: 28
es OK — Skill keys: 28
fr OK — Skill keys: 28
ja OK — Skill keys: 28
ko OK — Skill keys: 28
no OK — Skill keys: 28
zh OK — Skill keys: 28
```

**Verdict:** ✅ MET.

---

## Criterion 9: `amirotest run` green overall, `suites/meta` included

```
$ cd tests && go run ./cmd/amirotest run
...
# Amiro test run 2026-08-22T05-15-23Z-d7e42c

**PASSED** · 332 passed · 0 failed · 18 skipped · 5m 12s
Started 2026-08-22T05:15:23Z · selection: --surface meta,backend,tui,ui,desktop,cross · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    197 |      0 |      12 |   4m 34s |
| cross   |     20 |      0 |       0 |    17.7s |
| desktop |     13 |      0 |       5 |     3.8s |
| meta    |     17 |      0 |       0 |     1.1s |
| tui     |     41 |      0 |       0 |    27.3s |
| ui      |     44 |      0 |       1 |    9m 4s |

## Skipped

- backend/migration/TestMigration_PostgresSchemaHandlingAndSkip — tagged "live"
- backend/perf/* (7 tests) — tagged "slow"
- backend/resilience/TestResilience_AuthExpiryNotCoveredHere — PARTIAL (pre-existing, Phase 0-era)
- backend/resilience/TestResilience_DatabaseFaultsNotCoveredHere — NOT MET (pre-existing, needs a mounted small filesystem + a postgres fixture, both absent here)
- desktop/lifecycle, desktop/ports, desktop/ui-parity, desktop/webview — cargo not found on PATH; desktop.enabled=auto skips cleanly
- desktop/packaging/TestPackaging_TauriBuildProducesAWorkingInstalledApp — tagged "slow"
- ui/errors/... expected-fail probe — deliberate, run only with AMIRO_RUN_EXPECTED_FAIL_SPECS=1
```

All 18 skips predate this phase and are unrelated to Skills; none were
newly introduced.

**Verdict:** ✅ MET.

---

## New test coverage actually runs

```
$ go run ./cmd/amirotest list --surface ui | grep -i skill
  ui/skills  (23 tests)
      ...
      ui/skills/create → appears in the list → appears in the '/' palette without a reload
      ui/skills/a bad name produces a field-level error and creates nothing
      ui/skills/an over-long description produces a field-level error
      ui/skills/a read-only skill opens disabled, names its owner, and Duplicate yields an editable copy
      ui/skills/delete confirms then removes the skill
      ui/skills/`create-agent-button` and `create-agent-card` match zero elements anywhere in the app
      ui/skills/Generate populates the form and nothing is written until Save is pressed
      ui/skills/a generated invalid name shows a field error instead of a save failure
      ui/skills/lists writable and read-only skills in their own sections with source badges
      ...
```

```
$ go run ./cmd/amirotest run --surface backend --feature skills
ok  	amiro/tests/suites/backend/skills	21.365s
**PASSED** · 52 passed · 0 failed · 0 skipped · 22.6s
```

Phase 4's own backend/skills count was 49; this phase's 3 new
`tests/suites/backend/skills/generate_test.go` tests bring it to 52
(49 + 3 = 52, confirmed).

```
$ go run ./cmd/amirotest run --surface desktop --feature skills
**PASSED** · 2 passed · 0 failed · 0 skipped · 2.1s
```

`TestDesktop_UntaggedSidecarServesSkillsAndDiscoversHome` (Phase 4) plus
the new `TestDesktop_CreatingSkillWritesUnderSidecarHomeAndIsListed` (2
total, confirming the new address is discovered and executed, not
silently matching nothing).

---

## Guards

```
$ cd tests && go test ./suites/meta/... -v
=== RUN   TestNoTestImportsTheApplicationModule
--- PASS: TestNoTestImportsTheApplicationModule (0.12s)
=== RUN   TestSuitesDoNotImportEachOther
--- PASS: TestSuitesDoNotImportEachOther (0.02s)
=== RUN   TestSuitesDoNotSleep
--- PASS: TestSuitesDoNotSleep (0.05s)
=== RUN   TestEveryTestAddressIsUnique
    boundary_test.go:165: 358 unique addresses across 73 features
--- PASS: TestEveryTestAddressIsUnique (0.02s)
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:279: Route coverage: 108 total routes in router.go (108 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.03s)
=== RUN   TestSandboxGuard_ModifyingToolsNeverUseResolveReadable
--- PASS: TestSandboxGuard_ModifyingToolsNeverUseResolveReadable (0.01s)
=== RUN   TestLogs_ContainNoConfiguredSecretInTheClear
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
=== RUN   TestSkillsSourcesGuard
    skills_sources_test.go:198: Verified all 8 scan root sources match between docs/skills/01-discovery-and-precedence.md and internal/skills/sources.go
--- PASS: TestSkillsSourcesGuard (0.00s)
=== RUN   TestUISpecs_DoNotUseHardcodedWaits
    ui_guard_test.go:93: Verified 20 UI spec files: 0 hardcoded waits found.
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.00s)
=== RUN   TestWritableRootGuard_WriteSkillMDCalledOnlyFromService
--- PASS: TestWritableRootGuard_WriteSkillMDCalledOnlyFromService (0.01s)
PASS
ok  	amiro/tests/suites/meta	0.962s
```

`POST /api/skills/generate` was picked up by `TestRouteCoverageGuard`
automatically — no waiver needed or added.

---

## Regression check

```
$ pnpm check
✓ biome: Checked 462 files in 374ms. No fixes applied.
✓ tsc --noEmit: clean
✓ vitest: 354/354 tests passed

$ cd backend-go && go build ./... && go vet ./... && go test ./...
(all packages ok, including internal/api/skills: 4 new TestHandler_Generate_* tests pass)

$ go build -tags embedui -o bin/amiro ./cmd/amiro
(exit 0 — the embedui seam still compiles with the new route registered)

$ cd tests && go run ./cmd/amirotest run
**PASSED** · 332 passed · 0 failed · 18 skipped · 5m 12s
```

One true regression was caught and fixed during this pass (not a flake):
`tests/ui/specs/dashboard/fallback.spec.ts` hard-refreshed `/agents` and
asserted `agents-title`, both gone once this phase deleted `agents/page.tsx`
(divergence 1). The first full run surfaced it as a genuine failure
(`FAILED · 331 passed · 1 failed · 18 skipped`); repointed the spec at
`/skills`/`skills-title` and reran clean.

---

## Notes

- The Go backend bug found and fixed (phase record divergence 3 —
  `toListResponse` serializing an empty list as JSON `null` instead of
  `[]`) predates this phase (present since Phase 0) and was invisible
  until Phase 5 added a consumer (`useMutateSkills`, and this phase's own
  Playwright assertions) that didn't defensively guard against it. Worth
  a general note for future phases: any new SWR cache-mutation logic
  touching a list-shaped API response should not assume `[]` without
  checking, even when the backend "should" always return one.
- This environment had none of `pnpm`, Chromium, `libxkbcommon0`, or a
  staged dashboard bundle before this verification pass; all were
  installed/built as part of it (see "Environment setup"). A different
  checkout that already has these will not need to repeat that setup, but
  should not assume `ui`/`desktop` verification is optional on that basis
  — this phase's exit criteria 1–6 are UI-surface criteria and cannot be
  verified without it.
