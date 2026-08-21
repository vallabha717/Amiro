# Progress

What has actually been built, as opposed to what is planned. The
[phases](../phases/README.md) hold the intent; this folder holds the
record — dated, with real numbers, and honest about what diverged.

**Last updated:** 2026-08-21 (Phase 4 shipped)

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 0 | Discovery core + read API | ✅ Done — 2026-08-20 | [phase-00-discovery.md](phase-00-discovery.md) |
| 1 | Disclosure, activation tool, skill mentions | ✅ Done — 2026-08-20 | [phase-01-activation.md](phase-01-activation.md) |
| 2 | `/` palette in the web composer | ✅ Done — 2026-08-21 | [phase-02-web-palette.md](phase-02-web-palette.md) |
| 3 | `/` palette in the TUI | ✅ Done — 2026-08-21 | [phase-03-tui-palette.md](phase-03-tui-palette.md) |
| 4 | Authoring API | ✅ Done — 2026-08-21 | [phase-04-authoring-api.md](phase-04-authoring-api.md) |
| 5 | Skills section + Generate with AI | ⬜ Not started — blocked on 4 | — |
| 6 | Decommission agents | ⬜ Not started — blocked on 2, 3, 5 | — |

Each phase's verification log holds the commands used to check it against a
real running system, with their output, so any claim here can be re-checked
rather than taken on trust.

## What works today

- **Discovery and read API (Phase 0):** Amiro discovers Agent Skills across eight scan roots (`.agents`, `.amiro`, `.claude`, `.codex` in project and user scopes). Lenient frontmatter parsing with scalar quoting retry is active. Project-over-user precedence and same-scope source order ties are resolved. Real-path and normalized-name deduplication are active with shadowing diagnostics. The API is exposed at `GET /api/skills` and `GET /api/skills/items/{name}` behind session authentication. The typed TypeScript client and types exist in `src/lib/backend/skills-api.ts` and `src/types/skill.ts`.
- **Disclosure, Activation & Mentions (Phase 1):** Tier 1 `<available_skills>` catalog is injected into the system prompt with 1024-character description limits, location, and `disable-model-invocation` exclusion. Tier 2 `skill(name)` tool with dynamically typed parameter enum, YAML frontmatter stripping, `<skill_content>` formatting, and per-turn deduplication is active. Read-only workspace sandbox roots (`ResolveReadable`) allow safe traversal into active skill bundled resources while strictly prohibiting modifying tools from escaping the project root. `{type: "skill", name}` mentions inject full skill content prior to the first model call. Skill instructions are preserved during context compaction, and subagents can dynamically load skills.
- **Web Composer `/` Palette (Phase 2):** Typing `/` as the first character of an empty composer opens the skill palette. Skills are fetched from `GET /api/skills` on palette open (SWR keyed by active `projectDirectory`). Palette groups project skills above user skills, displays source badges (`.agents`, `.amiro`, `.claude`, `.codex`), filters by prefix in real time, and supports full keyboard navigation (arrows, Enter/Tab, Escape). Selecting a skill removes `/query` from the composer, attaches a `{ type: "skill", name, description }` chip with a Lucide `Sparkles` icon, and preserves default tools on send. Works seamlessly in both browser and desktop Tauri sidecar.
- **TUI `/` Command Palette (Phase 3):** Typing `/` in the terminal composer lists built-in commands alongside dynamically discovered project and user skills. Built-in names (`mode`, `threads`, `models`, `settings`, `compact`, `export`, `help`, `skills`) are reserved; skills colliding with a built-in are reachable via `/skill:<name>`. Suggestions group built-ins first, then a `skills` section header, with lists capped at 10 rows using a `+N more` line. Tab/Enter sets `pendingSkill`, displays `skill:<name>` in the status bar, and attaches `{type: "skill", name: <canonical_name>}` in request mentions. `/skills` outputs discovered and skipped skill details into notices. Zero-skills environments remain byte-identical to the baseline golden.

## What does **not** exist yet

- **Nothing can be written.** No create, edit, delete or duplicate; nothing
  validates a `SKILL.md` on write; `~/.agents/skills/` is not written to yet. (Phase 4.)
- **There is no Skills page and no Generate-with-AI for skills.** The
  Agents page, its create button, its create card and its
  Generate-Agent dialog are all still live. (Phase 5.)
- **Agents are still fully present** — routes, table, `@agent` mentions on
  three surfaces, `<core_capabilities>` in the system prompt, and their
  test suites. (Phase 6.)
- **No filesystem watcher**, no `.claude/commands/` support, no monorepo
  ancestor/nested scanning, no `allowed-tools` enforcement, no skill
  marketplace. Recorded as non-goals in
  [00-overview.md](../00-overview.md), not as gaps to be closed silently.

## Next up — Phase 4

With Phases 0, 1, 2, and 3 complete:
- [Phase 4](../phases/phase-04-authoring-api.md) (authoring API: create/edit/delete with validation and cache invalidation) is now the primary unblocked focus.

## How to update this folder

When a phase ships, add `phase-NN-<slug>.md` and
`verification-log-phase-NN.md` here recording:

1. **What shipped** — files created and modified, with line counts, and a
   Tests Added table per surface.
2. **What diverged from the plan, and why.** The most valuable section and
   the one most likely to be skipped. A plan written before the code always
   gets something wrong; the record of *what* and *why* is what stops the
   next person re-litigating a decision already made with better
   information.
3. **How it was verified** — commands and their real output, not assertions
   that it works.
4. **Exit criteria**, checked off against the phase doc's own list.
5. **Follow-ups surfaced** — things found along the way that belong to a
   later phase.

Then update the status table above, and mark the phase doc itself.
