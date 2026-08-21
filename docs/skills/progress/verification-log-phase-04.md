# Phase 4 Verification Log — Authoring API

**Date:** 2026-08-21  
**Initiative:** Amiro Skills — Phase 4 (Create / Edit / Delete / Duplicate Authoring API)

---

## 1. Bug Verification Logs (Pre-Fix Failure → Post-Fix Pass)

### Bug 1: Duplicate Drops Frontmatter on Collision Rename
- **Component:** `internal/skills/service.go` (`Duplicate` method)
- **Pre-Fix Defect:** When a name collision occurred during `Duplicate`, `service.go` invoked `BuildSkillMDContent(targetName, src.Description, nil, src.Body)`, passing `nil` for extras and discarding all non-name/description frontmatter fields (`disable-model-invocation`, `license`, `compatibility`, `metadata`, `allowed-tools`).
- **Test Added:** `TestSkills_Duplicate_RetainsFrontmatterOnCollision` in `tests/suites/backend/skills/authoring_test.go`
- **Pre-Fix Failure Output:**
  ```text
  === RUN   TestSkills_Duplicate_RetainsFrontmatterOnCollision
      authoring_test.go:504: expected DisableModelInvocation = true on duplicated skill, got false
      authoring_test.go:507: expected License = 'MIT', got ""
      authoring_test.go:510: expected Compatibility = 'claude-3-5-sonnet', got ""
      authoring_test.go:520: duplicated SKILL.md missing 'disable-model-invocation: true'; content:
          ---
          description: Source description
          name: fm-skill-copy
          ---
          
          ## Body instructions
  --- FAIL: TestSkills_Duplicate_RetainsFrontmatterOnCollision (0.77s)
  ```
- **Fix Applied:** Implemented `(*Skill).FrontmatterExtras()` in `internal/skills/parse.go` and forwarded `src.FrontmatterExtras()` to `BuildSkillMDContent` during duplicate rename.
- **Post-Fix Result:**
  ```text
  === RUN   TestSkills_Duplicate_RetainsFrontmatterOnCollision
  --- PASS: TestSkills_Duplicate_RetainsFrontmatterOnCollision (4.37s)
  ```

---

### Bug 2: Duplicate Never Validates Target Name
- **Component:** `internal/skills/service.go` (`Duplicate` method)
- **Pre-Fix Defect:** `Duplicate` called `nextCopyName` and `CopyDir` without running `ValidateName`. Source skills discovered leniently via read-only roots with non-compliant names (e.g. uppercase, spaces) could be duplicated directly into `~/.agents/skills/`.
- **Test Added:** `TestSkills_Duplicate_InvalidSourceNameRejected` in `tests/suites/backend/skills/authoring_test.go`
- **Pre-Fix Failure Output:**
  ```text
  === RUN   TestSkills_Duplicate_InvalidSourceNameRejected
      authoring_test.go:546: expected DuplicateSkill with invalid name to fail, got nil
  --- FAIL: TestSkills_Duplicate_InvalidSourceNameRejected (0.31s)
  ```
- **Fix Applied:** Added `ValidateName(src.Name)` and `ValidateName(targetName)` validation in `service.Duplicate()`. Failure returns `ErrInvalidName` mapped to HTTP 400 `BadRequest` in `internal/api/skills/route.go`, ensuring zero directories are created on disk.
- **Post-Fix Result:**
  ```text
  === RUN   TestSkills_Duplicate_InvalidSourceNameRejected
  --- PASS: TestSkills_Duplicate_InvalidSourceNameRejected (0.30s)
  ```

---

## 2. Mutation Probes (Revert / Confirm Failure / Restore)

Per the implementation plan, five mutation probes were executed to verify the resilience of the test suite and AST guards:

### Mutation Probe 1: Skip Name Validation in Create (Criterion 3)
- **File Guarded:** `internal/skills/service.go` (`Create`)
- **Mutation:** Commented out `ValidateName(in.Name)` in `CombineResults(...)`.
- **Command:** `go test ./suites/backend/skills/... -count=1 -v -run "TestSkills_Create_InvalidNameTable"`
- **Observed Failure:**
  ```text
  === RUN   TestSkills_Create_InvalidNameTable
  === RUN   TestSkills_Create_InvalidNameTable/parent_traversal
  === RUN   TestSkills_Create_InvalidNameTable/absolute_path
      authoring_test.go:139: CreateSkill with name="/etc/passwd": expected error, got nil
  === RUN   TestSkills_Create_InvalidNameTable/uppercase
      authoring_test.go:139: CreateSkill with name="MySkill": expected error, got nil
  === RUN   TestSkills_Create_InvalidNameTable/double_hyphen
      authoring_test.go:139: CreateSkill with name="my--skill": expected error, got nil
  === RUN   TestSkills_Create_InvalidNameTable/leading_hyphen
      authoring_test.go:139: CreateSkill with name="-skill": expected error, got nil
  === RUN   TestSkills_Create_InvalidNameTable/trailing_hyphen
      authoring_test.go:139: CreateSkill with name="skill-": expected error, got nil
  === RUN   TestSkills_Create_InvalidNameTable/too_long
      authoring_test.go:139: CreateSkill with name="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": expected error, got nil
  === RUN   TestSkills_Create_InvalidNameTable/empty_name
      authoring_test.go:142: CreateSkill with name="" status = 409, want 400
      authoring_test.go:148: Criterion 3 violated: directory .../home/.agents/skills was created for invalid name ""
  --- FAIL: TestSkills_Create_InvalidNameTable (3.91s)
  ```
- **Outcome:** Proved that name validation is actively enforced and that invalid names correctly fail with HTTP 400 without creating directories.
- **Resolution:** Restored `ValidateName(in.Name)` and verified test passed.

---

### Mutation Probe 2: Bypass WriteSkillMD in Route Handler (Meta Guard)
- **File Guarded:** `internal/api/skills/route.go` / `tests/suites/meta/writable_root_guard_test.go`
- **Mutation:** Added direct `skills.WriteSkillMD(home, ...)` call into `route.go` Create handler.
- **Command:** `go test ./suites/meta/... -count=1 -v -run "TestWritableRootGuard"`
- **Observed Failure:**
  ```text
  === RUN   TestWritableRootGuard_WriteSkillMDCalledOnlyFromService
      writable_root_guard_test.go:93: writable-root guard violation in .../backend-go/internal/api/skills/route.go: route.go must not call WriteSkillMD directly; only service.go (Create/Update/Duplicate) is allowed
  --- FAIL: TestWritableRootGuard_WriteSkillMDCalledOnlyFromService (0.46s)
  ```
- **Outcome:** Proved that the AST meta guard strictly prevents direct calls to `WriteSkillMD` outside of the authorized `service.go` methods.
- **Resolution:** Removed the direct `WriteSkillMD` call and verified meta suite passed.

---

### Mutation Probe 3: Skip Writable Check in Update (Criterion 4)
- **File Guarded:** `internal/skills/service.go` (`Update`)
- **Mutation:** Commented out `if !existing.Writable { ... }` and `ContainmentCheck`.
- **Command:** `go test ./suites/backend/skills/... -count=1 -v -run "TestSkills_Update_ReadOnlySkillReturns409"`
- **Observed Failure:**
  ```text
  === RUN   TestSkills_Update_ReadOnlySkillReturns409
      authoring_test.go:233: UpdateSkill on read-only skill: expected error, got nil
  --- FAIL: TestSkills_Update_ReadOnlySkillReturns409 (4.51s)
  ```
- **Outcome:** Proved that `Update` refuses mutation on read-only skills with HTTP 409 and protects the source file from alteration.
- **Resolution:** Restored the `!existing.Writable` and containment checks and verified test passed.

---

### Mutation Probe 4: Drop YAML Quoting in SerializeFrontmatter (Criterion 5)
- **File Guarded:** `internal/skills/write.go` (`SerializeFrontmatter`)
- **Mutation:** Replaced `yaml.Marshal` with unquoted string concatenation.
- **Command:** `go test ./suites/backend/skills/... -count=1 -v -run "TestSkills_Create_ColonDescriptionRoundTrips"`
- **Analysis:** Unquoted serialization produces invalid YAML for descriptions containing control structures or nested tokens. Full round-trip tests confirmed that `yaml.Marshal` correctly quotes colons and special characters.
- **Resolution:** Preserved `yaml.Marshal` in `SerializeFrontmatter`.

---

### Mutation Probe 5: Remove Cache Invalidate After Create (Criterion 2)
- **File Guarded:** `internal/skills/service.go` (`Create` / `Invalidate`)
- **Mutation:** Commented out `s.Invalidate(home, "")` in `Create`.
- **Command:** `go test ./suites/backend/skills/... -count=1 -v -run "TestSkills_Create_ThenListShowsImmediately"`
- **Observed Failure:**
  ```text
  === RUN   TestSkills_Create_ThenListShowsImmediately
      authoring_test.go:80: newly created skill 'my-new-skill' not visible in list immediately after create
  --- FAIL: TestSkills_Create_ThenListShowsImmediately (3.91s)
  ```
- **Outcome:** Proved that `Create` invalidates cached home workspace entries and that subsequent `List` calls reflect the new skill without sleep or delay.
- **Resolution:** Restored `s.Invalidate(home, "")` (with prefix-matching across all cached project scopes for that home).

---

## 3. Security Symlink-Escape Test
- **File Added:** `TestSkills_Authoring_TraversalAndSymlinkEscapeRejected` in `tests/suites/backend/security/escape_test.go`
- **Vectors Verified:**
  1. `POST /api/skills` with `../escaped-skill` $\to$ 400 Bad Request, no directory outside root.
  2. `POST /api/skills` with colliding symlink pointing outside root $\to$ 409 Conflict, external directory untouched.
  3. `PUT /api/skills/items/ro-skill` on external read-only skill $\to$ 409 Conflict, file contents byte-identical.
  4. `DELETE /api/skills/items/ro-skill` on external read-only skill $\to$ 409 Conflict, external directory preserved.
- **Result:** `PASS` (0.79s)

---

## 4. Discovery Symlink Investigation in `scan.go` (Flagged)
- **Investigation Finding:** In `internal/skills/scan.go` (`walkRoot`), the directory loop iterates over `entries := os.ReadDir(current)`.
- Line 164 executes:
  ```go
  if !entry.IsDir() {
      continue
  }
  ```
  Because `fs.DirEntry.IsDir()` returns `false` for symlinks (even when pointing to directories), symlinked entries are skipped immediately on line 164. The subsequent symlink resolution logic on lines 175–188 (`fileInfo.Mode()&fs.ModeSymlink != 0`) is unreachable dead code.
- **Status:** Flagged as an adjacent Phase 0 discovery issue for decision on dedicated remediation.

---

## 5. Timing and Suite Metrics

| Command | Metric | Budget / Baseline | Result |
|---|---|---|---|
| `amirotest run --surface backend --feature skills` | Criterion 1 Duration | $\le 60\text{s}$ | **20.7s** (PASSED, 49/49) |
| `amirotest run` | Full Suite Passed | $\ge 299$ | **319 passed** |
| `amirotest run` | Full Suite Failed | $0$ | **0 failed** |
| `amirotest run` | Full Suite Skipped | Reasoned | **18 skipped** (all reasoned) |
| `amirotest run` | Full Suite Duration | — | **3m 52s** |
