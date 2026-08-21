# Phase 3 Verification Log — TUI Slash Command Palette & Remediation

**Date:** 2026-08-21  
**Initiative:** Amiro Skills — Phase 3 (`/` Palette in the TUI)

---

## 1. Negative Test Logs (Revert / Confirm Failure / Restore)

Per the strict ground rule (*"for every test you touch or add, revert the thing it guards, confirm it fails, restore, and log that in the verification log"*), each guarded behavior was subjected to negative test mutations:

### Negative Test 1: Built-ins First Ordering
- **File Guarded:** `backend-go/internal/tui/component/editor/slash.go` (`Suggest`)
- **Mutation:** Swapped matching loop order so skills match before built-ins.
- **Command:** `go test ./internal/tui/component/editor/... -run TestSuggest_MatchesBuiltinsFirstThenSkills`
- **Observed Failure:**
  ```text
  --- FAIL: TestSuggest_MatchesBuiltinsFirstThenSkills (0.00s)
      slash_test.go:46: matches[0] = {Name:example Invoke:example ... IsSkill:true}, want built-in export
      slash_test.go:49: matches[1] = {Name:echo Invoke:echo ... IsSkill:true}, want skill example
      slash_test.go:52: matches[2] = {Name:export Invoke:export ... IsSkill:false}, want skill echo
  ```
- **Outcome:** Proved that built-ins are strictly matched and sorted ahead of dynamic skills.
- **Resolution:** Restored built-in loop preceding skills loop; test passed.

---

### Negative Test 2: Shadowed Skill Reservation
- **File Guarded:** `backend-go/internal/tui/page/chat.go` (`skillsLoadedMsg`)
- **Mutation:** Bypassed reservation prefixing, assigning `invoke = s.Name` instead of `skill:<name>` for built-in collisions.
- **Command:** `go test ./internal/tui/page/... -run TestChat_SkillReservation_ExportSkillReachableOnlyAsSkillExport`
- **Observed Failure:**
  ```text
  --- FAIL: TestChat_SkillReservation_ExportSkillReachableOnlyAsSkillExport (0.00s)
      chat_test.go:494: pendingSkill = "", want 'export' after typing /skill:export
  ```
- **Outcome:** Proved that colliding skills are reachable only via `/skill:<name>` and built-ins retain exclusive access to un-prefixed commands.
- **Resolution:** Restored reservation check; test passed.

---

### Negative Test 3: Skill Mention Attachment on Send
- **File Guarded:** `backend-go/internal/tui/page/chat.go` (`send()`)
- **Mutation:** Omitted `pendingSkill` from `SendMessageRequest.Mentions` during `send()`.
- **Command:** `go test ./internal/tui/page/... -run TestChat_SkillSelection_AttachesMentionAndClears`
- **Observed Failure:**
  ```text
  --- FAIL: TestChat_SkillSelection_AttachesMentionAndClears (0.00s)
      chat_test.go:435: lastSend.Mentions = [], want [{Type: "skill", Name: "my-skill"}]
  ```
- **Outcome:** Proved that selecting a skill in the palette attaches `{Type: "skill", Name: <canonical_name>}` on the next turn and clears `pendingSkill` afterward.
- **Resolution:** Restored mention attachment; test passed.

---

### Negative Test 4: Zero-Skills Baseline Golden Parity
- **File Guarded:** `backend-go/internal/tui/component/editor/slash.go` (`RenderSuggestions`)
- **Mutation:** Modified the zero-skills branch prefix from `"/"` to `"//"`.
- **Command:** `go test ./internal/tui/page/... -run TestChat_Golden_SlashPalette`
- **Observed Failure:**
  ```text
  --- golden
  +++ run
  @@ -24,7 +24,7 @@
  -/mode plan|interactive|edit|auto  switch permission mode
  +//mode plan|interactive|edit|auto  switch permission mode
  ```
- **Outcome:** Proved that the palette rendering strictly adheres to the golden frame specifications.
- **Resolution:** Restored single slash rendering; test passed.

---

### Negative Test 5: ListSkills Fetch Degradation
- **File Guarded:** `backend-go/internal/tui/page/chat.go` (`skillsLoadedMsg`)
- **Mutation:** Set `m.state.Err = msg.err` when `ListSkills` returned a network error.
- **Command:** `go test ./internal/tui/page/... -run TestChat_SkillsFetchFailure_DegradesIndependently`
- **Observed Failure:**
  ```text
  --- FAIL: TestChat_SkillsFetchFailure_DegradesIndependently (0.00s)
      chat_test.go:550: state.Err = network connection refused, want nil
  ```
- **Outcome:** Proved that failures fetching dynamic skills degrade gracefully without polluting `state.Err` or breaking built-in commands like `/mode`.
- **Resolution:** Restored silent degradation; test passed.

---

### Negative Test 6: Item 1 Probe A (Tab Handler No-Op for Skills)
- **File Guarded:** `backend-go/internal/tui/page/chat.go` (Tab key handler in `Update`)
- **Mutation:** Removed `m.pendingSkill = match.Name; m.input.Reset()` in the skill match branch.
- **Command:** `go run ./cmd/amirotest run --surface tui --feature skills`
- **Observed Failure:**
  ```text
  --- FAIL: TestTUI_SlashPalette_SkillReservationAndShadowedAccess (10.42s)
      skills_test.go:146: status bar line missing 'skill:export': timed out after 10s waiting for frame condition
  --- FAIL: TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions (10.42s)
      skills_test.go:193: status bar line missing 'skill:doc-reader': timed out after 10s waiting for frame condition
  FAILED · 5 passed · 2 failed · 0 skipped · 51.0s
  ```
- **Outcome:** Proved that `TestTUI_SlashPalette_SkillReservationAndShadowedAccess` and `TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions` strictly fail when Tab-accept is a no-op, confirming assertions on the status bar row are non-vacuous.
- **Resolution:** Restored Tab handler logic; tests passed.

---

### Negative Test 7: Item 1 Probe B (Status Bar Skill Rendering Disabled)
- **File Guarded:** `backend-go/internal/tui/component/status/bar.go` (`Render`)
- **Mutation:** Changed line 59 to `if false && info.Skill != ""`.
- **Command:** `go run ./cmd/amirotest run --surface tui --feature skills`
- **Observed Failure:**
  ```text
  --- FAIL: TestTUI_SlashPalette_SkillReservationAndShadowedAccess (10.38s)
      skills_test.go:146: status bar line missing 'skill:export': timed out after 10s waiting for frame condition
  --- FAIL: TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions (10.38s)
      skills_test.go:193: status bar line missing 'skill:doc-reader': timed out after 10s waiting for frame condition
  FAILED · 5 passed · 2 failed · 0 skipped · 50.1s
  ```
- **Outcome:** Proved that the tests fail when the status bar suppresses the skill field.
- **Resolution:** Restored status bar skill rendering; tests passed.

---

### Negative Test 8: Item 2 Probe (Cross-Surface Bi-directional Parity & Phantom Skill Detection)
- **File Guarded:** `backend-go/internal/tui/page/chat.go` (`skillsLoadedMsg`)
- **Mutation:** Injected synthetic skill `cross-phantom-skill` into `m.skillCommands` on startup.
- **Command:** `go test ./suites/cross/skills/... -v`
- **Observed Failure:**
  ```text
  --- FAIL: TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette (11.16s)
      skills_test.go:99: TUI slash palette skills set did not equal dashboard API skills set (expected map[cross-proj-skill:true cross-user-skill:true]): timed out after 10s waiting for frame condition
  ```
- **Outcome:** Proved that `TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette` strictly detects extraneous/phantom skills in the TUI not returned by the dashboard API.
- **Resolution:** Reverted synthetic skill probe; test passed in 1.14s.

---

## 2. Golden Update & Built-in Discoverability (Item 3 Decision)

`/skills` was added to `editor.Commands` (`backend-go/internal/tui/component/editor/slash.go`), completing the eight built-in commands (`mode`, `threads`, `models`, `settings`, `compact`, `export`, `skills`, `help`).

### Golden Frame Diff (`TestChat_Golden_SlashPalette/width_80.golden`):
```diff
 /mode plan|interactive|edit|auto  switch permission mode
 /threads  list, search, resume or delete threads
 /models  pick a provider and model
 /settings  manage AI provider keys
 /compact  compact this thread's history now
 /export  create a shareable export of this thread
+/skills  list discovered skills with source and scope
 /help  show this list
```

---

## 3. Exit Criteria Verification

| # | Exit Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `amirotest run --surface tui --feature skills` passes in under 45s | ✅ Pass | Completed 7 tests in 4.4s (and 3.8s in amirotest runner) |
| 2 | `/e` offers both `/export` (built-in) and skills starting with `e`, built-ins first | ✅ Pass | `TestTUI_SlashPalette_PrefixFilteringAndOrdering` & `TestSuggest_MatchesBuiltinsFirstThenSkills` |
| 3 | Skill named `export` never shadows `/export`, reachable via `/skill:export` | ✅ Pass | `TestTUI_SlashPalette_SkillReservationAndShadowedAccess` & `TestChat_SkillReservation_ExportSkillReachableOnlyAsSkillExport` |
| 4 | Selected skill appears in status bar and arrives in `SendMessageRequest.Mentions` as `{type: "skill"}` | ✅ Pass | `TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions` & `TestChat_SkillSelection_AttachesMentionAndClears` |
| 5 | Zero skills discovered renders byte-identical to golden frame | ✅ Pass | `TestChat_Golden_SlashPalette` (`width_80.golden` & `width_120.golden`, updated for `/skills` built-in) & `TestTUI_SlashPalette_ZeroSkills_LeavesPaletteUnchanged` |
| 6 | `amirotest run --surface cross --feature skills` asserts TUI and dashboard see same names | ✅ Pass | `TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette` passed in 1.14s (bi-directional equality) |
| 7 | Zero sleeps in new suite, enforced by `suites/meta/boundary_test.go` | ✅ Pass | `suites/meta` passed in 0.82s |
| 8 | `amirotest run` green overall with every skip reasoned | ✅ Pass | Full test suite executed with 299 passed, 0 failed, 18 reasoned skips |
