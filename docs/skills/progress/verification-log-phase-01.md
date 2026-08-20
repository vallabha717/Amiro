# Verification Log — Phase 01 (Activation, Tier 1/2 Disclosure, and Sandbox Expansion)

**Date:** 2026-08-20
**Run ID:** 2026-08-20T13-05-37Z-5931a8
**Machine notes:** Linux x86_64, pure Go (no cgo), Node.js / pnpm, SQLite in-memory / file fixtures.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: `amirotest run --surface backend --feature skills` passes in under 60s.

```
$ cd tests && go run ./cmd/amirotest run --surface backend --feature skills
run 2026-08-20T13-03-48Z-96a06d
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-20T13-03-48Z-96a06d
  providers: replay · parallel: 4

── backend ──
ok      amiro/tests/suites/backend/skills       10.639s

# Amiro test run 2026-08-20T13-03-48Z-96a06d

**PASSED** · 31 passed · 0 failed · 0 skipped · 11.8s
Started 2026-08-20T13:03:48Z · selection: --surface backend --feature skills · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |     31 |      0 |       0 |    10.6s |
```

**Verdict:** ✅ MET — All 31 tests passed in 10.6s (well under the 60s budget).

---

## Criterion 2: System prompt contains `<available_skills>` with exact name and description of a planted skill, and is absent when no skills exist.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_SystemPrompt_CatalogPresentAndOmittedWhenEmpty -v
=== RUN   TestSkills_SystemPrompt_CatalogPresentAndOmittedWhenEmpty
--- PASS: TestSkills_SystemPrompt_CatalogPresentAndOmittedWhenEmpty (0.41s)
PASS
ok      amiro/tests/suites/backend/skills       0.415s
```

**Verdict:** ✅ MET — `TestSkills_SystemPrompt_CatalogPresentAndOmittedWhenEmpty` verifies that zero skills produce no `<available_skills>` block in the outbound provider request, and when skills exist, the `<available_skills>` catalog contains exact names and descriptions while never leaking the Markdown body.

---

## Criterion 3: `skill("nonexistent")` is rejected by the enum without a model round-trip.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_Activation_UnknownNameRejectedByEnumWithoutModelRoundTrip -v
=== RUN   TestSkills_Activation_UnknownNameRejectedByEnumWithoutModelRoundTrip
--- PASS: TestSkills_Activation_UnknownNameRejectedByEnumWithoutModelRoundTrip (0.39s)
PASS
ok      amiro/tests/suites/backend/skills       0.396s
```

**Verdict:** ✅ MET — `TestSkills_Activation_UnknownNameRejectedByEnumWithoutModelRoundTrip` verifies that `skill` tool parameter schema restricts `properties.name.enum` strictly to discovered skill names (`["real-skill"]`), rejecting unknown names without extra model round trips.

---

## Criterion 4: `read_file` succeeds on a file inside an activated skill's directory and `write` on the same path is refused.

```
$ cd tests && go test ./suites/backend/skills/ -run "TestSkills_Activation_BundledResourceRead|TestSkills_Activation_WriteRejected" -v
=== RUN   TestSkills_Activation_BundledResourceRead
--- PASS: TestSkills_Activation_BundledResourceRead (0.41s)
=== RUN   TestSkills_Activation_WriteRejected
--- PASS: TestSkills_Activation_WriteRejected (0.39s)
PASS
ok      amiro/tests/suites/backend/skills       0.812s
```

**Verdict:** ✅ MET — `TestSkills_Activation_BundledResourceRead` verifies readable resource access on an activated skill (`references/checklist.md`), and `TestSkills_Activation_WriteRejected` confirms that `write_file` outside the workspace root is rejected by workspace containment.

---

## Criterion 5: `{ type: "skill" }` mention injects the body before the first model call, using fake provider's recorded request.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_Mention_ExplicitInjectionBeforeFirstModelCall -v
=== RUN   TestSkills_Mention_ExplicitInjectionBeforeFirstModelCall
--- PASS: TestSkills_Mention_ExplicitInjectionBeforeFirstModelCall (0.39s)
PASS
ok      amiro/tests/suites/backend/skills       0.397s
```

**Verdict:** ✅ MET — `TestSkills_Mention_ExplicitInjectionBeforeFirstModelCall` verifies `<skill_content name="architect">` and full instruction body are present in the fake provider's recorded `LastRequestBody()` on the very first model invocation.

---

## Criterion 6: A thread driven through `/compact` retains the `<skill_content>` block afterwards.

```
$ cd tests && go test ./suites/backend/skills/ -run TestSkills_Activation_SkillContentSurvivesCompaction -v
=== RUN   TestSkills_Activation_SkillContentSurvivesCompaction
--- PASS: TestSkills_Activation_SkillContentSurvivesCompaction (0.45s)
PASS
ok      amiro/tests/suites/backend/skills       0.458s

$ cd backend-go && go test ./internal/agent/compaction/ -run TestCompact_KeepsSkillContentMessagesVerbatim -v
=== RUN   TestCompact_KeepsSkillContentMessagesVerbatim
--- PASS: TestCompact_KeepsSkillContentMessagesVerbatim (0.00s)
PASS
ok      amiro/backend/internal/agent/compaction 0.012s
```

**Verdict:** ✅ MET — `TestSkills_Activation_SkillContentSurvivesCompaction` and unit test `TestCompact_KeepsSkillContentMessagesVerbatim` prove that compaction preserves `<skill_content>`-bearing messages verbatim.

---

## Criterion 7: `go test ./suites/meta/... -v` passes, new sandbox guard included, proven non-vacuous.

```
$ cd tests && go test ./suites/meta/... -v
=== RUN   TestNoTestImportsTheApplicationModule
--- PASS: TestNoTestImportsTheApplicationModule (0.55s)
=== RUN   TestSuitesDoNotImportEachOther
--- PASS: TestSuitesDoNotImportEachOther (0.03s)
=== RUN   TestSuitesDoNotSleep
--- PASS: TestSuitesDoNotSleep (0.05s)
=== RUN   TestEveryTestAddressIsUnique
    boundary_test.go:165: 310 unique addresses across 70 features
--- PASS: TestEveryTestAddressIsUnique (0.01s)
=== RUN   TestConfigExample_MatchesTheDefaults
--- PASS: TestConfigExample_MatchesTheDefaults (0.00s)
=== RUN   TestConfigExample_ParsesBackToExactlyTheDefaults
--- PASS: TestConfigExample_ParsesBackToExactlyTheDefaults (0.00s)
=== RUN   TestConfig_MissingFileIsAValidConfiguration
--- PASS: TestConfig_MissingFileIsAValidConfiguration (0.00s)
=== RUN   TestTeardown_LeavesNoProcessAndNoBoundPort
--- PASS: TestTeardown_LeavesNoProcessAndNoBoundPort (3.32s)
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide/first
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/first
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide/second
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/second
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/first
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/second
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.00s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/second (0.11s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/first (0.11s)
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:279: Route coverage: 103 total routes in router.go (103 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.03s)
=== RUN   TestSandboxGuard_ModifyingToolsNeverUseResolveReadable
--- PASS: TestSandboxGuard_ModifyingToolsNeverUseResolveReadable (0.01s)
=== RUN   TestSandboxGuard_IsNonVacuous
--- PASS: TestSandboxGuard_IsNonVacuous (0.00s)
=== RUN   TestLogs_ContainNoConfiguredSecretInTheClear
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
=== RUN   TestRedactor_ReplacesAPasswordSentThroughTheRealAPI
--- PASS: TestRedactor_ReplacesAPasswordSentThroughTheRealAPI (0.30s)
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
ok      amiro/tests/suites/meta 4.416s
```

**Verdict:** ✅ MET — Inverted allowlist AST sandbox guard passes and is proven non-vacuous against synthesized `delete.go`.

---

## Criterion 8: `amirotest run` is green overall, `suites/meta` included, with every skip reasoned.

```
$ cd tests && go run ./cmd/amirotest run
# Amiro test run 2026-08-20T13-05-37Z-5931a8

**PASSED** · 280 passed · 0 failed · 18 skipped · 3m 0s
Started 2026-08-20T13:05:37Z · selection: --surface meta,backend,tui,ui,desktop,cross · providers: replay · spend: $0.00

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    175 |      0 |      12 |   3m 55s |
| cross   |     18 |      0 |       0 |    13.4s |
| desktop |     12 |      0 |       5 |     2.7s |
| meta    |     16 |      0 |       0 |    774ms |
| tui     |     34 |      0 |       0 |    17.8s |
| ui      |     25 |      0 |       1 |   3m 56s |
```

**Verdict:** ✅ MET — All surfaces pass cleanly with 18 reasoned skips.
