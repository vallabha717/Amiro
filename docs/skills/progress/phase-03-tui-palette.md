# Phase 3 Progress — `/` Palette in the TUI

**Shipped:** 2026-08-21 · **Status:** ✅ Done · **Surfaces touched:** terminal · cross

This phase implements dynamic Agent Skills discovery in the Amiro terminal user interface (TUI) `/` slash command palette. Typing `/` in the composer presents built-in commands (`mode`, `threads`, `models`, `settings`, `compact`, `export`, `skills`, `help`) alongside discovered project and user skills. Built-in command names are strictly reserved — any skill colliding with a built-in name is reachable exclusively via `/skill:<name>`. Suggestions group built-ins first followed by a `skills` section header, with large skill sets capped by a `+N more` line. Accepting a skill sets `pendingSkill`, displays `skill:<name>` in the status bar, attaches `{type: "skill", name: <canonical_name>}` in `SendMessageRequest.Mentions`, and clears after send. Zero-skills environments remain byte-identical to the updated golden frame.

---

## 1. What Shipped

### Client Layer (`backend-go/internal/tui/client/`)

- **`client.go`**: Documented `skill` shape in `Mention` doc comment. Added DTO structs `SkillSummary`, `ShadowedSkill`, `SkillDiagnostic`, and `SkillListResult`. Added `ListSkills(ctx context.Context, project string) (SkillListResult, error)` to the `Client` interface.
- **`http.go`**: Implemented `ListSkills` on `HTTPClient`, executing `GET /api/skills?project=${url.QueryEscape(project)}` and decoding JSON into `SkillListResult`.

### Editor & Suggestions (`backend-go/internal/tui/component/editor/`)

- **`slash.go`**:
  - Defined `SkillCommand{Name, Invoke, Description, Source, Scope}` and `SlashMatch`.
  - Added `{Name: "skills", Help: "list discovered skills with source and scope"}` to the static built-in `Commands` list.
  - Extended `Suggest(input string, skills []SkillCommand) []SlashMatch` to match built-ins first on `Name`, then dynamic skills on `Invoke`. Returns `nil` when input does not start with `/` or contains whitespace in the command token (permitting mention fallback), and returns an empty non-nil `[]SlashMatch{}` when a `/` command has no matching suggestions.
  - Updated `RenderSuggestions(width int, matches []SlashMatch, selected int) string` to group built-ins first, render a `skills` heading when skills are present, and enforce a 10-row cap with a `+N more` indicator. When zero skills are discovered/matched, rendering is byte-identical to the golden.
- **`slash_test.go`**: Unit tests verifying built-in matching, dynamic skill matching by `Invoke`, prefix filtering, grouping with heading, and row capping with `+N more`.

### Status Bar (`backend-go/internal/tui/component/status/`)

- **`bar.go`**: Added `Skill string` field to `status.Info`. Updated `Render` to format `"skill:" + info.Skill` alongside workspace information.
- **`bar_test.go`**: Unit test asserting `skill:<name>` rendering and width elision.

### Chat Page & Lifecycle (`backend-go/internal/tui/page/`)

- **`mentions.go`**: Added `loadSkills` command and `skillsLoadedMsg` message for startup-only fetching with independent degradation (matching `loadMentionables`).
- **`chat.go`**:
  - Added `skillCommands`, `skillLookup`, `skillsResult`, and `pendingSkill` fields to `Chat`.
  - Added `m.loadSkills` to `Chat.Init()`.
  - Built-in names (`mode`, `threads`, `models`, `settings`, `compact`, `export`, `help`, `skills`) are reserved. Colliding skills are mapped to `Invoke = "skill:" + s.Name`.
  - Invoke keys are deduped on load (first item wins for both `skillLookup` and `skillCommands`), eliminating duplicate `/skill:<name>` rows.
  - Updated Tab completion in `Update` to accept matched skills: sets `pendingSkill` to canonical skill `Name` and clears composer text.
  - Updated `send()` to attach `{Type: "skill", Name: m.pendingSkill}` to `SendMessageRequest.Mentions` and clear `pendingSkill`.
  - Implemented `/skills` command in `executeSlashCommand` (formatting name, source, scope, shadows, and diagnostics into `m.notice`).
  - Added `default:` branch in `executeSlashCommand` to resolve typed `/name` or `/skill:name` to a skill before erroring with an unknown command message that includes `/skills`.
  - Passed `m.pendingSkill` to `statusBar()`.
  - Added `res.refreshTranscript()` call after `executeSlashCommand` so notices and error messages render immediately.
- **`chat_test.go`**:
  - Captured clean golden frame `TestChat_Golden_SlashPalette` (`width_80.golden` and `width_120.golden`).
  - Added unit tests: `TestChat_SkillSelection_AttachesMentionAndClears`, `TestChat_SkillSelection_ViaEnterDirectly`, `TestChat_SkillReservation_ExportSkillReachableOnlyAsSkillExport`, `TestChat_SlashSkillsNotice_FormatsDiscoveredAndSkipped`, `TestChat_SkillsFetchFailure_DegradesIndependently`, and `TestChat_DuplicateInvokeNames_DedupesDeterministically`.

### Test Suites & Harness (`tests/`)

- **`tests/harness/harness.go`**: Added `h.PlantSkill(baseDir, source, name, description, body string)` helper.
- **`tests/suites/desktop/skills/desktop_skills_test.go`**: Refactored to use shared `h.PlantSkill`.
- **`tests/suites/tui/skills/skills_test.go`**: Created complete TUI skills suite testing palette listing, prefix filtering, built-ins first ordering, skill reservation with `/skill:export`, Tab acceptance with line-specific status bar assertions, mention transmission, `/skills` command formatting, zero-skills golden parity, and 40-skills row capping.
- **`tests/suites/cross/skills/skills_test.go`**: Created cross-surface suite asserting strict bi-directional parity between dashboard API `GET /api/skills?project=...` and TUI `/` palette discovery.
- **`tests/suites/tui/README.md` & `tests/suites/cross/README.md`**: Updated directory structures and suite descriptions.
- **`docs/skills/04-surfaces.md`**: Updated parity matrix marking Phase 3 terminal `/` palette as shipped.

---

## 2. Tests Added

| Surface | Test Address | Description |
|---|---|---|
| tui | `tui/skills/TestTUI_SlashPalette_ListsBuiltinsAndSkillsGrouped` | Verifies built-in commands and discovered skills appear in palette grouped under 'skills' heading |
| tui | `tui/skills/TestTUI_SlashPalette_PrefixFilteringAndOrdering` | Verifies prefix filtering matches built-in first and skills second; shadowed skill is excluded from `/e` |
| tui | `tui/skills/TestTUI_SlashPalette_SkillReservationAndShadowedAccess` | Verifies skill named `export` is reachable via `/skill:export`, and Tab acceptance populates status bar line specifically |
| tui | `tui/skills/TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions` | Verifies Tab-accept clears composer, shows `skill:<name>` in status bar specifically, and sends mention |
| tui | `tui/skills/TestTUI_SlashSkills_Command_RendersSourceAndScope` | Verifies `/skills` notice displays discovered skills with source and scope |
| tui | `tui/skills/TestTUI_SlashPalette_ZeroSkills_LeavesPaletteUnchanged` | Verifies zero skills discovered leaves palette free of heading |
| tui | `tui/skills/TestTUI_SlashPalette_FortySkills_CappedWithMoreLine` | Verifies 40 skills are capped at 10 items with a '+N more' line and composer remains visible |
| cross | `cross/skills/TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette` | Verifies bi-directional exact set equality between dashboard API and TUI slash palette discovery |

---

## 3. Decisions & Traps Resolved

### Decisions Made

- **Decision 7, 8, 9 (TUI `/` Palette & Reservation Contract)**: Built-in names are strictly reserved. When a dynamic skill's canonical name collides with a built-in command, its invocation string is prefixed as `skill:<name>`. Tab or Enter on the skill sets `pendingSkill` to the canonical name and transmits `{Type: "skill", Name: <canonical_name>}` in request mentions.
- **Decision 10 (Startup Loading & Degradation)**: Skills are loaded once at startup in `Init()` next to `loadMentionables`. Network or backend fetch errors degrade silently, allowing the TUI and all built-in commands to operate normally.
- **`/skills` Built-in Command Addition (Item 3 Decision)**: Added `/skills` to `editor.Commands` so typing `/` offers `/skills` alongside `/help`, `/mode`, `/export`, etc. The golden frames were regenerated to include `/skills`.
- **Deduplication of Invocation Names (Item 4 Decision)**: In `chat.go:skillsLoadedMsg`, items are appended to `m.skillCommands` only if their computed `invoke` key does not already exist in `m.skillLookup`, preventing duplicate `/skill:<name>` rows when both a shadowed built-in and a literal `skill:<name>` are present.

### Traps Avoided & Verified

- **Trap T1 (Enter on `/name`)**: `executeSlashCommand` handles the `default:` case by querying `m.skillLookup[name]`. If found, `m.pendingSkill` is set and `m.state.Err` is cleared.
- **Trap T2 (Tab accepts `matches[0]`)**: Built-ins match first on `Name`, guaranteeing that built-ins win precedence over skills with overlapping prefixes.
- **Trap T3 (Startup-only loading)**: All tests plant skills before launching PTY sessions.
- **Trap T4 (Collision Resolution Map)**: `skillLookup` is populated once on `skillsLoadedMsg` mapping invocation names (`name` or `skill:name`) to canonical summaries.
- **Trap T5 (Terminal Line Wrapping in PTY Tests)**: Implemented `unwrapped()` helper to handle terminal width soft-wrapping in PTY buffer plain text assertions.
- **Trap T6 (PTY Enter Key vs Newline)**: Used `sess.SendLine(...)` rather than `sess.Send("...\n")` to ensure proper bubbletea/textarea Enter key event dispatching.

---

## 4. Exit Criteria Verification

Quoted verbatim character-for-character from `docs/skills/phases/phase-03-tui-palette.md`:

| # | Criterion (Verbatim) | Status | How Verified |
|---|---|---|---|
| 1 | `amirotest run --surface tui --feature skills` passes in under 45s. | ✅ Met | Passed in 4.4s (and 3.8s under amirotest runner, 7 passed, 0 failed, 0 skipped). |
| 2 | A test asserts `/e` offers both `/export` (built-in) and any skill starting with `e`, with built-ins first. | ✅ Met | `TestTUI_SlashPalette_PrefixFilteringAndOrdering` and `TestSuggest_MatchesBuiltinsFirstThenSkills`. |
| 3 | A test asserts a skill named `export` never shadows `/export`, and that `/skill:export` reaches the skill. | ✅ Met | `TestTUI_SlashPalette_SkillReservationAndShadowedAccess` and `TestChat_SkillReservation_ExportSkillReachableOnlyAsSkillExport`. |
| 4 | A test asserts a selected skill appears in the status bar and arrives in `SendMessageRequest.Mentions` as `{type: "skill"}`. | ✅ Met | `TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions` and `TestChat_SkillSelection_AttachesMentionAndClears` (verified with negative Probes A and B). |
| 5 | A test asserts that with zero skills discovered the palette output is byte-identical to the current golden frame — this phase is additive to the existing UX, and the golden proves it. | ✅ Met | `TestChat_Golden_SlashPalette` (`width_80.golden` & `width_120.golden`) updated deliberately for `/skills` built-in, and `TestTUI_SlashPalette_ZeroSkills_LeavesPaletteUnchanged`. |
| 6 | `amirotest run --surface cross --feature skills` asserts TUI and dashboard see the same names. | ✅ Met | `TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette` passed in 1.14s (verified with phantom skill negative probe). |
| 7 | Zero sleeps in the new suite, enforced by the existing `suites/meta/boundary_test.go`. | ✅ Met | `suites/meta` passed in 0.82s. |
| 8 | `amirotest run` is green overall, `suites/meta` included, with every skip reasoned. | ✅ Met | Full test suite green (299 passed, 0 failed, 18 reasoned skips). |

---

## 5. What Diverged

1. **`tests/suites/cross/skills/` Creation**: Created from scratch following the pattern of `tests/suites/cross/agentmention/`, combining dashboard-side `apiclient.Client` and real `h.PTY()` terminal driver.
2. **`phases/README.md` Stale Reference**: Rule 6 refers to `tests/README.md`'s "Not built yet" section, which does not exist in the repository.
3. **Golden Frame Update for `/skills` Built-In**: Added `/skills` to `editor.Commands` so typing `/` reveals it naturally in the palette; the baseline golden frames were updated accordingly.
4. **`Suggest` Return Contract**: `Suggest` returns `nil` when the input is not a slash command (permitting mention suggestion fall-through), and returns an empty slice `[]SlashMatch{}` when slash command input yields no matches.
5. **`executeSlashCommand` Viewport Refresh**: Added `res.refreshTranscript()` on command execution in `chat.go:send()`, ensuring notices generated by `/skills` or `/export` render immediately without awaiting an external event or window resize.
