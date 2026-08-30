# 01 — Workspace trust and the project rules file

Settles Phase 0's two design questions: what a "trust grant" is and where
it lives, and what the always-on rules file is and how it differs from a
Skill.

## Workspace trust — the model

A trust grant is a row, not a flag on `Workspace`: `(user_id, resolved_root
path, granted_at, granted_via)`. `resolved_root` is the same
symlink-resolved absolute path `workspace.Resolve` already produces, so a
grant cannot be bypassed by a symlink the containment check would itself
catch.

**What changes when a root is ungranted:** `permission.Engine` is
constructed today from `(mode, workspace, allowedCommands, session)`. It
gains a fifth input, a `Trusted bool`, resolved once per turn by a repository
lookup keyed on `(user, resolved_root)`. When `Trusted` is false, every
consequential risk class (`RiskWrite`, `RiskExec`, `RiskExternal`) is
refused with a reason that names the missing grant — the same shape
`ModePlan` already refuses with, reusing `TestPlanMode_RefusesEveryConsequentialRiskWithoutAsking`'s
pattern rather than inventing a second refusal path. `RiskRead` and
`RiskSession` are unaffected — an ungranted root can still be read and
summarized, which is what lets the trust prompt itself show the user what
they're being asked to grant.

**Auto-granted roots — the one exception, and why it's safe.** A root
supplied via `AMIRO_WORKSPACE_ROOT`/`BETTERCHATBOT_WORKSPACE_ROOT` or a CLI
flag is auto-granted at process start. Setting an environment variable or
passing a flag *is* the user's trust gesture — the same reasoning
`docs/skills/00-overview.md` already applies ("Project scope is limited to
the directory the user explicitly selected in the project picker, which is
the trust gesture"). The prompt exists for the case that reasoning doesn't
cover: a project opened interactively, where no such explicit gesture
already happened.

**Revocation.** A grant can be revoked from Settings (web/TUI). Revoking
does not retroactively undo anything; it only changes what a *future* turn
against that root may do.

## The rules file — `AGENTS.md`

**Name and location:** `AGENTS.md` at the workspace root, or
`.agents/AGENTS.md` if present (checked in that order, first match wins —
same precedence shape as `.amiro/config.yaml`'s project-then-fallback rule
in `internal/tui/config`). Not `.cursorrules` (Cursor-specific, and the
comparison doc already notes OpenCode converged on an `AGENTS.md`-shaped
convention) and not `CLAUDE.md` (Claude Code's own name, which
`docs/skills/00-overview.md` already declined to imitate for the skills
system — the same reasoning applies here: Amiro reads the vendor-neutral
name so a file a user already wrote for another tool works here too, where
one happens to exist under that name).

**How it differs from a Skill — this is the load-bearing distinction:**

| | `AGENTS.md` (this phase) | A Skill (`docs/skills/`) |
|---|---|---|
| When it's read | Every turn, unconditionally | On demand, activated by name/description match |
| What it's for | Standing facts about *this* project — "use pnpm", "the API lives in `internal/api`" | A capability — "how to do X", invoked when X comes up |
| Size budget | Small, whole-file, no progressive disclosure | Name+description at session start; body only on activation |
| Precedent | None in Amiro today | `docs/skills/00-overview.md` principle 4 |

A project should generally have both: `AGENTS.md` for the handful of facts
every turn needs, Skills for anything large enough to warrant on-demand
loading. Conflating them — reading every skill body on every turn "to be
safe" — is exactly what Skills' progressive-disclosure principle exists to
prevent, and this phase must not reintroduce it through a second door.

**Reader:** a new, small `internal/agent/rules` package. One file, read at
turn start, capped (mirroring `read_file`'s windowing — a truncation notice
beats a silently-clipped prompt), concatenated verbatim into the system
prompt ahead of the Skills catalog. No frontmatter, no parsing beyond "does
the file exist" — the whole point is that this is not another format to
learn.

## Failure modes

- **Malformed nothing:** `AGENTS.md` has no schema to violate; a missing
  file is simply nothing added to the prompt.
- **A revoked grant mid-turn:** revocation takes effect on the *next* turn.
  A turn already in flight keeps the permission state it started with —
  consistent with how a Mode change already behaves (`session.go`'s own
  per-thread scoping).
- **Two clients disagreeing about trust:** the grant is a database row, not
  connection state — the same multi-client guarantee Phase 5 of the TUI
  work already proved for permission grants (`permission.Store` is keyed by
  thread, process-wide) extends here by construction, since this is a
  second table read the same way.
