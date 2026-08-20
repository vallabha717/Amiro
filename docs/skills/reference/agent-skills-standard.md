# Reference — the Agent Skills standard, as researched

Gathered 2026-08-20 from the primary sources listed at the bottom. This is
the external contract the plan builds on; where Amiro chooses something the
standard leaves open, [README.md](../README.md)'s decisions section says so.

## What a skill is

A directory containing `SKILL.md`. Optional conventional subdirectories:

```
skill-name/
├── SKILL.md          # required: YAML frontmatter + markdown body
├── scripts/          # optional: executable code
├── references/       # optional: docs loaded on demand
└── assets/           # optional: templates, data
```

## Frontmatter — the spec's six fields

| Field | Required | Constraints |
|---|---|---|
| `name` | yes | 1–64 chars · lowercase `a-z0-9` and `-` · no leading/trailing hyphen · no `--` · **must match the parent directory name** |
| `description` | yes | 1–1024 chars, non-empty · must say what it does **and** when to use it |
| `license` | no | license name or bundled file reference |
| `compatibility` | no | ≤500 chars · environment requirements |
| `metadata` | no | string→string map, client-defined keys |
| `allowed-tools` | no | space-separated pre-approved tools. **Experimental**, support varies |

Body: no format restrictions. Recommended under 500 lines / <5k tokens, with
detail pushed into `references/` because activation loads the whole file.

Claude Code accepts all six **plus** extensions of its own
(`when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`,
`user-invocable`, `disallowed-tools`, `model`, `effort`, `context: fork`).
Those are Claude Code only: packaging or uploading a skill carrying them to
claude.ai or the Skills API fails with a hard `Unexpected key(s)` error, so
a portable skill sticks to the six.

## Progressive disclosure

| Tier | Loaded | When | Cost |
|---|---|---|---|
| 1 metadata | `name` + `description` | session start, every skill | ~50–100 tokens each |
| 2 instructions | `SKILL.md` body | on activation | <5k tokens recommended |
| 3 resources | scripts / references / assets | when referenced | nothing until read |

## Where clients look

The spec does **not** mandate locations. The client-implementation guide
recommends scanning a native directory *and* `.agents/skills/`, at both
project and user scope:

| Scope | Native | Portable |
|---|---|---|
| project | `<project>/.<client>/skills/` | `<project>/.agents/skills/` |
| user | `~/.<client>/skills/` | `~/.agents/skills/` |

In the wild: Claude Code uses `~/.claude/skills/` and `.claude/skills/`
(plus enterprise and plugin scopes, and nested `.claude/skills/` in
monorepos); Codex uses `.agents/skills/`; GitHub Copilot accepts
`.github/skills`, `.claude/skills` or `.agents/skills`. The guide explicitly
suggests also scanning `.claude/skills/` "for pragmatic compatibility, since
many existing skills are installed there".

## Collisions and dedup

- Universal convention: **project overrides user.**
- Within one scope: first-found or last-found, but pick one and be
  consistent; log a warning when a skill is shadowed.
- A symlinked skill reachable from two roots loads **once**.

## Client behaviour the guide prescribes

- **Lenient reads:** warn on a name/dir mismatch, an over-long name or a bad
  charset and load anyway; **skip** a skill with no description or
  unparseable YAML, and record why.
- Retry YAML once with values quoted — unquoted colons in `description` are
  the common real-world break.
- Store `name`, `description`, `location` (absolute path to `SKILL.md`) at
  minimum. Base directory is `location`'s parent.
- Catalog goes in the system prompt or in an activation tool's description.
  Omit it entirely when there are no skills; hide filtered/disabled skills
  rather than listing and refusing them.
- Activation: file-read by the model, or a dedicated tool. A tool lets you
  strip frontmatter, wrap content in identifying tags, list bundled
  resources without reading them, and constrain the name parameter to an
  enum so the model cannot hallucinate a skill.
- **Allowlist skill directories** in any permission system, or every bundled
  reference file triggers a confirmation dialog.
- **Exempt skill content from context compaction** — losing it silently
  degrades the agent with no visible error.
- Deduplicate activations within a session.
- User-explicit activation via `/name` or `$name` intercepted by the
  harness, with an autocomplete widget.
- Gate project-scope loading on some trust signal, since a freshly cloned
  repo can inject instructions.
- Scan bounds: skip `.git/`/`node_modules/`, respect `.gitignore`
  optionally, cap depth (~4–6) and directory count (~2000).

## Sources

- [Agent Skills — overview](https://agentskills.io) · the open standard, ~45 client implementations
- [Agent Skills — specification](https://agentskills.io/specification) · frontmatter fields and constraints
- [Agent Skills — how to add skills support to your agent](https://agentskills.io/client-implementation/adding-skills-support) · discovery, precedence, disclosure, activation, compaction
- [Claude Platform — Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) · tiers, `name`/`description` limits, security notes
- [Claude Code — Extend Claude with skills](https://code.claude.com/docs/en/skills) · `~/.claude/skills` vs `.claude/skills`, precedence, extension frontmatter, live change detection
- [Codex — slash commands](https://developers.openai.com/codex/guides/slash-commands/) and [custom prompts](https://developers.openai.com/codex/custom-prompts) · `~/.codex/prompts` is deprecated in favour of skills
- [Agent Skills storage and distribution across tools](https://www.thedroptimes.com/71574/agent-skills-distribution-conventions) · the `.agents/skills` vs `.claude/skills` split in practice
- [`.agents` vs `.claude`: where should skills live](https://claw0x.com/blog/agents-vs-claude-folder-skills-guide) · portable vs client-specific
