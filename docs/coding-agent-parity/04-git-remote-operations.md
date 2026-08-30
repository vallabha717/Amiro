# 04 — Git remote operations: push and PR creation

Settles Phase 3: the exact shape of the two new git operations, why they
stay inside the existing allowlisted tool rather than becoming a
passthrough, and how credentials are handled.

## Still one tool, still an allowlist

`internal/ai/tools/git.go`'s own comment is explicit about why push/pull/
fetch/reset/rebase/checkout are absent: "the first three reach the
network; the rest destroy uncommitted work." This phase adds exactly one of
the network operations back — `push` — and does not touch the
history-rewriting set at all. The subcommand enum grows from
`["status","diff","log","show","add","commit"]` to include `["push"]`;
nothing else changes about the tool's shape.

## `push` — constraints, not a flag

- **Current branch only.** The tool resolves the checked-out branch itself;
  the model cannot name an arbitrary ref to push, which forecloses the
  "push to `main` by mistake" failure mode structurally rather than by
  asking nicely.
- **No force push without a separate, explicit `force` input** that is
  itself gated as `RiskExternal` **and always asks, in every mode including
  Auto** — the one place this plan overrides Auto mode's "runs everything
  without asking" rule, because a force-push is the one git operation that
  destroys another party's work, not just the local tree. Named here so it
  isn't quietly softened during implementation.
- **Remote must already be configured** (`origin`, or whatever the repo's
  existing remotes are) — the tool does not add remotes. Adding a remote
  is a credential-scope decision a human should make once, in a terminal,
  not something an agent turn does on the model's say-so.

## `create_pr`

Calls the GitHub REST API directly (`POST /repos/{owner}/{repo}/pulls`) —
**no `gh` CLI dependency**, consistent with the backend standard's "pure
Go, no cgo, no new runtime dependency" (the `gh` binary would be exactly
that: an external binary the desktop app cannot assume is installed, the
same objection that already kept `ripgrep` out of `grep` and tree-sitter
out of the repo map). Title and body are built from the existing
`walkthrough` tool's output — the "what changed, in reading order,
cross-checked against real edits" text is already the right shape for a PR
description, and reusing it means Phase 3 adds no new summarization
prompt.

**Scope: GitHub only, this phase.** GitLab/Bitbucket are real gaps (see the
comparison doc's provider breadth note) but a second REST client is
follow-up work, not a blocker to this phase landing.

## Credentials

A GitHub token (personal access token or, if a future phase adds a GitHub
App flow, an installation token) goes into `internal/secrets` — the OS
keychain — **as its own entry, not folded into the provider-key store**.
Reasoning: a provider key controls model spend; a GitHub token controls
write access to a user's repositories and organizations. Different blast
radius, different revocation path, different UI (a "Connect GitHub" button
in Settings, distinct from the provider-key form), so they stay distinct
entries even though the storage mechanism is identical.

`internal/secrets` returns presence/status only, never the token itself, to
any API response — the same rule the backend skill already states for
provider keys, extended here rather than re-derived.

## Risk classification

Both `push` and `create_pr` are `RiskExternal`. What's new: **Interactive
and Edit mode currently allow `RiskExternal` without asking** (`permission.go`'s
existing carve-out — every MCP tool is External, and prompting per call
would make MCP unusable). Push/PR need a narrower rule than "External", so
they get an additional `AlwaysAsk` flag on the `Definition`, checked before
the mode's own External-allow shortcut — the permission engine gains one
new predicate, not a new risk class. This keeps the existing MCP behavior
untouched while making sure a push is never the one thing that slips
through on the strength of "MCP tools don't need asking."

## Approval card

Renders through the existing presenter registry, extending `git.go`'s
existing `Compact` view: branch name, remote, and — for `create_pr` — the
PR title and the first few lines of the walkthrough-derived body. The same
rule Phase 3 of the agentic-loop plan established for every gated tool
("approving an `edit_file` shows the diff, not raw arguments") applies
here: approving a push shows the branch and remote, never a raw JSON
argument blob.

## Failure modes

- **No token configured:** the tool refuses before attempting the call,
  with a message naming the Settings page — not a raw GitHub API 401
  surfaced to the model.
- **Push rejected (non-fast-forward):** reported as the git subprocess's
  own stderr, same as every other git subcommand today — no automatic
  retry with `--force`, which would silently cross into the force-push gate
  above through the back door.
- **Rate limiting / GitHub API errors:** surfaced verbatim in the tool
  result; no retry loop hidden inside the tool (a model that sees a 403 can
  decide what to do next — a tool that silently retries removes that
  decision from both the model and the user watching the approval card).
