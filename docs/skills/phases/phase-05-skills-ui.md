# Phase 5 — The Skills section, and Generate with AI

**Depends on:** 4 · **Blocks:** 6 · **Size:** L

**Surfaces touched:** web · desktop · backend

This phase will replace the Agents section of the dashboard with a Skills
section — the same layout, cards and interaction the Agents pages already
have, transposed onto skills — and add a Generate-with-AI dialog that drafts
a `SKILL.md` for review. After it lands, the user's "Create Agent" entry
points are gone from the UI and "Create Skill" takes their place; the agent
*backend* still exists until Phase 6.

## What already exists

- `src/app/(chat)/agents/page.tsx` (a client page reading only
  `useSession()`), `src/app/(chat)/agent/` for the detail view, and
  `src/components/agent/`: `agents-list.tsx` (title + create button + create
  card with `BackgroundPaths` + `ShareableCard` grid + shared section),
  `edit-agent.tsx` (the form), `generate-agent-dialog.tsx` (the
  `experimental_useObject` flow against `/api/agent/ai` with `SelectModel`
  and ⌘↵ submit), plus `agent-icon-picker.tsx`, `agent-tool-selector.tsx`,
  `agent-dropdown.tsx`.
- `src/components/layouts/app-sidebar-agents.tsx` and `app-sidebar.tsx` for
  navigation.
- `handleErrorWithToast` (`src/components/ui/shared-toast.tsx:18`), `notify.confirm`,
  `safe`/`ts-safe`, `useSWR` + `fetcher` — the patterns `agents-list.tsx`
  already uses, reused as-is.
- `AgentsPage`/`AgentDetailPage` page objects in `tests/ui/pages/index.ts`
  and `tests/ui/specs/agents/`; both are replaced here and deleted in Phase 6.
- Phase 4's write API; Phase 2's `use-skills` hook and palette.
- `POST /api/ai/generate-object` and `/api/agent/ai` show the streaming-object
  handler shape on the Go side.

## Deliverables

### 1. Routes and components (the transposition)

| From | To |
|---|---|
| `src/app/(chat)/agents/page.tsx` | `src/app/(chat)/skills/page.tsx` |
| `src/app/(chat)/agent/` (`?id=`) | `src/app/(chat)/skill/` (`?name=`, `?name=new`) |
| `components/agent/agents-list.tsx` | `components/skill/skills-list.tsx` |
| `components/agent/edit-agent.tsx` | `components/skill/edit-skill.tsx` |
| `components/agent/generate-agent-dialog.tsx` | `components/skill/generate-skill-dialog.tsx` |
| `components/layouts/app-sidebar-agents.tsx` | `components/layouts/app-sidebar-skills.tsx` |
| icon picker · tool selector · agent dropdown | not carried over |

- **Skills list:** the same card grid and create card. Each card shows name,
  description, a **source badge** (`.agents` / `.claude` / `.codex` /
  `.amiro`), a scope badge (project / user) and a lock icon when read-only.
  Grouped **My skills** (writable) and **Discovered** (read-only), which is
  the honest analogue of the current mine/shared split.
- **Editor:** name (disabled on edit — the directory name is the identity),
  description with a live character count against the 1024 cap, and a
  markdown body editor. Read-only skills open disabled with the owning tool
  named and a **Duplicate to my skills** button wired to Phase 4's endpoint.
  Field-scoped validation errors from the API attach to their inputs;
  portability warnings render as non-blocking hints.
- **Delete** through `notify.confirm`, surfacing Phase 4's unexpected-files
  refusal rather than a generic failure.
- Entry points removed here: the `create-agent-button`, the
  `create-agent-card`, and the sidebar's Agents item.

### 2. Generate with AI

- `POST /api/skills/generate` in `internal/api/skills` — a streaming object
  handler returning `{ name, description, body }`, prompted with the spec's
  own rules (name charset, "what **and** when" for `description`, a body
  under ~500 lines pushing detail into `references/`).
- `generate-skill-dialog.tsx`: the same `experimental_useObject` +
  `backendFetch` + `SelectModel` + ⌘↵ shape as the agent dialog, filling the
  editor form as the object streams.
- **The model drafts; the user saves.** Nothing reaches disk except through
  `POST /api/skills` and its validator. The generated object is validated
  client-side before it populates the form so an invalid name is a field
  error, not a 400 on save.

### 3. i18n and standards

`messages/en.json` is the source of truth and **all seven locale files** are
updated in the same phase. Tokens not raw colours, `cn()`/`cva`, lucide
icons, SWR for reads, `handleErrorWithToast` for failures, `data-testid` on
everything a spec touches. Static export: no route handlers, no server
actions, no `next/headers`, no server-side `redirect()`.

### 4. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| web | `tests/ui/specs/skills/` (extended) | The Skills page lists writable and read-only skills in their own sections with source badges · create → appears in the list → appears in the `/` palette without a reload · validation error attaches to the field (bad name, over-long description) · a read-only skill opens disabled, names its owner, and Duplicate produces an editable copy · delete confirms then removes · Generate fills the form and the user still has to save (fake provider) · a generated invalid name shows a field error · the `create-agent-button` and `create-agent-card` no longer exist anywhere |
| backend | `tests/suites/backend/skills/` (extended) | `POST /api/skills/generate` streams a valid object against the fake provider · a malformed model response is a clean error, not a panic · the generate route writes nothing to disk (asserted by scanning the writable root before and after) |
| desktop | `tests/suites/desktop/skills/` (extended) | Creating a skill inside the packaged app writes under the sidecar's `$HOME` and is listed afterwards |
| cross | `tests/suites/cross/skills/` (extended) | A skill created in the dashboard is offered by the TUI's `/` palette in the same run — the end-to-end parity claim |
| meta | `tests/suites/meta/` | The route-coverage guard picks up the three new routes automatically; a waiver would be a failure of this phase, not a resolution |

Page objects: `SkillsPage`, `SkillDetailPage`, `GenerateSkillDialog` in
`tests/ui/pages/index.ts`. `data-testid`s: `skills-title`,
`create-skill-button`, `create-skill-card`, `skill-card`,
`skill-card-source-<source>`, `skill-card-lock`, `skill-name-input`,
`skill-description-input`, `skill-body-textarea`, `skill-save-button`,
`skill-duplicate-button`, `skill-delete-button`,
`skill-generate-prompt-textarea`, `skill-generate-submit-button`.

**Deliberately not covered:** editing bundled `scripts/`, `references/` or
`assets/` from the UI — v1 authors `SKILL.md` only, and the skill directory
is a directory the user can open. Sharing/visibility/bookmarking a skill, a
non-goal since a skill is a local file rather than a shared record.

### 5. Docs

`docs/skills/04-surfaces.md`'s mapping table gets its shipped note;
`README.md`'s feature list; `tests/README.md`'s spec count and its stale
"Not built yet" section.

## Exit criteria

1. `amirotest run --surface ui --feature skills` passes in under 2 minutes.
2. A spec creates a skill through the form and asserts it appears in the list
   **and** in the `/` palette without a page reload.
3. A spec asserts a read-only `.claude` skill opens disabled, names
   `.claude`, and that Duplicate yields an editable copy under **My skills**.
4. A spec asserts a bad name produces a field-level error and that no skill
   was created (verified through `GET /api/skills`, not through the DOM).
5. A spec asserts Generate populates the form and that nothing is written
   until Save is pressed.
6. A spec asserts `[data-testid="create-agent-button"]` and
   `[data-testid="create-agent-card"]` match zero elements anywhere in the
   app.
7. `amirotest run --surface cross --feature skills` asserts a
   dashboard-created skill reaches the TUI palette.
8. `pnpm check` is clean; all seven locale files carry the new keys.
9. `amirotest run` is green overall, `suites/meta` included, with every skip
   reasoned.

## Risks

- **This phase deletes UI a passing test suite depends on.**
  `tests/ui/specs/agents/` and the `AgentsPage`/`AgentDetailPage` page
  objects exercise the create-agent entry points this phase removes.
  Mitigation: this phase updates those specs to the extent the agent detail
  view still exists, and Phase 6 deletes them with the feature. Whichever
  specs are removed here are named in the progress record — a silently
  deleted test is indistinguishable from a test that never existed.
- **A large body in a plain `<textarea>`** is a poor markdown editing
  experience and may tempt a heavy editor dependency. Mitigation: v1 is a
  textarea with a character/line count; a richer editor is a follow-up, and
  the phase says so instead of quietly scope-creeping.
- **The transposition is a rename-heavy diff** where a missed import or a
  stale route leaves a dead page. Mitigation: exit criterion 6 asserts the
  old entry points are gone by `data-testid`, and `pnpm check` catches the
  imports.

## Open questions

None.
