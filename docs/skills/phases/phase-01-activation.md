# Phase 1 — Disclosure, the activation tool, and skill mentions

**Depends on:** 0 · **Blocks:** 2, 3, 6 · **Size:** M

**Surfaces touched:** backend

This phase will make a discovered skill actually change a model's behaviour.
It will add the tier-1 catalog to the system prompt, an `skill()` tool that
returns a body on demand, an additional read-only file-tool root so bundled
resources are readable without widening the workspace sandbox, and
resolution of a `skill` mention so a user-selected skill is injected before
the first model call. After this phase the feature works end to end with no
UI at all — driven by an API request with a mention in it.

## What already exists

- `internal/ai/prompts/prompts.go` builds the system prompt:
  `BuildUserSystemPrompt` (line 64) composes user identity and an optional
  agent persona; `MergeSystemPrompt` (line 269) joins sections; the
  MCP-customizations section (`BuildMcpServerCustomizationsSystemPrompt`) is
  the closest existing precedent for what the catalog will be.
- `internal/api/chat/mentions.go` resolves mentions today: `resolveAgent`
  (an `agent` mention → prompt info), `loadMCPTools`, workflow tools. A
  `skill` mention slots in beside them. `mentionDTO` is the wire shape;
  `src/types/chat.ts:50`'s `ChatMentionSchema` is its discriminated-union
  counterpart, and `client.Mention` (`internal/tui/client/client.go`) the
  TUI's.
- `internal/ai/tools/` holds the tool definitions (`files.go`, `search.go`,
  `terminal.go`, …), all scoped to one `WorkspaceRoot` — the constraint that
  makes a dedicated activation tool necessary rather than optional. See
  [02](../02-activation.md).
- Permission modes (`plan`/`interactive`/`edit`/`auto`) and the approval
  pipeline (`internal/api/chat/approver.go`) already exist; a read-only tool
  needs to opt out of approval, not invent a new mode.
- `internal/skills` from Phase 0 supplies the catalog and the bodies.

## Deliverables

### 1. The catalog

- `prompts.BuildSkillCatalogPrompt([]skills.Summary) string` — the
  `<available_skills>` block plus the short behavioural instruction, merged
  by `MergeSystemPrompt`.
- Omitted entirely when the list is empty. Skills with
  `disable-model-invocation: true` are excluded here and only here.
- Truncation: 1024 chars per description, 256 skills, both reported in the
  turn's events rather than applied silently.

### 2. The `skill` tool

| Item | Covers |
|---|---|
| Definition | `internal/ai/tools/skill.go` — one string parameter, `name`, as an enum built from the discovered set |
| Result | Frontmatter stripped, body wrapped in `<skill_content name="…">`, skill directory stated, bundled resources enumerated (capped at 32, truncation stated), never read eagerly |
| Registration | Only when at least one skill was discovered; absent otherwise |
| Approval | Read-only, auto-approved in every permission mode including `plan`, and a test asserts that |
| Dedup | Activating the same skill twice in one turn returns a short "already active" result instead of a second copy of the body |

### 3. Additional read-only roots for the file tools

- `tools.Toolset` gains `ReadOnlyRoots []string`; `read_file`, `search` and
  the repomap accept a path under `WorkspaceRoot` **or** any read-only root.
  `edit`, `write`, `terminal` and git tools do not.
- Populated with the directories of skills activated this turn — nothing
  else, never `$HOME` wholesale.
- Allowlisted for approval, so a skill bundling three reference files
  produces zero dialogs.

### 4. `skill` mention resolution

- `{ type: "skill", name }` added to `ChatMentionSchema` (`src/types/chat.ts`),
  `mentionDTO` (Go), and `client.Mention` (TUI) — one member, three places,
  so all surfaces speak it before any surface sends it.
- `resolveSkills` in `internal/api/chat/mentions.go`: resolve each name,
  inject the `<skill_content>` block ahead of the first model call, ignore
  `disable-model-invocation` (explicit selection outranks it), and surface an
  unresolvable name as a turn error rather than dropping it.
- One activation event per skill on the existing event stream, so both UIs
  can show which skill shaped an answer.

### 5. Compaction protection

`<skill_content>` blocks are exempt from history trimming and from
`/compact`'s summarisation. A test drives a thread past the compaction
threshold and asserts the block survives.

### 6. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/skills/` (extended) | Catalog present with N skills and absent with zero · `disable-model-invocation` hidden from the catalog but usable via mention · the tool's enum rejects an unknown name · frontmatter stripped and resources listed but unread · read-only root permits `read_file` on `references/x.md` and denies `write` · a path outside both roots is still refused · a `skill` mention injects before the first model call · an unresolvable mention errors visibly · double activation returns "already active" · the block survives compaction · the tool needs no approval in `plan` mode |
| meta | `tests/suites/meta/` | A guard asserting no tool other than the read set accepts a `ReadOnlyRoots` path — the sandbox invariant this phase introduces, and the one most likely to erode |

All of it runs against the harness's **fake provider**: these assertions are
about what reaches the model and what the sandbox allows, so no real
provider traffic and no cassette is needed.

**Deliberately not covered:** whether a model *chooses* the right skill —
that is model behaviour, not a contract, and asserting it would produce a
flaky test that fails on a provider update. The catalog's content is
asserted; the model's judgement is not.

### 7. Docs

`docs/skills/02-activation.md` gets a "shipped" note from `implement`;
`backend-go/README.md`'s tool list gains `skill`.

## Exit criteria

1. `amirotest run --surface backend --feature skills` passes in under 60s.
2. A test asserts the system prompt contains `<available_skills>` with the
   exact name and description of a planted skill, and that the section is
   **absent** when no skills exist.
3. A test asserts `skill("nonexistent")` is rejected by the enum without a
   model round-trip.
4. A test asserts `read_file` succeeds on a file inside an activated skill's
   directory and `write` on the same path is refused.
5. A test asserts a `{ type: "skill" }` mention injects the body before the
   first model call, using the fake provider's recorded request.
6. A test drives a thread through `/compact` and asserts the
   `<skill_content>` block is still present afterwards.
7. `go test ./suites/meta/... -v` passes, new sandbox guard included, proven
   non-vacuous.
8. `amirotest run` is green overall, `suites/meta` included, with every skip
   reasoned.

## Risks

- **Widening the file sandbox is the failure mode of this phase.** A
  `ReadOnlyRoots` that leaks into `edit` or `terminal` silently turns a
  read-only feature into arbitrary local file write. Mitigation: the roots
  are per-tool, not global; the meta guard asserts which tools accept them;
  the test suite asserts the negative case, not just the positive.
- **Catalog cost on a 200-skill machine.** 200 × ~100 tokens is ~20k tokens
  of every turn. Mitigation: the 256 cap, plus a perf assertion recording
  actual catalog size; if it proves too expensive the follow-up is a
  user-facing enable/disable list, which the `disable-model-invocation`
  handling already prefigures.
- **Prompt injection is now a live path.** A project skill can say "ignore
  previous instructions". Mitigation: tags mark it as data, the source is
  labelled in the UI (Phase 2/5), and project scope is limited to a
  directory the user explicitly selected. Stated as accepted residual risk,
  not solved.

## Open questions

- Should an activated skill persist across turns in a thread, or be
  re-activated per turn? v1 re-activates per turn (a mention is per-message,
  as `@`-mentions already are), which is simpler and matches the existing
  model. If it proves annoying in use, a thread-sticky skill is a follow-up —
  decided by whoever first uses this for real work, not now.
