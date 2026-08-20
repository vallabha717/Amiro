# 00 — Overview

## Goal

Amiro learns Agent Skills. A skill is a directory holding a `SKILL.md`
file: YAML frontmatter (`name`, `description`) plus markdown instructions.
Amiro will **discover** skills already on the machine — including ones
Claude Code and Codex installed — **disclose** them cheaply to the model,
**activate** them on demand, let the user **invoke** one by typing `/` in
the composer, and let the user **author** new ones from the dashboard,
optionally drafted by a model.

This is not an Amiro-specific format. `SKILL.md` is an open standard
([agentskills.io](https://agentskills.io)) that Claude Code, Codex, Cursor,
Gemini CLI, Copilot, OpenCode, Goose and ~40 other clients already read;
`.agents/skills/` is the cross-client directory convention that standard's
own client-implementation guide recommends scanning. See
[reference/agent-skills-standard.md](reference/agent-skills-standard.md)
for the researched details and sources. Amiro follows the standard rather
than inventing a parallel one, which is the whole reason a skill written
for Claude Code works here with no conversion.

## Surfaces in scope

All four, and the plan says per phase which one it touches:

| Surface | What skills mean there |
|---|---|
| **backend** (`backend-go/`) | Discovery, parsing, precedence, the catalog in the system prompt, the activation tool, and the authoring API. Every other surface is a client of this. |
| **web** (`src/`, via `amiro serve`) | `/` palette in the composer, and the Skills section that replaces the Agents section. |
| **desktop** (Tauri) | The same exported bundle as web, talking to the sidecar. No Tauri-specific code — but the sidecar resolves `$HOME` inside the packaged app, which is a real difference worth one test. |
| **terminal** (`backend-go/internal/tui/`) | Skills join the `/` palette that already exists in `internal/tui/component/editor/slash.go`. |

## Principles

1. **The standard is the contract.** Frontmatter fields, name rules, the
   three-tier progressive-disclosure model and the `.agents/skills/`
   convention come from the spec, not from us. Where Amiro needs something
   the spec does not define (which directories to scan, how to break a name
   collision), it follows the published client-implementation guidance and
   records the choice in `README.md`'s decisions section.
2. **Discovery is read-mostly; writing is narrow.** Amiro reads from four
   directory families across two scopes. It writes to exactly one:
   `~/.agents/skills/`. It never rewrites a file another tool owns.
3. **One list, no duplicates.** The same skill reachable from two paths
   appears once, with a deterministic winner and a recorded shadow. This is
   a product requirement, not an implementation detail: a `/` palette that
   shows `code-review` three times is broken.
4. **Progressive disclosure or nothing.** Name + description at session
   start (~50–100 tokens each); the body only on activation; bundled
   resources only when the body references them. Dumping every skill body
   into the system prompt would defeat the point of the feature.
5. **Skill text is untrusted input.** A `SKILL.md` is instructions from
   disk that will be handed to a model. Project-scoped skills come from
   whatever repository the user pointed at. Treated accordingly — see
   [03-authoring-and-safety.md](03-authoring-and-safety.md).
6. **Surface parity is asserted, not assumed.** The dashboard and the TUI
   must show the same skill set for the same user and project. That is a
   `tests/suites/cross/` test, because two green single-surface tests do
   not prove it.

## Non-goals

- **A skill marketplace, registry, or installer.** No fetching skills from
  a URL, no `amiro skill install`. Discovery is local filesystem only.
  A cloud/sandboxed discovery path is explicitly out of scope.
- **Sandboxed script execution.** A skill may bundle `scripts/`; Amiro will
  list them and let the model read them, but running them goes through the
  existing terminal tool and its existing permission modes. No new
  execution primitive, no new approval flow.
- **Claude Code's frontmatter extensions.** `context: fork`,
  `argument-hint`, `arguments`, `$ARGUMENTS` substitution, `model`,
  `effort`, `user-invocable`, dynamic bash injection: parsed-and-ignored,
  not implemented. Amiro honours the six spec fields (`name`,
  `description`, `license`, `compatibility`, `metadata`, `allowed-tools`)
  plus `disable-model-invocation`, which is the one extension worth having
  because the alternative is a manual-only workflow firing on its own.
- **`.claude/commands/*.md`.** Claude Code merged commands into skills and
  still reads that legacy directory. Amiro does not. Recorded as a
  follow-up, not a phase.
- **Nested and ancestor project directories.** v1 scans the selected
  project directory only, not every ancestor up to the git root and not
  `packages/*/.agents/skills/`. Monorepo support is a follow-up.
- **Migrating existing agents into skills.** Agents are being removed
  (Phase 6), not converted. Anything currently saved as an agent is lost
  when that phase lands; that was decided deliberately.
- **A trust dialog.** Amiro has no workspace-trust concept and this plan
  does not add one. Project scope is limited to the directory the user
  explicitly selected in the project picker, which is the trust gesture.
