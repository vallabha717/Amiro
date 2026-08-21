# 04 — The surfaces

Settled here: what `/` does in each composer, how the Agents UI becomes the
Skills UI, and what parity between surfaces means concretely.

## Parity matrix

| Capability | backend | web | desktop | terminal |
|---|---|---|---|---|
| Discover + dedupe | owns it | consumes | consumes | consumes |
| Catalog in system prompt | owns it | — | — | — |
| `skill()` activation tool | owns it | sees the event | sees the event | sees the event |
| `/` palette | — | ✅ Shipped (Phase 2) | ✅ Shipped (Phase 2, same bundle) | ✅ Shipped (Phase 3) |
| Create / edit / delete | owns it | Phase 5 | Phase 5 (same bundle) | **no** |
| Generate with AI | owns it | Phase 5 | Phase 5 | **no** |

**Answering the open question directly: yes, the TUI gets `/` skills — and
it is the cheap half.** `internal/tui/component/editor/slash.go` already
implements a `/` palette with prefix filtering, `Suggest`/`Parse`/
`RenderSuggestions` and Tab-accept, wired into `page/chat.go`'s
`composerSuggestions`. Skills become entries in that existing list. The TUI
does **not** get authoring: a form with a name, a description and a
multi-hundred-line markdown body is a bad fit for a Bubble Tea composer, and
`~/.agents/skills/` is a directory the user can open in their editor. The
TUI reads and invokes; the dashboard authors.

## Web — the `/` palette

The composer is `src/components/prompt-input.tsx` → `chat-mention-input.tsx`
→ `mention-input.tsx`, a Tiptap editor whose `Mention` extension already
takes a `suggestionChar` (default `"@"`). Skills need a **second**
suggestion source, not a replacement.

- A second extension instance (`Mention.extend({ name: "skillMention" })`)
  with `char: "/"` and its own suggestion plugin key. Two `Mention`
  extensions with the same plugin key silently break one of them — named as
  a risk in Phase 2.
- **`/` triggers only as the first character of an empty composer.** Mirrors
  `editor.Suggest`, which requires `/` to start the whole input, so the two
  surfaces behave identically and there is no precedence rule to get wrong
  between `/` and `@`. A `/` typed mid-sentence is a slash.
- The palette lists **name · description · source badge**, grouped
  project-then-user, filtered by prefix, keyboard-navigable, capped with a
  "+N more" row. It renders exactly what `GET /api/skills` returned — one
  row per name, because the backend already deduped.
- Selection attaches a chip next to the existing mention chips, removable
  with the same affordance, cleared by Escape with them.
- Fetch on palette open through SWR (`src/hooks/queries/use-skills.ts`),
  keyed on the project directory so switching projects re-reads.

> **Shipped in Phase 2 (2026-08-21):** Implemented `src/components/chat/skill-palette.tsx` and custom `skillSuggestion` Tiptap extension in `mention-input.tsx`. Selection directly deletes the `/query` range and calls `addMention({ type: "skill", name, description })` with Lucide `Sparkles` icon chip rendering. Tool stripping bug (Trap 2) resolved so default tools are preserved when only skills are attached. Verified with 9 UI Playwright specs and desktop sidecar coverage (see [`progress/phase-02-web-palette.md`](progress/phase-02-web-palette.md)).

## Web — Skills section (replacing Agents)

The decision was to keep the UI shape and transpose it, so the mapping is
one-to-one and the visual language does not change:

| Agents today | Becomes |
|---|---|
| `src/app/(chat)/agents/page.tsx` | `src/app/(chat)/skills/page.tsx` |
| `src/app/(chat)/agent/` (detail) | `src/app/(chat)/skill/` — `?name=` instead of `?id=` |
| `components/agent/agents-list.tsx` | `components/skill/skills-list.tsx` — same card grid, same create card, plus a source badge and a read-only lock |
| `components/agent/edit-agent.tsx` | `components/skill/edit-skill.tsx` — name, description, body editor; drops tools/icon/visibility |
| `components/agent/generate-agent-dialog.tsx` | `components/skill/generate-skill-dialog.tsx` — same `experimental_useObject` flow |
| `agent-icon-picker`, `agent-tool-selector`, `agent-dropdown` | deleted; skills have no icon, no tool bindings, no per-agent dropdown |
| `ShareableCard` visibility/bookmark actions | dropped in v1 — a skill is a local file, not a shared record. Non-goal |
| sidebar `app-sidebar-agents.tsx` | `app-sidebar-skills.tsx` |

Standards that apply without exception (the `ui` skill): tokens not raw
colours, `cn()`/`cva`, lucide icons, `data-testid` on everything a test
touches, `next-intl` with `messages/en.json` as source of truth and **all
seven locales** updated, no route handlers or server actions anywhere near
this (static export), SWR for reads and `handleErrorWithToast` for failures.

## Desktop

No Tauri-specific code: the desktop app loads the same exported bundle and
talks to the sidecar. One real difference deserves a test — the sidecar's
`$HOME` inside the packaged app is what user-scope discovery resolves
against, and the sidecar is built **without** `-tags embedui`
(`src-tauri/build-sidecar.sh`), so it must serve `/api/skills` in an
untagged build.

## Terminal

- `editor.Commands` stays the static list of seven built-ins. Skills arrive
  as a separate dynamic list, loaded at startup next to `loadMentionables`
  in `page/mentions.go` — same degrade-independently pattern, so no skills
  never breaks `/mode`.
- **Built-in names are reserved.** A skill named `export` cannot shadow
  `/export`; it is listed and invoked as `/skill:export`. Deterministic,
  and it means adding a built-in later can never silently steal a user's
  skill.
- Palette rendering groups built-ins first, then skills under a heading, so
  a machine with 40 skills does not bury `/mode`.
- `/skills` lists everything discovered with source and scope — the TUI's
  answer to "what did it find and where".
- Selection sets a pending skill for the next turn and shows it in the
  status line, alongside how pending mentions already work.
