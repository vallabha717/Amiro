# Phase 3 — `/` palette in the TUI

**Depends on:** 1 · **Blocks:** 6 · **Size:** S

**Surfaces touched:** terminal

This phase will put skills into the `/` palette the TUI composer already
has, with built-in command names reserved so a skill can never shadow
`/mode` or `/export`, and a `/skills` command that says what was found and
where. Small, because the palette, its filtering, its rendering and its
Tab-accept already exist — this phase adds a second, dynamic source to them.

## What already exists

- `backend-go/internal/tui/component/editor/slash.go`: `SlashCommand`, the
  static `Commands` list of seven built-ins (`mode`, `threads`, `models`,
  `settings`, `compact`, `export`, `help`), `Suggest` (prefix match, only
  while the first word has no trailing space, `nil` for anything not
  starting with `/`), `Parse`, and `RenderSuggestions`.
- `internal/tui/page/chat.go`: `composerSuggestions` (line 281) shows the
  slash palette or the mention palette and can never show both;
  `executeSlashCommand` (line 391) dispatches by name and reports an unknown
  command inline rather than sending `/frobnicate` to the model;
  `acceptSlashSuggestion` implements top-match Tab-accept;
  `pendingMentions` is the per-turn attachment mechanism this phase mirrors.
- `internal/tui/page/mentions.go`: `loadMentionables` fetches candidates at
  startup with each category degrading independently — the pattern for
  loading skills.
- `internal/tui/client/client.go`: `SendMessageRequest` carries `Mentions`;
  `client.Mention` gained a `skill` type in Phase 1.
- `tests/suites/tui/palette/` already tests the slash palette;
  `internal/tui/page/testdata/` holds golden frames.

## Deliverables

### 1. Skills in the palette

- `editor.SkillCommand` (name, description, source) and a dynamic list held
  by `page.Chat`, loaded at startup alongside `loadMentionables` — a failed
  fetch means "no skills", never a broken `/mode`.
- `editor.Suggest` extended to take the dynamic list, matching built-ins
  first, then skills. Built-in names are **reserved**: a skill named
  `export` is offered as `/skill:export`, and a test asserts `/export` still
  exports.
- `RenderSuggestions` groups built-ins, then a `skills` heading, so 40
  skills do not bury `/mode`. Capped rows with a "+N more" line.
- Theme and key handling stay centralised in `internal/tui/theme` and
  `internal/tui/keys` — no ad-hoc styles or key literals in the palette.

### 2. Selection and `/skills`

- Accepting a skill sets a pending skill for the next turn, shown in the
  status bar (`component/status/bar.go`) next to the workspace, and sent as
  a `skill` mention in `SendMessageRequest.Mentions`.
- `/skills` prints the discovered list with name, source and scope, and the
  count of anything skipped with a reason — the terminal's answer to "what
  did it find, and where".
- An unresolvable pending skill reports inline through the existing
  `m.state.Err` path.

### 3. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| terminal | `tests/suites/tui/skills/` | `/` lists built-ins **and** skills, grouped · prefix filtering narrows both · Tab accepts the top match · a skill named `export` does not shadow `/export` and is reachable as `/skill:export` · selection shows in the status bar and reaches the request · `/skills` renders source and scope · zero skills leaves the palette exactly as it is today · a fetch failure still leaves `/mode` working |
| cross | `tests/suites/cross/skills/` (extended) | The TUI's palette and the dashboard's palette list the same names for the same user and project — the parity claim, asserted rather than assumed |
| meta | `tests/suites/meta/` | No new guard. `boundary_test.go` already fails the build on `time.Sleep` in the new suite, and the PTY driver's `WaitForText`/`WaitForStable` are the only synchronisation permitted |

Golden frames for the grouped palette go in
`internal/tui/page/testdata/`, following the existing convention.

**Deliberately not covered:** authoring from the TUI — a name, a
description and a multi-hundred-line markdown body do not belong in a Bubble
Tea form, and `~/.agents/skills/` is a directory the user can open in their
own editor. Recorded in [00-overview](../00-overview.md)'s non-goals.

### 4. Docs

`backend-go/internal/tui/README.md` (if present) and
`docs/skills/04-surfaces.md`; `tests/suites/tui/README.md`'s feature list.

## Exit criteria

1. `amirotest run --surface tui --feature skills` passes in under 45s.
2. A test asserts `/e` offers both `/export` (built-in) and any skill
   starting with `e`, with built-ins first.
3. A test asserts a skill named `export` never shadows `/export`, and that
   `/skill:export` reaches the skill.
4. A test asserts a selected skill appears in the status bar and arrives in
   `SendMessageRequest.Mentions` as `{type: "skill"}`.
5. A test asserts that with zero skills discovered the palette output is
   byte-identical to the current golden frame — this phase is additive to
   the existing UX, and the golden proves it.
6. `amirotest run --surface cross --feature skills` asserts TUI and
   dashboard see the same names.
7. Zero sleeps in the new suite, enforced by the existing
   `suites/meta/boundary_test.go`.
8. `amirotest run` is green overall, `suites/meta` included, with every skip
   reasoned.

## Risks

- **The PTY emulator's known rendering-fidelity gap** (`harness/pty/buffer.go`
  — repaints accumulate, long rows hard-wrap mid-token, diagnosed in
  `docs/testing` Phase 7) already flakes two TUI/cross tests, and a grouped
  multi-row palette is exactly the shape that provokes it. Mitigation: assert
  on `WaitForText` of specific rows rather than whole-frame goldens wherever
  a row could wrap, keep one narrow golden for the grouping order, and note
  in the progress record if the gap bites — do not paper over it with
  `run.retries`, which currently masks it in a default run.
- **A skill list long enough to fill the viewport** would hide the composer.
  Mitigation: hard row cap with a "+N more" line, asserted by a test at 40
  skills.

## Open questions

None.
