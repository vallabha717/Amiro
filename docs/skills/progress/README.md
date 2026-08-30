# Progress

What has actually been built, as opposed to what is planned. The
[phases](../phases/README.md) hold the intent; this folder holds the
record — dated, with real numbers, and honest about what diverged.

**Last updated:** 2026-08-22 (Phase 6 shipped — the plan is complete)

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 0 | Discovery core + read API | ✅ Done — 2026-08-20 | [phase-00-discovery.md](phase-00-discovery.md) |
| 1 | Disclosure, activation tool, skill mentions | ✅ Done — 2026-08-20 | [phase-01-activation.md](phase-01-activation.md) |
| 2 | `/` palette in the web composer | ✅ Done — 2026-08-21 | [phase-02-web-palette.md](phase-02-web-palette.md) |
| 3 | `/` palette in the TUI | ✅ Done — 2026-08-21 | [phase-03-tui-palette.md](phase-03-tui-palette.md) |
| 4 | Authoring API | ✅ Done — 2026-08-21 | [phase-04-authoring-api.md](phase-04-authoring-api.md) |
| 5 | Skills section + Generate with AI | ✅ Done — 2026-08-22 | [phase-05-skills-ui.md](phase-05-skills-ui.md) |
| 6 | Decommission agents | ✅ Done — 2026-08-22 | [phase-06-decommission-agents.md](phase-06-decommission-agents.md) |

Each phase's verification log holds the commands used to check it against a
real running system, with their output, so any claim here can be re-checked
rather than taken on trust.

## What works today

- **Discovery and read API (Phase 0):** Amiro discovers Agent Skills across eight scan roots (`.agents`, `.amiro`, `.claude`, `.codex` in project and user scopes). Lenient frontmatter parsing with scalar quoting retry is active. Project-over-user precedence and same-scope source order ties are resolved. Real-path and normalized-name deduplication are active with shadowing diagnostics. The API is exposed at `GET /api/skills` and `GET /api/skills/items/{name}` behind session authentication. The typed TypeScript client and types exist in `src/lib/backend/skills-api.ts` and `src/types/skill.ts`.
- **Disclosure, Activation & Mentions (Phase 1):** Tier 1 `<available_skills>` catalog is injected into the system prompt with 1024-character description limits, location, and `disable-model-invocation` exclusion. Tier 2 `skill(name)` tool with dynamically typed parameter enum, YAML frontmatter stripping, `<skill_content>` formatting, and per-turn deduplication is active. Read-only workspace sandbox roots (`ResolveReadable`) allow safe traversal into active skill bundled resources while strictly prohibiting modifying tools from escaping the project root. `{type: "skill", name}` mentions inject full skill content prior to the first model call. Skill instructions are preserved during context compaction, and subagents can dynamically load skills.
- **Web Composer `/` Palette (Phase 2):** Typing `/` as the first character of an empty composer opens the skill palette. Skills are fetched from `GET /api/skills` on palette open (SWR keyed by active `projectDirectory`). Palette groups project skills above user skills, displays source badges (`.agents`, `.amiro`, `.claude`, `.codex`), filters by prefix in real time, and supports full keyboard navigation (arrows, Enter/Tab, Escape). Selecting a skill removes `/query` from the composer, attaches a `{ type: "skill", name, description }` chip with a Lucide `Sparkles` icon, and preserves default tools on send. Works seamlessly in both browser and desktop Tauri sidecar.
- **TUI `/` Command Palette (Phase 3):** Typing `/` in the terminal composer lists built-in commands alongside dynamically discovered project and user skills. Built-in names (`mode`, `threads`, `models`, `settings`, `compact`, `export`, `help`, `skills`) are reserved; skills colliding with a built-in are reachable via `/skill:<name>`. Suggestions group built-ins first, then a `skills` section header, with lists capped at 10 rows using a `+N more` line. Tab/Enter sets `pendingSkill`, displays `skill:<name>` in the status bar, and attaches `{type: "skill", name: <canonical_name>}` in request mentions. `/skills` outputs discovered and skipped skill details into notices. Zero-skills environments remain byte-identical to the baseline golden.
- **Authoring API (Phase 4):** `POST /api/skills`, `PUT /api/skills/items/{name}`, `DELETE /api/skills/items/{name}`, `POST /api/skills/items/{name}/duplicate` are live behind session auth. Every write validates name (charset, length, traversal/symlink-escape rejection), description (non-empty, ≤1024 chars) and frontmatter (unknown-key rejection) before touching disk. `~/.agents/skills/` is the one writable root (`internal/skills/write.go`'s `WritableRoot`, enforced by a `suites/meta` AST guard); everything else is read-only, with `Duplicate` as the escape hatch. Cache invalidation is prefix-based and immediate — a create/update/delete is visible to the next `GET /api/skills` with no sleep.
- **Skills section + Generate with AI (Phase 5):** The dashboard's Skills page (`/skills`, `/skill?name=`) replaces the Agents page on all three web surfaces — a My skills / Discovered card grid with source badges and a read-only lock, a detail editor (name/description/body, field-scoped errors, live portability hints), delete, and Duplicate for read-only skills. `POST /api/skills/generate` drafts `{name, description, body}` via the same `experimental_useObject` pattern agent generation used to. Nothing reaches disk from that route — the model drafts, the user still has to press Save, and a generated invalid name surfaces as a field error rather than a failed save.
- **Decommission agents (Phase 6):** The agent feature is fully removed, not migrated — saved agents were dropped with the table. Backend: `internal/api/agent/`, `internal/db/{models,repository}/agent.go`, the `agent` mention branch (`resolveAgent`, `AgentPromptInfo`, `<core_capabilities>`), and the `agent` table (migration `0024_drop_agent`, both dialects) are gone. `internal/agent/` — the agentic execution loop (session, permission, workspace, memory, lsp, repomap) — is a different, unrelated "agent" and is untouched. Web: `/agent`, `/agents`, `components/agent/`, the sidebar's Agents entry, the `agent` mention type (`ChatMentionSchema`, `chat-mention-input.tsx`, `tool-select-dropdown.tsx`'s `AgentSelector`, voice chat's `agentId`) are all gone; `/agent` and `/agents` now 404 through the export's own not-found page. TUI: `ListAgents`, `MentionAgent`, `AgentMention()` are gone from `@`-completion. Bookmarks: agent was the only item type `CheckItemAccess` ever granted, so `POST /api/bookmark` is now permanently inert (a real, recorded consequence — see [`progress/phase-06-decommission-agents.md`](phase-06-decommission-agents.md)'s follow-ups) rather than a feature quietly removed.

## What does **not** exist yet

- **No filesystem watcher**, no `.claude/commands/` support, no monorepo
  ancestor/nested scanning, no `allowed-tools` enforcement, no skill
  marketplace, no editing of bundled `scripts/`/`references/`/`assets/`
  from the UI, no skill sharing/visibility/bookmarking. Recorded as
  non-goals in [00-overview.md](../00-overview.md), not as gaps to be
  closed silently.

## Next up

All six phases are shipped — this plan is complete. See
[`phase-06-decommission-agents.md`](phase-06-decommission-agents.md)'s
"Known scope boundaries and follow-ups" for what was found along the way
and deliberately left for a later, separate initiative (the now-permanently-inert
bookmark endpoint chief among them).

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
