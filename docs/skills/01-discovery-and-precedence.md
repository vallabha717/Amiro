# 01: Discovery and precedence

Settled here: which directories Amiro scans, in what order, how a
`SKILL.md` is parsed, how a name collision resolves, and how the same skill
reachable by two paths appears once.

## Where Amiro looks

Two scopes, four directory families each. The standard's client guide
recommends scanning both a client-native location and `.agents/skills/`;
Amiro adds the two neighbour-tool directories because the whole point of
the user's request is that skills already installed for Claude Code and
Codex show up here.

| # | Scope | Path | Writable | Why |
|---|---|---|---|---|
| 1 | project | `<project>/.agents/skills/` | no | Cross-client convention, committed to the repo |
| 2 | project | `<project>/.amiro/skills/` | no | Amiro-native project location |
| 3 | project | `<project>/.claude/skills/` | no | Claude Code project skills |
| 4 | project | `<project>/.codex/skills/` | no | Codex project skills |
| 5 | user | `~/.agents/skills/` | **yes** | Cross-client convention: the one directory Amiro owns |
| 6 | user | `~/.amiro/skills/` | no | Amiro-native user location |
| 7 | user | `~/.claude/skills/` | no | Claude Code personal skills |
| 8 | user | `~/.codex/skills/` | no | Codex personal skills |

`<project>` is the directory the user selected in the project picker
(`appStore.projectDirectory` in the dashboard, `--workspace`/cwd in the
TUI), the same value that already reaches the backend as
`workspaceRoot` on a chat request and already scopes the file tools. No
project selected means scope 1–4 contribute nothing.

`~` is the backend process's `$HOME`. The test harness gives every test its
own `HOME`, which is what makes user-scope discovery testable at all
without touching the developer's real directories.

## Precedence

Two rules, applied in order:

1. **Project beats user.** This is the universal convention across existing
   implementations, and it is the one users already expect: a repo's
   `code-review` overrides their personal one.
2. **Within a scope, lower table row number wins**: `.agents` before
   `.amiro` before `.claude` before `.codex`.

`.agents` outranking `.amiro` is deliberate and is the one place Amiro
departs from "native location first". Amiro *writes* to `~/.agents/skills/`,
so a skill just created in the UI must be the one that wins; ranking a
legacy `.amiro/skills/` entry above it would make the Create Skill form
look broken.

A collision is not an error. The loser is recorded as a **shadowed** entry
with both paths, surfaced in the API response and in `amirotest` artifacts,
so "why is my skill not being used" has an answer that does not require
reading the source.

## Deduplication

Distinct from precedence, and the requirement the user stated directly: the
list must never repeat.

- **By name.** The dedup key is the skill name normalised to lowercase with
  surrounding whitespace stripped. Frontmatter `name` is authoritative; if
  it is missing, the directory name is used.
- **By identity.** Resolve each candidate directory to its real path before
  keying. `~/.agents/skills/foo` symlinked to `~/.claude/skills/foo` is one
  skill found twice, not two skills: the same-target rule Claude Code
  applies. A directory reachable from two scan roots loads once.
- **The API returns one entry per name**, with `source` (which row above it
  came from), `scope`, `path`, and `shadowedBy`/`shadows` populated. The
  clients render what they are given; no client does its own dedup, because
  four clients deduping independently is four chances to disagree.

## Scan rules

From the client-implementation guide, adopted verbatim because they exist
to stop a runaway walk:

- A skill is **a subdirectory containing a file named exactly `SKILL.md`**.
  A loose `README.md` in the skills root is not a skill.
- Skip `.git/`, `node_modules/`, and any directory beginning with `.` below
  a skills root.
- Bounds: max depth 4 below each skills root, max 2000 directories visited
  per scan, max 256 skills returned, max 1 MiB per `SKILL.md`. Every bound
  that trips is reported in the response, never silently applied.
- A missing scan root is normal, not an error. Most machines will have three
  of the eight.

## Parsing, leniently

Split on the leading `---` fence, parse the YAML block, treat the remainder
as the body. Then:

| Condition | Behaviour |
|---|---|
| `description` missing or empty | **Skip the skill**, record the reason: without a description there is nothing to disclose and the model cannot decide to use it |
| YAML unparseable after the quoting retry below | **Skip**, record the reason |
| `name` missing | Use the directory name, warn |
| `name` disagrees with the directory name | Load anyway, warn, and keep the directory name as the invocation name |
| `name` over 64 chars / wrong charset / consecutive hyphens | Load anyway, warn |
| Unknown frontmatter keys | Keep in `metadata`, ignore |
| `disable-model-invocation: true` | Load, but omit from the model-facing catalog; still user-invocable from `/` |

The one retry worth implementing: a `description` whose unquoted value
contains a colon (`description: Use when: the user asks…`) is invalid YAML
that other clients' parsers happen to accept, and it is common in the wild.
On a parse failure, re-attempt once with scalar values quoted before giving
up.

Diagnostics are values, not log lines: the list endpoint returns them so the
Skills page can show "3 skills, 1 skipped: reason", and `amirotest`
artifacts capture them.

## Freshness

Discovery is a filesystem scan on request, with a short in-process cache
keyed by `(home, project)` and invalidated by the authoring endpoints. No
filesystem watcher in v1: the palette fetches on open, and a skill created
in the UI must appear immediately, which the cache invalidation, not a
watcher, is what guarantees. A watcher (Claude Code's live change detection)
is a follow-up.
