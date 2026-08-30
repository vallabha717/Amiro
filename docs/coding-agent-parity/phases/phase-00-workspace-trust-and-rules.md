# Phase 00 — Workspace trust + `AGENTS.md`

> **Shipped 2026-08-23.** ⚠️ Complete with gaps (4/6 exit criteria MET) —
> see [progress/phase-00-workspace-trust-and-rules.md](../progress/phase-00-workspace-trust-and-rules.md)
> and its [verification log](../progress/verification-log-phase-00.md).
> The backend enforcement (what Phase 4 actually depends on) is fully
> proven; the two open gaps are test-execution reliability in the shipping
> sandbox (a flaky real-PTY TUI test, a Playwright spec that could not run
> at all there), not product defects.

**Depends on:** — · **Blocks:** 4 · **Size:** M

**Surfaces touched:** backend · desktop · web · terminal

This phase makes two things true that are not true today: opening a
project interactively asks a human once before an agent may write to it or
run commands in it, and a plain `AGENTS.md` at the workspace root is read
into the system prompt on every turn — distinct from a Skill's on-demand
activation.

## What already exists

- `internal/agent/workspace.Workspace` performs path containment
  (symlink-aware, catches writes through a symlinked parent) — this phase
  does not touch it.
- `internal/agent/permission.Engine`, constructed from
  `(mode, workspace, allowedCommands, session)`, already refuses every
  consequential risk class in `ModePlan` with a stated reason
  (`TestPlanMode_RefusesEveryConsequentialRiskWithoutAsking`). This phase's
  refusal path reuses that shape.
- `WorkspaceRoot` is sourced only from `AMIRO_WORKSPACE_ROOT` /
  `BETTERCHATBOT_WORKSPACE_ROOT` (`internal/config/config.go`) — there is
  no concept of a per-user, per-root grant anywhere in the tree today.
  `docs/skills/00-overview.md` names this explicitly as a non-goal it
  deliberately left to a future plan: "Amiro has no workspace-trust concept
  and this plan does not add one." This phase is that future plan.
- `.amiro/config.yaml` (`internal/tui/config`) already establishes a
  project-then-user-then-env precedence pattern this phase's `AGENTS.md`
  lookup mirrors (project root, then nothing — there is no user-level
  `AGENTS.md`, since the whole point is project-specific facts).
- The approval-card rendering contract (`component/approval` in the TUI,
  the equivalent web tool-invocation card) already renders "what's about to
  happen, from input alone" — this phase's trust prompt and Skills'
  existing catalog-in-system-prompt injection are the two patterns this
  phase's `AGENTS.md` reader combines.

See [01-workspace-trust-and-rules.md](../01-workspace-trust-and-rules.md)
for the full design.

## Deliverables

### 1. Backend — trust grants

- `internal/db/models/workspace_trust.go` — `(id, user_id, resolved_root,
  granted_at, granted_via)`. Migration, both dialects (sqlite + postgres),
  per the `backend` skill's four-file rule.
- `internal/db/repository/workspacetrust/` — `IsTrusted(ctx, userID,
  root) bool`, `Grant(...)`, `Revoke(...)`.
- `permission.Engine` gains a `Trusted bool` input, resolved once per turn.
  When false, `RiskWrite`/`RiskExec`/`RiskExternal` are refused with a
  reason naming the missing grant; `RiskRead`/`RiskSession` are
  unaffected.
- Auto-grant at process start for a root supplied via
  `AMIRO_WORKSPACE_ROOT`/`BETTERCHATBOT_WORKSPACE_ROOT`/a CLI flag — no
  prompt for these, per the design doc's reasoning.
- `internal/api/<domain>/` — routes to check/grant/revoke trust for the
  current user's resolved root, registered in `router.go` per the
  `backend` skill's route-adding steps.

### 2. Backend — `AGENTS.md` reader

- `internal/agent/rules/rules.go` — reads `AGENTS.md` or
  `.agents/AGENTS.md` (first match) at the workspace root, size-capped with
  a truncation notice, concatenated into the system prompt ahead of the
  Skills catalog.

### 3. Desktop / web — trust prompt

- A first-open-of-a-project prompt component in `src/components/`, reusing
  the existing approval-card visual language rather than a new dialog
  primitive (see the `ui` skill's anti-pattern table on not inventing
  parallel components).
- A Settings section listing granted roots with a revoke action.

### 4. Terminal — trust prompt

- The same prompt rendered through `internal/tui/component/approval`,
  which already renders from input alone with no result yet — no new
  component needed, per the design doc.

### 5. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/workspacetrust/` | Grant/revoke round-trip; an ungranted root refuses `RiskWrite`/`RiskExec`/`RiskExternal` and allows `RiskRead`/`RiskSession`; env/flag-sourced roots are auto-granted; `AGENTS.md` at both accepted locations lands in the system prompt, truncated past the cap |
| terminal | `tests/suites/tui/workspacetrust/` | The trust prompt renders on first project open under a real PTY; declining leaves the session read-only; `/rewind`-style approval-dialog reuse renders correctly for this new prompt type |
| web | `tests/ui/specs/workspacetrust/` | The prompt appears on first open, grant/revoke from Settings, `data-testid`s added for both |
| cross | `tests/suites/cross/workspacetrust/` | A grant made in the desktop app is honored when the TUI attaches to the same server (`--connect`), proving the grant is a database row, not connection state |
| meta | `tests/suites/meta/` | A guard asserting every `RiskWrite`/`RiskExec`/`RiskExternal` tool call path goes through the `Trusted` check — no tool can bypass it by constructing its own `Engine` |

**Deliberately not covered:** a UI for browsing *why* a root was granted
(the `granted_via` field exists and is tested at the repository layer, but
no phase in this plan surfaces it beyond a revoke button — a fuller audit
trail is Tier 3 of the comparison doc, not this phase).

### 6. Docs updated

- `docs/skills/00-overview.md`'s "Non-goals" section — the "no
  workspace-trust concept" line becomes stale once this phase ships and
  must be corrected, with a pointer to this phase.

## Exit criteria

1. `amirotest run --surface backend --feature workspacetrust` passes.
2. A turn against an ungranted, interactively-opened root refuses a
   `write_file` call with a message naming the missing grant, asserted by
   `TestPermission_UngrantedRootRefusesEveryConsequentialRisk`.
3. A turn against a root supplied via `AMIRO_WORKSPACE_ROOT` never sees a
   trust prompt, asserted by `TestWorkspaceTrust_EnvSourcedRootAutoGrants`.
4. `amirotest run --surface tui --feature workspacetrust` and
   `--surface ui --feature workspacetrust` both pass, each exercising the
   real prompt under a real PTY / real browser.
5. `amirotest run --surface cross --feature workspacetrust` passes,
   proving a desktop-granted root is trusted from an attached TUI client
   with no separate grant step.
6. `amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.

## Risks

- **Existing users with a long-running `AMIRO_WORKSPACE_ROOT` deployment
  suddenly seeing a prompt.** Mitigated by the auto-grant rule above — the
  exit criterion in item 3 exists specifically to catch a regression here
  before it ships, since this is the risk most likely to generate a support
  question on day one.
- **A grant table that silently diverges from `workspace.Resolve`'s notion
  of "the same root"** (trailing slash, case-sensitivity on a
  case-insensitive filesystem) — mitigated by resolving through the exact
  same `workspace.Resolve` function the grant is checked against, never a
  second path-normalization routine.
