# Phase 4 — Authoring API

## What shipped

### New files

| File | Description |
|---|---|
| `backend-go/internal/skills/validate.go` | `FieldError`, `ValidationResult`, `ValidateName`, `ValidateDescription`, `ValidateFrontmatter`, `ValidateBody`, `CombineResults` |
| `backend-go/internal/skills/write.go` | `WritableRoot`, `ContainmentCheck`, `WriteSkillMD` (atomic), `BuildSkillMDContent`, `SerializeFrontmatter`, `UnexpectedFiles`, `CopyDir` |
| `tests/suites/backend/skills/authoring_test.go` | Integration tests covering CRUD, duplicate collisions, frontmatter preservation, name validation, and cache invalidation |
| `tests/suites/meta/writable_root_guard_test.go` | AST guard enforcing only `service.go` calls `WriteSkillMD` + non-vacuous companion |
| `docs/skills/progress/verification-log-phase-04.md` | Verification log with Bug 1/2 proofs, 5 mutation probe logs, security tests, and suite metrics |
| `docs/skills/progress/phase-04-authoring-api.md` | This record |

### Modified files

| File | Changes |
|---|---|
| `backend-go/internal/skills/parse.go` | Added `(*Skill).FrontmatterExtras()` method to serialize optional frontmatter fields |
| `backend-go/internal/skills/service.go` | Added `WriteInput`, sentinel errors (`ErrConflict`, `ErrReadOnlySkill`, `ErrUnexpectedFiles`, `ErrInvalidName`), `Create`, `Update`, `Delete`, `Duplicate`, and prefix-based home cache invalidation |
| `backend-go/internal/api/skills/handler.go` | Extended `Service` interface; added authoring request/response DTOs |
| `backend-go/internal/api/skills/route.go` | Implemented `Create`, `Update`, `Delete`, `Duplicate` handlers with field error mapping and 400/409/422 status codes |
| `backend-go/internal/httpserver/router.go` | Registered write routes in router table under session auth |
| `backend-go/internal/api/httpjson/httpjson.go` | Added `Conflict(w, msg)` (409) and updated status summary comment |
| `tests/harness/apiclient/skills.go` | Added `CreateSkill`, `UpdateSkill`, `DeleteSkill`, `DuplicateSkill` client methods |
| `tests/suites/backend/security/escape_test.go` | Added `TestSkills_Authoring_TraversalAndSymlinkEscapeRejected` covering create/update/delete security containment |
| `backend-go/internal/api/skills/route_test.go` | Added stub implementations of new Service methods to `fakeService` |
| `backend-go/internal/httpserver/skills_routes_test.go` | Added stub implementations to `cannedSkillsService` |

---

## What diverged, and why

1. **T4: DELETE uses `force` flag rather than manifest.** Known-safe contents: `SKILL.md` + subdirectories `scripts/`, `references/`, `assets/`. Any other file/dir returns HTTP 422 listing unexpected entries; `?force=true` overrides.
2. **`ErrUnexpectedFiles` maps to HTTP 422 (Unprocessable Entity)** rather than 409. 409 is reserved for attempts to mutate/delete read-only skills.
3. **`Duplicate` validates target name and preserves non-name/description frontmatter.** Discovered skills with non-compliant names are rejected with HTTP 400 rather than duplicated with invalid names into `~/.agents/skills/`.
4. **`authoring_test.go` is maintained as a dedicated test file** in `package skills_test` for modularity and readability.

---

## How it was verified

```bash
# Backend build
cd backend-go && go build ./...  # exit 0

# Unit tests
go test ./internal/skills/... ./internal/api/skills/... ./internal/httpserver/... -count=1

# Meta guards
cd ../tests && go test ./suites/meta/... -count=1 -v -run "TestWritableRootGuard|TestRouteCoverageGuard"

# Criterion 1 backend skills suite
go run ./cmd/amirotest run --surface backend --feature skills
# Result: PASSED · 49 passed · 0 failed · 0 skipped · 20.7s (budget: 60s)

# Full test suite run
go run ./cmd/amirotest run
# Result: PASSED · 319 passed · 0 failed · 18 skipped · 3m 52s
```

---

## Exit criteria

Quoted character-for-character from `docs/skills/phases/phase-04-authoring-api.md`:

1. **"1. `amirotest run --surface backend --feature skills` passes in under 60s."**  
   ✅ **Met.** Measured execution duration: **20.7s** (49 passed / 0 failed / 0 skipped).

2. **"2. A test asserts `POST /api/skills` then `GET /api/skills` returns the new skill in the same test, with no sleep and no cache flush call."**  
   ✅ **Met.** Verified by `TestSkills_Create_ThenListShowsImmediately` in `authoring_test.go` with cache pre-warming.

3. **"3. A test table asserts **every** invalid name shape is rejected, traversal and symlink escape included, and that a rejection never creates a directory."**  
   ✅ **Met.** Verified by `TestSkills_Create_InvalidNameTable` in `authoring_test.go` and `TestSkills_Authoring_TraversalAndSymlinkEscapeRejected` in `escape_test.go`.

4. **"4. A test asserts `PUT` on a skill discovered in `~/.claude/skills/` returns 409 with `.claude` named in the body, and that the file on disk is byte-identical afterwards."**  
   ✅ **Met.** Verified by `TestSkills_Update_ReadOnlySkillReturns409` in `authoring_test.go`.

5. **"5. A test asserts a description containing a colon survives write→read unchanged."**  
   ✅ **Met.** Verified by `TestSkills_Create_ColonDescriptionRoundTrips` in `authoring_test.go` via YAML serialization.

6. **"6. `go test ./suites/meta/... -v` passes with the writable-root guard, and a mutation test proves the guard fails when a write bypasses the helper."**  
   ✅ **Met.** Verified by `TestWritableRootGuard_WriteSkillMDCalledOnlyFromService` and `TestWritableRootGuard_IsNonVacuous` in `writable_root_guard_test.go` (mutation probe documented in verification log).

7. **"7. `amirotest run` is green overall, `suites/meta` included, with every skip reasoned."**  
   ✅ **Met.** Full suite result: **319 passed, 0 failed, 18 skipped** across all 6 surfaces (`meta`, `backend`, `tui`, `ui`, `cross`, `desktop`). All 18 skips correspond to standard environment tags (`slow`, `live`, missing cargo for desktop).

---

## Follow-ups surfaced

- **Adjacent Phase 0 Discovery Bug in `scan.go`:** In `internal/skills/scan.go` (`walkRoot`), line 164 skips entries where `!entry.IsDir()`. Since `fs.DirEntry.IsDir()` returns `false` for symlinks, the symlink evaluation logic on lines 175–188 is unreachable dead code. Flagged for decision on dedicated remediation.
- Phase 5 (Skills section UI) is unblocked and can build on these authoring endpoints.
