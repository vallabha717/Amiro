# Phase 00 — Discovery core and the read API

**Status:** ✅ Complete (7/7 criteria MET)
**Date:** 2026-08-20
**Verification Log:** [verification-log-phase-00.md](verification-log-phase-00.md)

---

## 1. What Shipped

Phase 0 adds the discovery core and read API for Agent Skills (`SKILL.md`) in Amiro. Amiro now scans eight directory roots across project and user scopes (`.agents`, `.amiro`, `.claude`, `.codex`), leniently parses YAML frontmatter with automatic retry on unquoted scalars containing colons, enforces project-over-user precedence and source order, deduplicates by identity (real path) and normalized name, tracks shadowed collisions with detailed reason diagnostics, and exposes the catalog over session-guarded `GET /api/skills` and `GET /api/skills/items/{name}` endpoints. It reaches the backend API, the desktop sidecar, and the TypeScript client layer.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **`sources.go`** | `backend-go/internal/skills/sources.go` | Canonical 8-row scan roots table with precedence, scopes, and writability flags. |
| **`parse.go`** | `backend-go/internal/skills/parse.go` | Frontmatter split, YAML parser with scalar quoting retry, and lenient diagnostic rules. |
| **`scan.go`** | `backend-go/internal/skills/scan.go` | Bounded filesystem scanner with depth, count, and size limit guards. |
| **`resolve.go`** | `backend-go/internal/skills/resolve.go` | Precedence resolution, real-path identity deduplication, and shadowing bookkeeping. |
| **`service.go`** | `backend-go/internal/skills/service.go` | Invalidation-driven discovery service with per-key `Invalidate(home, project)` and `InvalidateAll()`. |
| **`handler.go`** | `backend-go/internal/api/skills/handler.go` | HTTP handler and response DTOs (`SkillSummaryDTO` for list without `Body`/`Resources`, `SkillDTO` for get). |
| **`route.go`** | `backend-go/internal/api/skills/route.go` | `GET /api/skills` and `GET /api/skills/items/{name}` with symlink/directory project validation. |
| **`skills.ts`** | `src/types/skill.ts` | Shared TypeScript types (`SkillSummary`, `Skill`, `SkillDiagnostic`, `SkillsListResponse`). |
| **`skills-api.ts`** | `src/lib/backend/skills-api.ts` | Typed frontend API client methods (`listSkills`, `getSkill`). |
| **`apiclient/skills.go`** | `tests/harness/apiclient/skills.go` | Test harness typed client for skills routes. |
| **`fixtures/skills`** | `tests/fixtures/skills/` | Test fixtures for `.agents`, `.amiro`, `.claude`, `.codex`, and edge cases. |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend | `tests/suites/backend/skills/` | 15 | 8 roots discovery, project over user precedence, same-scope tie breaking, symlink deduplication, missing description skipped with reason, invalid YAML skipped with reason, colon-in-description retry, name/dir mismatch warning, size bounds trip, non-absolute project rejection, unauthenticated 401, GetSkill details and 404, list response JSON body/resources omission, project param symlink/non-directory validation |
| backend perf | `tests/suites/backend/perf/skills_test.go` | 1 | `TestPerf_SkillsDiscoveryOver200Skills` (tagged `slow`, calibrated budget 1.0s, measured 29.0ms for 200 skills) |
| desktop | `tests/suites/desktop/skills/` | 1 | Untagged sidecar serves `GET /api/skills` and resolves `$HOME` for user scope |
| meta | `tests/suites/meta/skills_sources_test.go` | 2 | `TestSkillsSourcesGuard` enforcing `skills.Sources` matches doc table, plus `TestSkillsSourcesGuard_IsNonVacuous` proving non-vacuous guard |
| backend unit | `backend-go/internal/skills/skills_test.go` | 7 | Unit tests for parser, colon retry, missing description, dir fallback, symlink dedup, precedence, explicit invalidation |
| http handler unit | `backend-go/internal/api/skills/route_test.go` | 8 | Unit tests for HTTP list/get routes, auth, project resolution, non-existent/file rejection, JSON body omission |
| router e2e unit | `backend-go/internal/httpserver/skills_routes_test.go` | 1 | Integration test through HTTP router |

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `backend-go/internal/httpserver/router.go` | Registered skills routes and added `Skills` to `Handlers` | +10 / -1 |
| `backend-go/internal/appwiring/wiring.go` | Instantiated `skills.Service` and wired `skillsapi.Handler` into `App` | +7 / -0 |
| `biome.json` | Ignored `tests/logs/**`, `tests/node_modules/**`, `backend-go/**` from Biome linting | +1 / -1 |
| `tests/README.md` | Restored testing foundation progress link and documented skills progress link | +2 / -8 |
| `tests/suites/backend/perf/budget_test.go` | Added `budgetSkillsDiscovery` (1.0s limit) constant | +7 / -0 |
| `tests/suites/cross/servetui/servetui_test.go` | Added PTY stability wait after model picker close | +1 / -0 |
| `tests/suites/tui/approval/approval_test.go` | Isolated subtest backend harnesses in `TestApproval_AllFourPermissionModes` | +25 / -15 |
| `tests/ui/specs/*` | Aliased unused test parameter `amiro` to `_amiro` to satisfy linter | +5 / -5 |
| `tests/ui/support/*` | Aliased unused `err` to `_err` in support helpers | +2 / -2 |

---

## 2. What Diverged from the Plan, and Why

1. **List response serialisation vs. 3-tier disclosure model:**
   *What happened:* `internal/skills/parse.go` and `Resolve` populate the full Markdown body and auxiliary resource lists. Initially, `toListResponse` serialized `Body` and `Resources` in `GET /api/skills`, which would cause every turn's system prompt and the composer `/` palette to download all instructions upfront.
   *What changed:* Kept `Body` and `Resources` in the in-memory scan model (`skills.Skill`) so `Get` can read from the cache with zero disk re-reads, but decoupled the HTTP list DTO (`SkillSummaryDTO`) from `SkillDTO`. `GET /api/skills` returns only Tier-1 metadata (omits `body` and `resources`). `GET /api/skills/items/{name}` delivers the full `SkillDTO` with `body` and `resources`.

2. **Explicit cache invalidation vs. time-based TTL:**
   *What happened:* The initial implementation included `cacheTTL: 10 * time.Second`. `docs/skills/01-discovery-and-precedence.md` specifies that discovery freshness is invalidation-driven (mutation operations explicitly invalidate the cache). A TTL creates clock dependencies and allows mutation tests to pass simply by sleeping.
   *What changed:* Removed `cacheTTL` completely. Added `Invalidate(home, project)` for targeted workspace invalidation and `InvalidateAll()` for global cache clearance, with unit tests proving discovery changes are invisible until invalidation and instant immediately after.

3. **`?project=` query parameter canonical resolution:**
   *What happened:* `route.go` originally checked `filepath.IsAbs` without path normalization.
   *What changed:* Added `resolveProjectParam` which performs `filepath.Clean`, `filepath.EvalSymlinks`, and verifies the target is an existing directory (`os.Stat` + `IsDir()`). Non-existent paths or files return a clean HTTP 400 Bad Request, and symlinked paths resolve to the target directory ensuring cache key consistency.

4. **Performance budget mitigation delivered:**
   *What happened:* The phase risks section highlighted discovery scan latency over large trees (~200 skills) as a potential risk.
   *What changed:* Implemented `TestPerf_SkillsDiscoveryOver200Skills` in `tests/suites/backend/perf/skills_test.go` with `harness.Tags("slow")`. It benchmarks discovery of 200 skills against a 1.0s budget and recorded 29.0ms latency.

5. **PTY test harness frame synchronization:**
   *What happened:* Two cross-surface PTY tests (`tests/suites/cross/servetui/servetui_test.go` and `tests/suites/tui/approval/approval_test.go`) experienced frame-redraw timing races: `servetui` raced on closing the model picker modal, and `approval` shared a single backend across 4 subtests causing rule cross-matching on resumed thread history.
   *What changed:* Added `sess.WaitForStable(1 * time.Second)` in `servetui_test.go` and gave each permission mode in `approval_test.go` its own isolated test harness instance.

6. **Biome ignore configuration and lint cleanups:**
   *What happened:* `pnpm check` was hanging while Biome crawled large test log traces in `tests/logs/**`.
   *What changed:* Added `tests/logs/**`, `tests/node_modules/**`, and `backend-go/**` to `biome.json` ignores, and renamed unused callback parameters in `tests/ui/specs/` and `tests/ui/support/` to `_amiro`/`_err`. `pnpm check` now passes in <400ms across 455 files.

---

## 3. Exit Criteria (Verbatim from the Phase 00 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `amirotest run --surface backend --feature skills` passes in under 30s. | ✅ MET | Passed 15/15 tests in 4.7s. |
| 2 | A test asserts that a skill present in **all four** user-scope directories appears exactly once in `GET /api/skills`, with `source: ".agents"` and three entries in `shadows`. | ✅ MET | `TestSkills_SourceOrderBreaksSameScopeTie` passed; confirms 1 item returned with `source: ".agents"` and 3 shadows (`.amiro`, `.claude`, `.codex`). |
| 3 | A test asserts a project-scope skill named `code-review` wins over a user-scope skill of the same name, and that the user-scope one is reported as shadowed rather than dropped silently. | ✅ MET | `TestSkills_ProjectBeatsUserForSameName` passed; confirms project-scope `code-review` wins and user-scope is recorded in `shadows`. |
| 4 | A test asserts a skill whose `SKILL.md` has no `description` is absent from the list **and** present in `diagnostics` with a reason string. | ✅ MET | `TestSkills_MissingDescriptionIsSkippedWithReason` passed; confirms skill omitted from `items` and present in `diagnostics` with error severity and message. |
| 5 | `go test ./suites/meta/... -v` passes, including the new sources-table guard, and the guard is proven non-vacuous by a test that fails it on a mutated table. | ✅ MET | `TestSkillsSourcesGuard` and `TestSkillsSourcesGuard_IsNonVacuous` both pass, along with `TestRouteCoverageGuard` (103/103 routes covered). |
| 6 | `cd backend-go && go build ./... && go build -tags embedui ./...` both succeed; `GOOS=windows go build ./...` still succeeds. | ✅ MET | All three compilations succeed with exit code 0. |
| 7 | `amirotest run` is green overall, `suites/meta` included, with every skip reasoned. | ✅ MET | 263 passed, 0 failed, 18 reasoned skips across all surfaces. |

---

## 4. Standards Compliance

- **`backend`:** Followed package layout (`internal/skills`, `internal/api/skills`), `internal/api/httpjson` used for all HTTP responses, `auth.UserFromContext` checked for caller session, pure Go without cgo dependencies, clean compilation with and without `-tags embedui` and under `GOOS=windows`. Zero database migrations.
- **`ui`:** Added `src/types/skill.ts` (`SkillSummary`, `Skill`) and `src/lib/backend/skills-api.ts` using `apiJson`. `pnpm check` clean (354/354 vitest tests pass, tsc clean, biome clean).
- **`test`:** 15 backend skills tests, 1 perf benchmark, 1 desktop test, 2 meta guard tests. Zero sleeps added. All 103 routes in router covered with no waivers (`waivers: []`).

---

## 5. Known Scope Boundaries & Follow-ups

- **Model prompt disclosure and activation tool (Phase 1):** Disclosing the discovered skills catalog to LLM system prompt and providing the `skill()` tool is handled in Phase 1.
- **Composer `/` palette (Phases 2 & 3):** User invocation palette in web and TUI composer is handled in Phases 2 and 3.
- **Authoring & file mutation (Phase 4):** Create, edit, and delete endpoints with validation and explicit cache invalidation via `skills.Service.Invalidate` are handled in Phase 4.
