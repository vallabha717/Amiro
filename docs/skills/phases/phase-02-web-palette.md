# Phase 2 — `/` palette in the web composer

**Depends on:** 1 · **Blocks:** 6 · **Size:** M

**Surfaces touched:** web · desktop

This phase will make typing `/` in the dashboard composer open a list of
every skill on the machine — deduped, grouped by scope, labelled with its
source — and make selecting one attach it to the next message. It ships to
the browser via `amiro serve` and to the desktop app from the same exported
bundle; there is no desktop-specific code, only a desktop test.

## What already exists

- `src/components/prompt-input.tsx` owns the composer, the mention chips
  (line 419 onward), the Escape-clears-mentions handler (line 390) and the
  `mentions` array sent with each turn.
- `src/components/chat-mention-input.tsx` builds the `@` candidate list from
  `appStore` (agents, MCP servers and tools, workflows, default tools) and
  renders it.
- `src/components/mention-input.tsx` is the Tiptap wrapper. It already takes
  a `suggestionChar` prop (line 64, default `"@"`) passed into the `Mention`
  extension's `suggestion.char` (line 123) — one extension, one trigger.
  A second trigger needs a second extension instance, not a prop change.
- `src/lib/backend/skills-api.ts` and `src/types/skill.ts` exist from
  Phase 0; the `skill` mention member exists from Phase 1.
- `tests/ui/support/fixtures.ts` starts a per-test backend with its own
  `HOME`, and `tests/ui/pages/index.ts` holds the page objects. There is no
  skills page object yet.

## Deliverables

### 1. The palette

- `src/hooks/queries/use-skills.ts` — SWR read of `GET /api/skills`, keyed on
  the active project directory so switching projects re-reads, fetched on
  palette open rather than at app start.
- A second Tiptap extension, `Mention.extend({ name: "skillMention" })`,
  with `char: "/"`, its own `pluginKey`, and its own suggestion renderer.
- **Trigger rule:** only when `/` is the first character of an empty
  composer. Matches `editor.Suggest` in the TUI, so the two surfaces cannot
  disagree, and a `/` mid-sentence stays a `/`.
- `src/components/chat/skill-palette.tsx` — rows of **name · description ·
  source badge**, grouped project-then-user, prefix-filtered, arrow-key and
  Enter/Tab navigable, Escape closes, capped with a "+N more" row. Renders
  the API's list verbatim: no client-side dedup.
- Empty and error states: "No skills found — create one" linking to the
  Skills page (which arrives in Phase 5; until then the link target is the
  agents-shaped route and the phase says so), and a failure that goes through
  `handleErrorWithToast`.

### 2. Selection and the chip

- A selected skill becomes a chip beside the existing mention chips, with the
  same remove affordance, cleared by the same Escape handler.
- Sent as `{ type: "skill", name }` in the existing `mentions` array — no new
  request field.
- Standards: tokens not raw colours, `cn()`/`cva`, lucide icons,
  `data-testid` on every row and chip, `next-intl` strings added to
  `messages/en.json` **and all seven locale files**. No route handler, no
  server action, no `next/headers` — the export forbids all three.

### 3. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| web | `tests/ui/specs/skills/` | `/` on an empty composer opens the palette; `/` mid-sentence does not · a skill planted in four directories appears **once** · project and user skills are grouped and badged · prefix typing filters · arrow keys + Enter select · Escape closes without selecting · selection renders a chip and the chip is removable · sending includes the skill and the reply reflects it (fake provider) · empty state on a machine with no skills · `@` mentions still work with `/` registered — the regression that matters |
| desktop | `tests/suites/desktop/skills/` (extended) | The palette's data path works against the untagged sidecar, `$HOME` resolved inside the packaged app |
| cross | `tests/suites/cross/skills/` | The set of names the palette shows equals the set `GET /api/skills` returns for the same user and project — the dashboard does not filter or reorder behind the API's back |
| meta | `tests/suites/meta/` | Existing `ui_guard_test.go` already fails the build on `page.waitForTimeout`/`setTimeout` in the new specs; no new guard needed, and the phase states that rather than adding a redundant one |

`data-testid`s `src/` must add: `skill-palette`, `skill-palette-item-<name>`,
`skill-palette-source-<source>`, `skill-palette-empty`, `skill-chip-<name>`,
`skill-chip-remove-<name>`.

Page objects: a `SkillPalette` class in `tests/ui/pages/index.ts`, so the
specs never hold raw selectors.

**Deliberately not covered:** the visual appearance of the palette beyond
the existing `tests/ui/specs/visual/` conventions — no new screenshot
baselines, because a list of rows is not where visual regression pays for
itself.

### 4. Docs

`docs/skills/04-surfaces.md` shipped note; `tests/README.md`'s spec count.

## Exit criteria

1. `amirotest run --surface ui --feature skills` passes in under 90s.
2. A spec asserts the palette shows exactly one row for a skill planted in
   `.agents`, `.amiro`, `.claude` and `.codex`, and that the row's badge says
   `.agents`.
3. A spec asserts `/` mid-sentence inserts a literal `/` and opens nothing.
4. A spec asserts an existing `@`-mention flow still selects an MCP tool with
   the skill extension registered — no plugin-key collision.
5. `amirotest run --surface cross --feature skills` asserts palette names
   equal API names for the same user and project.
6. A desktop test asserts `GET /api/skills` answers from the untagged
   sidecar build.
7. `pnpm check` is clean (biome + tsc).
8. `amirotest run` is green overall, `suites/meta` included, with every skip
   reasoned.

## Risks

- **Two Tiptap `Mention` extensions can silently break each other.** Sharing
  a plugin key makes one trigger stop firing with no error. Mitigation: a
  distinct `pluginKey`, and exit criterion 4 exists specifically to catch it
  in CI rather than in use.
- **The palette fetch on open adds latency to a keystroke.** Mitigation: SWR
  cache plus the backend's `(home, project)` cache; the spec asserts the
  palette is visible without a hardcoded wait, which is also what the meta
  guard enforces.
- **The empty state links to a page that does not exist until Phase 5.**
  Mitigation: stated here, and the link is feature-flagged off until Phase 5
  lands rather than pointing at a 404.

## Open questions

None.
