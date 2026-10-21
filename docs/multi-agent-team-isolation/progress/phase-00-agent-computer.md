# Phase 00 — Agent computer: record

**Date:** 2026-10-21 · **Branch:** `worktree-agent-sandbox-research` (uncommitted)

## What shipped

- **Supervisor crate** `backend/sandboxd/` (`amiro-sandboxd`): `credential.rs`
  (HMAC per agent, constant-time verify), `spec.rs` (every hardening field,
  config validation, spec-hash replacement), `docker.rs` (Engine API over the
  unix socket, demuxed capped exec), `paths.rs`, `server.rs` (`/health`,
  `/v1/agents/{id}/{ensure,stop,status,exec,files/read|write|list,selfcheck}`),
  `client.rs` (used by the backend), `main.rs`.
- **Packaging:** `packaging/sandbox/{compose.yml,supervisor.Dockerfile,agent.Dockerfile}`,
  `scripts/sandbox.sh up|down|status`.
- **Backend:** `src/sandbox.rs` (settings, tool definitions, `run_tool`,
  `AgentToolset`), `src/routes/agent_computer.rs` (`GET/PATCH /api/agents/{id}/computer`,
  `POST …/check`), `agents.rs` (`tools` on each record), `runtime.rs`
  (`TurnPlan.agent_tools`, `turn_tool_configuration`, team-folder guard,
  answering agent tool calls), `chat.rs` (builds the toolset; `providerExecuted`).
- **UI:** `src/components/team/agent-computer-tab.tsx`, the API client in
  `agents-api.ts`, `Team.computer.*` + `tabComputer` + `isolationNoteMain`
  strings (en + hi). The Computer view is mounted by the Team UI rewrite
  (another session owns `agent-page.tsx`).
- **E2E:** the `team` journey's "computer" test; a per-run sandbox
  (namespace `amiroe2e`) started by `global-setup.ts` when the images exist
  (`sandbox.mode` in `tests/e2e.config.example.json`).

## Later the same day: UI unmounted, MCP allowance added

- **The owner's decision:** the Computer view is removed from the Team UI for
  now ("we will work on that later"). `agent-computer-tab.tsx`, the
  `/api/agents/{id}/computer` routes and the whole supervisor stay in the tree
  but are not mounted, and the "team: computer" E2E test was removed from
  `12-team.spec.ts` (the recording above predates that). Until the UI returns,
  Shell and Files can only be switched on through the API, so team agents
  in practice have no container tools. The Workspace tab's `Team.isolationNote`
  is no longer rendered either.
- **Remote MCP tools for team agents** (for per-agent connectors,
  `docs/multi-agent-team/03-per-agent-config.md`): when a turn runs on the
  agent's own runtime (`agents-private/<id>/runtime`), the tools of its
  **remote** (URL) connectors are enabled by exact `mcp__<server>__<tool>`
  name. Never built-ins, never the `mcp` management tool (it can connect a
  stdio command), never the main runtime's connectors. Stdio connectors are
  refused for team agents where the agent's `mcp.json` is written.
  Tests: `sandbox::tests::only_remote_servers_and_their_exact_tools_are_offered`,
  `tests/agent_computer.rs::only_the_agents_own_remote_connectors_are_offered`.
- **Fix after the first journey run:** the runtime shows most providers only
  the fixed `mcp_search`/`mcp_call` surface and strips per-server definitions
  from `list_tools`, so the exact-name list came out empty and the model
  reached for `mcp` (refused). Team agents with remote connectors now get
  `mcp_search` + `mcp_call` (the runtime authorises calls through an enabled
  `mcp_call`) plus any listed `mcp__` names; never `mcp`. Because `mcp_call`
  reaches every server in the runtime, an agent config holding any local
  (stdio) server or the `amiro` admin server gets no MCP at all. The `team`
  journey's "Scout uses its own connector" step passed (8/8,
  `tests/recordings/2026-10-21T08-20-34`).
- **Runtime patch `refused-tool-is-a-tool-error`** (approved by the owner):
  a call the session policy refuses no longer aborts the turn. Both turn
  loops (`turn_loops.rs`, `turn_streaming_mpsc.rs`) answer it as an error
  tool result through the existing malformed-call branch, so repeated refusals
  still hit the malformed-round bound; the refusal itself is unchanged.
  Recorded in `docs/runtime-customizations.json`. Test:
  `agent_tests.rs::refused_tool_call_is_answered_as_a_tool_error_not_a_turn_error`
  (both loops; fails without the patch with `Tool 'bash' is not allowed`).
  `pnpm runtime:check`, the 159 `agent::` runtime tests, the contract check
  and the `team` journey (8/8, `tests/recordings/2026-10-21T09-01-32`) pass.

## What diverged from the plan, and why

- **`no-new-privileges` is off on snap-packaged Docker.** Its AppArmor profile
  refuses every exec under no_new_privs (`apparmor="DENIED" … info="no new privs"
  profile="snap.docker.dockerd"`), so no container could start, not even
  `docker run --security-opt no-new-privileges:true debian true`. It is now a
  setting (`AMIRO_SANDBOX_NO_NEW_PRIVILEGES`, default on); `scripts/sandbox.sh`
  turns it off only on snap Docker with a warning, and the self-check shows
  "no-new-privileges is off" in amber. Everything else (non-root, `CapDrop ALL`,
  read-only root, limits, single mount) holds on snap Docker.
- **Secrets reach compose as environment, not `env_file`.** Snap's confined
  CLI cannot read top-level hidden folders (`~/.amiro`, `~/.cache`).
- **The E2E sandbox home lives under `~/.cache`,** not `/tmp`: snap Docker has
  a private `/tmp`, so `/tmp` folders cannot be bind-mounted.
- **Files are written by chunked base64 exec** inside the container rather
  than the Docker archive API: no tar code, correct ownership, works with a
  read-only root.
- **`AMIRO_SANDBOX_URL` may also live in the secrets file,** so a test (or a
  second instance) can point at its own supervisor without process env.
- **The Team UI was rewritten in parallel by another session** (full-page
  agent view with `?view=computer`); the Computer component is mounted there.

## How it was verified

| Command | Result |
| --- | --- |
| `cargo test --manifest-path backend/sandboxd/Cargo.toml` | 11 unit + 5 server + 3 **live Docker** passed (not skipped) |
| `cargo test --manifest-path backend/Cargo.toml --test agent_computer` | 5 passed |
| `cargo test --manifest-path backend/Cargo.toml --no-fail-fast` | every suite passed (lib 232, agents 13, agent_computer 5, schedules_acceptance 15, …) |
| `cargo test … --test schedules_acceptance` (first full run) | 2–4 of 15 failed at "native backend did not become healthy" under load; 15/15 with `--test-threads=1` and in the next full run — a pre-existing readiness flake, not this change |
| `pnpm lint` · `pnpm check:i18n` · `pnpm test` | clean · 993 keys match · 875 passed |
| `tsc --noEmit` | no errors outside `.next/` (stale route types from the parallel Team move) |
| `bash scripts/sandbox.sh up` (manual, namespace `amiromanual`) | supervisor container: user 65532, `CapDrop [ALL]`, read-only, port `127.0.0.1` only; selfcheck via HTTP: uid = owner, `CapEff 0`, `/home/agent` only; wrong credential → 403 |
| `pnpm --dir tests e2e --project team` | 8/8 passed with a live sandbox; recording `tests/recordings/2026-10-21T05-59-37/feature-team-computer.mp4` |

The recording shows Scout calling `agent_shell` and answering
`BOX-971634791-agent`: `$(ls /home)` printed only `agent`, which is the
container's view, not the VM's.

## Exit criteria

1. ✅ sandboxd spec test asserts `CapDrop`, no-new-privileges (default), read-only root, limits, single mount, no `Privileged`.
2. ✅ Live Docker tests passed (not skipped) with the image built.
3. ✅ `--test agent_computer` passes.
4. ✅ Backend suite passes (schedules flake noted above).
5. ✅ lint, unit tests, i18n pass (UI later unmounted, see above); `check-types` blocked only by stale `.next/` types from the parallel route move.
6. ✅ `team` journey passed with the Computer test; recording watched. That test was later removed with the UI.
7. ✅ `AMIRO_SANDBOX_TOKEN/MASTER` are read only in `backend/src/sandbox.rs`; a test asserts no response contains them.

## Follow-ups surfaced

- Shell commands are capped at 110 s by the runtime's 120 s SDK callback
  timeout; longer commands need a runtime setting (`amiro-runtime-update`).
- Deleting an agent leaves its container (Phase 02 removes it).
- `.next/types` stale-route errors appear after the Team route-group move until `next build` regenerates them.
