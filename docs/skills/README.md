# Skills

Amiro learns Agent Skills: `SKILL.md` directories discovered from the
machine (including ones Claude Code and Codex installed), disclosed cheaply
to the model, invoked by typing `/` in any composer, and authored from the
dashboard. The Agents feature has been removed and replaced by this.

`phases/` is intent. [`progress/`](progress/README.md) is reality. They are
separate folders so a confidently-written plan is never mistaken for a
status report.

## Read in order

| # | Document | Settles |
|---|---|---|
| — | [00-overview.md](00-overview.md) | Goal, surfaces in scope, principles, **non-goals** |
| 01 | [01-discovery-and-precedence.md](01-discovery-and-precedence.md) | The eight scan roots, precedence, dedup, lenient parsing, scan bounds, freshness |
| 02 | [02-activation.md](02-activation.md) | The catalog, the `skill()` tool and why a file read will not do, bundled resources, compaction |
| 03 | [03-authoring-and-safety.md](03-authoring-and-safety.md) | Route table, the one writable directory, validation, Generate with AI, the threat table |
| 04 | [04-surfaces.md](04-surfaces.md) | Parity matrix, the web `/` palette, the Agents→Skills UI mapping, the TUI palette, desktop |
| — | [reference/agent-skills-standard.md](reference/agent-skills-standard.md) | The external standard as researched, with sources |
| — | [phases/README.md](phases/README.md) | Dependency graph, phase table, rules for every phase |
| — | [progress/README.md](progress/README.md) | What is actually built |

## Phases

| # | Title | Surfaces | Size | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| [0](phases/phase-00-discovery.md) | Discovery core + read API | backend | M | — | 1, 2, 3, 4 | ✅ Shipped |
| [1](phases/phase-01-activation.md) | Disclosure, activation tool, skill mentions | backend | M | 0 | 2, 3, 6 | ✅ Shipped |
| [2](phases/phase-02-web-palette.md) | `/` palette in the web composer | web · desktop | M | 1 | 6 | ✅ Shipped |
| [3](phases/phase-03-tui-palette.md) | `/` palette in the TUI | terminal | S | 1 | 6 | ✅ Shipped |
| [4](phases/phase-04-authoring-api.md) | Create / edit / delete API | backend | M | 0 | 5 | ✅ Shipped |
| [5](phases/phase-05-skills-ui.md) | Skills section + Generate with AI | web · desktop · backend | L | 4 | 6 | ✅ Shipped |
| [6](phases/phase-06-decommission-agents.md) | Remove agents | all four | M | 1, 2, 3, 5 | — | Unblocked |

**Next up:** [Phase 6](phases/phase-06-decommission-agents.md) — unblocked.

## Decisions already made

Recorded so the same argument does not recur in every phase.

1. **Follow the Agent Skills standard; do not invent a format.** `SKILL.md`,
   the six spec frontmatter fields, and the three-tier disclosure model come
   from [agentskills.io](https://agentskills.io). A skill written for Claude
   Code works in Amiro unchanged, which is the entire value of the feature.
   *Why:* ~45 clients already read this format; a proprietary variant would
   make every existing skill on the user's disk useless.
2. **Scan eight roots: `.agents`, `.amiro`, `.claude`, `.codex` at project
   and user scope.** *Why:* the standard's client guide recommends scanning
   both a native location and `.agents/skills/`, and explicitly suggests
   `.claude/skills/` for pragmatic compatibility. The user asked for all
   four by name.
3. **Precedence: project beats user; within a scope, `.agents` > `.amiro` >
   `.claude` > `.codex`.** *Why:* project-over-user is the universal
   convention. `.agents` outranks Amiro's own `.amiro` because `.agents` is
   what Amiro writes to — ranking a legacy `.amiro` entry higher would make
   a freshly created skill appear not to take effect.
4. **Dedup in the backend, once, by normalised name and by resolved real
   path.** Clients render what they are given. *Why:* the user's explicit
   requirement is no repeats; four clients deduping independently is four
   chances to disagree.
5. **`~/.agents/skills/` is the only writable directory.** Everything else is
   read-only with a Duplicate-to-my-skills escape hatch. *Why:* the user
   chose it, and Amiro rewriting files Claude Code or Codex own is a way to
   lose someone else's work.
6. **A dedicated `skill()` activation tool, not a model file read.** *Why:*
   Amiro's file tools are scoped to one `WorkspaceRoot`, and user-scope
   skills live under `$HOME`. Widening the sandbox to make a feature work is
   how a sandbox stops meaning anything. The tool also lets us strip
   frontmatter, constrain the name to an enum, and list bundled resources
   without reading them.
7. **`/` triggers only as the first character of an empty composer**, on both
   the web and the terminal. *Why:* it matches the TUI's existing
   `editor.Suggest`, so the two surfaces cannot drift, and a `/` mid-sentence
   stays a `/`.
8. **TUI built-in command names are reserved.** A skill named `export` is
   reachable as `/skill:export`. *Why:* a user's skill silently stealing
   `/export` is worse than a slightly longer name, and adding a built-in
   later must never break an existing skill.
9. **The TUI reads and invokes skills; it does not author them.** *Why:* a
   name, a description and a multi-hundred-line markdown body do not belong
   in a Bubble Tea form, and `~/.agents/skills/` is a directory the user can
   open in their editor.
10. **Skills are files, not database rows.** No table, no migration for the
    feature itself. *Why:* the format's portability is the point; a copy in
    sqlite would immediately be a second source of truth, and the only
    migration in this plan is the one that drops the agents table.
11. **Agents are fully decommissioned, with no migration to skills.** The UI
    is transposed rather than redesigned — the same pages, cards and generate
    dialog, pointed at skills. *Why:* the user's decision. Saved agents are
    dropped when Phase 6 lands, and that phase ships the release note saying
    so.
12. **`allowed-tools` is parsed and not honoured.** *Why:* it is marked
    experimental in the spec and support varies between clients. A field that
    looks like it grants permissions and does nothing is worse than an absent
    one, so it is a stated non-goal rather than a half-implementation.
13. **The model drafts; it never writes.** Generate with AI fills the form;
    the ordinary create endpoint and its validator are the only path to disk.
    *Why:* there must be no route from a generation to a file that skips
    validation.
14. **Skills with `disable-model-invocation: true` are discovered and presented in the `/` palette identically to other skills.** *Why:* the attribute governs whether the agent runner injects them into model system prompts during auto-invocation, not whether the user can explicitly invoke them from the palette (Decision D). Note that Phase 2 Decision A (trigger at column 0 of empty composer) is already governed by Decisions 7 and 8.

## What this plan does not do

See [00-overview.md](00-overview.md)'s non-goals: no marketplace or
installer, no sandboxed script execution, no Claude Code frontmatter
extensions beyond `disable-model-invocation`, no `.claude/commands/`, no
monorepo ancestor/nested scanning, no filesystem watcher, no agent-to-skill
migration, no trust dialog.
