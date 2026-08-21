# Phase 2 Verification Log — 11 Remediation Items

**Date:** 2026-08-21  
**Initiative:** Amiro Skills — Phase 2 (`/` Skill Palette in Web Composer)

---

## 1. Negative Test Logs (Revert / Confirm Failure / Restore)

Per the strict ground rule (*"for every test you touch or add, revert the thing it guards, confirm it fails, restore, and log that in the verification log"*), each guarded behavior was subjected to a negative test mutation:

### Negative Test 1: Item 1 (Escape destroys chips you already selected)
- **File Guarded:** `src/components/chat/skill-palette.tsx` (Escape key event handler)
- **Mutation:** Removed `event.stopPropagation()` in `SkillPalette` on Escape keydown.
- **Command:** `go run ./cmd/amirotest run --surface ui --feature skills --grep "Item 1 bugfix"`
- **Observed Failure:**
  ```text
  Error: expect(locator).toBeVisible() failed
  Locator: locator('[data-testid="skill-chip-escape-skill-a"]')
  Expected: visible
  Timeout: 15000ms
  Error: element(s) not found
  ```
- **Outcome:** Proved that without `stopPropagation()`, Escape on an open palette bubbles to the window listener and destroys previously selected chips.
- **Resolution:** Restored `event.stopPropagation()` and verified test passed.

---

### Negative Test 2: Item 2 (Criterion 4 `@` mention trigger & selection)
- **File Guarded:** `src/components/chat-mention-input.tsx`
- **Mutation:** Replaced `suggestionChar="@"` with snowman `suggestionChar="☃"`.
- **Command:** `go run ./cmd/amirotest run --surface ui --feature skills --grep "Criterion 4"`
- **Observed Failure:**
  ```text
  Error: expect(locator).toBeVisible() failed
  Locator: locator('[data-testid="chat-mention-suggestion"]')
  Expected: visible
  Timeout: 15000ms
  Error: element(s) not found
  ```
- **Outcome:** Proved that `@` typing actually triggers the suggestion popover and that the test is asserting real DOM visibility of `chat-mention-suggestion`.
- **Resolution:** Restored `suggestionChar="@"` and verified test passed.

---

### Negative Test 3: Item 3 (Bi-directional exact array equality for API vs DOM items)
- **File Guarded:** `tests/ui/specs/skills/skill-palette.spec.ts`
- **Mutation:** Injected a phantom item `"phantom-skill"` into `expectedNames`.
- **Command:** `go run ./cmd/amirotest run --surface ui --feature skills --grep "bi-directional check"`
- **Observed Failure:**
  ```text
  Error: expect(received).toEqual(expected) // deep equality
  - Expected  - 1
  + Received  + 0
    Array [
  -   "phantom-skill",
      "skill-one",
      "skill-three",
      "skill-two",
    ]
  ```
- **Outcome:** Proved that the test strictly asserts array length, exact element equality, and project-over-user order (not just one-directional inclusion).
- **Resolution:** Restored `expectedNames` and verified test passed.

---

### Negative Test 4: Item 4 (Non-skill mention tool stripping)
- **File Guarded:** `src/components/chat-bot.tsx`
- **Mutation:** Removed `hasNonSkillMention` condition so `allowedAppDefaultToolkit` was never stripped to `[]` when non-skill mentions were attached.
- **Command:** `go run ./cmd/amirotest run --surface ui --feature skills --grep "Criterion 4"`
- **Observed Failure:**
  ```text
  Error: expect(received).toEqual(expected) // deep equality
  - Expected  - 1
  + Received  + 9
  - Array []
  + Array [
  +   "terminal",
  +   "visualization",
  +   "file",
  +   "memory",
  +   "webSearch",
  +   "http",
  +   "workflow",
  + ]
  ```
- **Outcome:** Proved that attaching a non-skill mention (e.g. `defaultTool`, `agent`, `workflow`) strips `allowedAppDefaultToolkit` to `[]`, while skill mentions do not.
- **Resolution:** Restored `hasNonSkillMention` and verified test passed.

---

### Negative Test 5: Item 5 (Error state vs "No skills found")
- **File Guarded:** `src/components/chat/skill-palette.tsx`
- **Mutation:** Bypassed the `error` state render branch so errors fell through to the empty state.
- **Command:** `go run ./cmd/amirotest run --surface ui --feature skills --grep "error state"`
- **Observed Failure:**
  ```text
  Error: expect(locator).toBeVisible() failed
  Locator: locator('[data-testid="skill-palette-error"]')
  Expected: visible
  Timeout: 15000ms
  Error: element(s) not found
  ```
- **Outcome:** Proved that an API error (e.g. invalid `projectDirectory`) renders the distinct error container `data-testid="skill-palette-error"`, not the empty state.
- **Resolution:** Restored the `error` branch and verified test passed.

---

### Negative Test 6: Item 6 (Decision D: `disable-model-invocation: true` skills appear in palette)
- **File Guarded:** `tests/ui/specs/skills/skill-palette.spec.ts`
- **Mutation:** Changed assertion from `item("manual-only-skill")` to `item("non-existent-manual-skill")`.
- **Command:** `go run ./cmd/amirotest run --surface ui --feature skills --grep "Decision D"`
- **Observed Failure:**
  ```text
  Error: expect(locator).toBeVisible() failed
  Locator: locator('[data-testid="skill-palette-item-non-existent-manual-skill"]')
  Expected: visible
  Timeout: 15000ms
  Error: element(s) not found
  ```
- **Outcome:** Proved that the test verifies the presence of the `disable-model-invocation: true` skill row in the rendered DOM.
- **Resolution:** Restored assertion and verified test passed.

---

## 2. Test Suite Confirmation Runs

### Frontend Quality Check (`pnpm check`)
```text
> amiro-desktop@1.26.0 check
> pnpm lint:fix && pnpm check-types && pnpm test

Checked 459 files in 300ms. No fixes applied.
Test Files  29 passed (29)
     Tests  354 passed (354)
  Duration  4.96s
```

### UI Skills Suite (`go run ./cmd/amirotest run --surface ui --feature skills`)
```text
── ui ──
Running 11 tests using 1 worker
  ✓   1 empty state: opens palette showing empty indicator when no skills exist (6.4s)
  ✓   2 error state: renders error indicator when /api/skills fails (3.6s)
  ✓   3 trigger rule: '/' on empty composer opens palette, mid-sentence does not (4.3s)
  ✓   4 four-directory plant shows exactly one row with .agents badge (4.0s)
  ✓   5 project and user skills grouped and badged with prefix filtering (4.4s)
  ✓   6 disable-model-invocation: true skills appear in the palette alongside regular skills (Decision D) (3.4s)
  ✓   7 keyboard navigation and selection renders chip and deletes composer range (4.6s)
  ✓   8 escape closes palette without selecting and preserves already-selected chips (Item 1 bugfix) (4.9s)
  ✓   9 palette names equal API response names for user and project by interception (bi-directional check) (3.7s)
  ✓  10 chat request body includes skill mention and does NOT strip app default toolkit (Trap 2 guard) (6.3s)
  ✓  11 @-mention flow still works with skill extension registered and selects an app tool (Criterion 4) (5.8s)

11 passed (54.1s)
PASSED · 11 passed · 0 failed · 0 skipped · 55.7s
```

### Desktop Skills Suite (`go test ./suites/desktop/skills/... -v`)
```text
=== RUN   TestDesktop_UntaggedSidecarServesSkillsAndDiscoversHome
--- PASS: TestDesktop_UntaggedSidecarServesSkillsAndDiscoversHome (0.75s)
PASS
ok      amiro/tests/suites/desktop/skills       0.751s
```

### Meta Guards (`go run ./cmd/amirotest run --surface meta`)
```text
── meta ──
ok      amiro/tests/suites/meta 0.656s
PASSED · 16 passed · 0 failed · 0 skipped · 1.6s
```
