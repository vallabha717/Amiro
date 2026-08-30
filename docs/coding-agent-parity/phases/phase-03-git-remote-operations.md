# Phase 03 — Git push + PR creation

**Status:** ⚠️ shipped 2026-08-29, 3/5 criteria literally MET (2 more proven
at other layers than the criterion names) — see
[progress/phase-03-git-remote-operations.md](../progress/phase-03-git-remote-operations.md)

**Depends on:** — · **Blocks:** 4 · **Size:** M

**Surfaces touched:** backend · desktop · web · terminal

This phase makes it true that the agent can push a branch and open a pull
request — gated tighter than any existing tool, since it is the first tool
in this codebase that writes to a system outside the user's own machine.

## What already exists

- `internal/ai/tools/git.go` is a fixed subcommand allowlist
  (`status/diff/log/show/add/commit`), with the comment explaining exactly
  why push/pull/fetch/reset/rebase/checkout are absent: "the first three
  reach the network; the rest destroy uncommitted work." This phase adds
  `push` back, deliberately, with the constraints in
  [04-git-remote-operations.md](../04-git-remote-operations.md) — it does
  not touch the history-rewriting set.
- `internal/agent/permission`'s risk classes are read/session/write/exec/
  external; `RiskExternal` is currently allowed without asking in
  Interactive and Edit modes (every MCP tool is `RiskExternal`, and
  per-call prompting there would make MCP unusable — `permission.go`'s
  existing, deliberate carve-out). This phase does not change that
  carve-out; it adds a narrower `AlwaysAsk` predicate checked ahead of it.
- `internal/secrets` (OS keychain) already stores provider keys with
  presence/status-only API responses — this phase's GitHub token entry
  follows the identical mechanism, as its own entry.
- `walkthrough` (already shipped, `internal/ai/tools/plan.go`) produces
  "what changed, in reading order" text this phase's PR description reuses
  directly.
- The tool-presenter registry (`src/components/tool-presenters/`,
  `internal/tui/component/toolcard`) already renders `git`'s `Compact` view
  from a command line — this phase extends it, not replaces it.

## Deliverables

### 1. `git.go` — `push`

- Subcommand enum gains `push`. Resolves the current branch itself (never
  model-supplied). A separate `force` input, present only for this
  subcommand, classified `RiskExternal` + `AlwaysAsk` (see item 3) — no
  force push without it, and no way to reach `--force` any other way.

### 2. `create_pr` tool

- `internal/ai/tools/github.go` (new) — calls `POST
  /repos/{owner}/{repo}/pulls` directly via `net/http`, no `gh` CLI
  dependency. Title/body sourced from the turn's own `walkthrough` output.
- Owner/repo inferred from the `origin` remote already configured in the
  workspace — the tool does not add or change remotes.

### 3. Permission engine — `AlwaysAsk`

- `tools.Definition` gains an `AlwaysAsk bool`, checked in
  `permission.Engine.Check` before the mode's own `RiskExternal`-allow
  shortcut. `push` and `create_pr` (and `force` specifically) set it. No
  other existing tool sets it — this is additive and changes no existing
  tool's behavior.

### 4. Credentials

- `internal/secrets` gains a GitHub-token entry, distinct from provider
  keys (own storage key, own presence-check route).
- Web Settings: a "Connect GitHub" section, separate from the provider-key
  form.
- TUI: the existing `/settings` page (landed in TUI Phase 4 per
  `docs/tui-progress.md`) gains a GitHub-connect flow.

### 5. Approval card

- `git.go`'s existing `Compact` presenter extended: `push` shows branch +
  remote; `create_pr` shows the PR title and the first lines of the
  walkthrough-derived body.

### 6. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/gitremote/` | `push` resolves and pushes only the current branch; `force` is refused without the explicit input and always asks even in Auto mode; `create_pr` builds title/body from `walkthrough`, against a fake GitHub API (`harness.WithFake`-style, no live network by default per the `test` skill); a missing token refuses before any HTTP call |
| web | `tests/ui/specs/settings/` | GitHub connect flow, presence-only display, disconnect |
| terminal | `tests/suites/tui/settings/` | Same flow under a real PTY |
| meta | `tests/suites/meta/` | A guard asserting `push`/`create_pr`/`force` are the only `Definition`s with `AlwaysAsk: true`, and that `AlwaysAsk` is checked ahead of every mode's `RiskExternal` shortcut — regresses loudly if a future tool sets `RiskExternal` alone expecting to be silently allowed the way MCP tools are, when it actually needed this gate |

**Deliberately not covered:** GitLab/Bitbucket (`04-git-remote-operations.md`
names GitHub-only as this phase's scope; a second REST client is
follow-up); a `gh` CLI-based implementation (deliberately not built, to
avoid the external-binary dependency the backend standards already avoid
elsewhere).

## Exit criteria

1. `amirotest run --surface backend --feature gitremote` passes.
2. `TestGit_PushNeverTargetsAnyBranchButCurrent` and
   `TestGit_ForceRequiresExplicitInputAndAlwaysAsksInAutoMode` both pass.
3. `TestCreatePR_BuildsDescriptionFromWalkthrough` passes against the fake
   GitHub API.
4. `amirotest run --surface ui --feature settings` and
   `--surface tui --feature settings` both pass, covering the GitHub
   connect/disconnect flow.
5. `amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.

## Risks

- **A model attempting to use `push`/`create_pr` as a way around the
  always-ask gate by chaining through the generic `run_shell` tool
  instead** (`git push` as a raw shell command). Mitigated by `push`
  staying absent from the shell command allowlist's defaults — the same
  reasoning that already keeps `go build`/`go test` off the default
  allowlist applies here, and this phase's meta guard should assert
  `run_shell`'s default allowlist contains no `git push`/`git commit -f`
  variant.
- **Building a GitHub API fake is new work** (no existing cassette-style
  fixture for it). Mitigated by following the exact pattern
  `harness.WithFake` already established for the model provider, scoped to
  this one integration — not a new testing mechanism.
