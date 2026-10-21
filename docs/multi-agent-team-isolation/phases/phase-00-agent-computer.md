# Phase 00 — Agent computer

> **Built 2026-10-21 (not yet committed).** See [progress/phase-00-agent-computer.md](../progress/phase-00-agent-computer.md)
> for what was built, what diverged, and the verification log.

**Depends on:** — · **Blocks:** 01, 02, 03 · **Size:** L

**Surfaces touched:** backend · supervisor (new binary + images) · web (agent page)

After this phase a team agent's shell and file tools will run in its own
container, created by a supervisor that alone holds the Docker socket, and
reached with a credential derived for that agent. Every tool will be off
until the owner switches it on, and a team agent session will never be
offered a host tool, whatever path starts its turn.

## What already exists

- `backend/src/routes/agents.rs` — the registry (`store/agents.json`),
  `valid_agent_id`, `agents_root`, `working_dir_for`. Stays; gains the
  `tools` field read/write helpers.
- `backend/src/chat.rs` — resolves `agentId` and the agent's folder for a
  thread. Gains building the toolset for the turn and `providerExecuted` for
  agent tools.
- `backend/src/runtime.rs` — `TurnPlan`, `drive_turn`, `no_tools()`, and
  `probe_model`, which already answers a custom tool on a helper thread with
  `submit_tool_result`. Phase 00 reuses that pattern; no runtime patch.
- `runtime/…/tool/sdk.rs` — `configure_tools` overlay: `enabled: []` turns off
  built-in and MCP tools; custom tools call back to the owning connection
  with a 120 s timeout. Unchanged.
- `src/components/team/agent-page.tsx` — Workspace tab with the Stage 1
  isolation note. The note moves to the new Computer tab and becomes
  per-agent and truthful.
- References: OpenDots `deployment/computers/` (supervisor hardening, HMAC
  per-Dot credential), rakazo `infra/sandboxes/supervisor/src/computer-spec.ts`
  (container hardening fields and limits).

## Deliverables

### 1. Crate `backend/sandboxd` (`amiro-sandboxd`)

- `src/credential.rs` — `agent_credential(master, id) -> String`, constant-time `verify`.
- `src/spec.rs` — `SandboxConfig::from_env`, `container_spec(cfg, id) -> Value`, `spec_hash`.
- `src/docker.rs` — minimal Docker Engine client over the unix socket (hyper):
  inspect, create, start, stop, remove, exec (demultiplexed, capped, timed),
  put archive.
- `src/paths.rs` — relative-path validation shared by both sides.
- `src/server.rs` — the `/v1` router from [01-architecture.md](../01-architecture.md#supervisor-api-amiro-sandboxd-v1).
- `src/client.rs` — typed client the backend uses (reqwest).
- `src/main.rs` — binary; refuses short secrets and uid 0.

### 2. Packaging

- `packaging/sandbox/compose.yml`, `supervisor.Dockerfile`, `agent.Dockerfile`.
- `scripts/sandbox.sh up|down|status`.

### 3. Backend

- `backend/src/routes/agent_computer.rs` — `GET/PATCH /api/agents/{id}/computer`,
  `POST …/computer/check`.
- `backend/src/sandbox.rs` — reads `AMIRO_SANDBOX_URL` and the secrets file,
  builds tool definitions for a policy, runs a tool call through the client.
- `runtime.rs` — `TurnPlan.agent_tools`; `drive_turn` configures the session
  and answers agent tool calls; the agents-root guard.
- `chat.rs` — sets `agent_tools` for team-agent threads; `providerExecuted`.

### 4. UI

- `src/lib/backend/agents-api.ts` — `getAgentComputer`, `setAgentTools`, `checkAgentComputer`.
- `src/components/team/agent-computer-tab.tsx` + tab in `agent-page.tsx`.
- `Team.computer.*` strings in `messages/en.json` and `messages/hi.json`;
  `Team.isolationNote` rewritten to describe only the folder.

### 5. Test coverage

| Surface | Where | Covers |
| --- | --- | --- |
| supervisor (unit) | `backend/sandboxd/src/*.rs` tests | credential vector + per-id difference; every hardening field of the spec; uid 0 refused; path validation |
| supervisor (integration) | `backend/sandboxd/tests/server.rs` | 401 without token; 403 with another agent's credential; 400 bad id/path; against a fake Docker engine on a unix socket |
| supervisor (live) | `backend/sandboxd/tests/live_docker.rs` | real container: uid ≠ 0, `CapEff` 0, `NoNewPrivs` 1, only its folder visible, write→read round trip, agent A cannot see B's file. Skips with a reason when Docker or the image is absent |
| backend | `backend/tests/agent_computer.rs` | policy defaults off; owner-only PATCH (403 member, 401 none); `browser` → 400; `main` → 409; `isolation` value for none/unavailable/container (fake supervisor); tool definitions per policy; a tool call with the supervisor down returns an error, never runs on the host |
| backend (unit) | `runtime.rs` tests | team folder without a toolset → `enabled: []`, no custom tools |
| web | `tests/e2e/specs/12-team.spec.ts` | Computer tab: switches off by default, turn Shell on and it persists after reload, isolation line changes; with the supervisor running, **Check isolation** shows a non-root uid and no capabilities |

**Deliberately not covered:** gVisor (not installed on the dev VM; Phase 01),
a model actually choosing `agent_shell` (model-dependent; recorded as a soft
check in the journey only when a provider is configured).

### 6. Docs

`docs/SECURITY-MODEL.md` (team agents section), `docs/multi-agent-team/02-design.md`
(Isolation → link here), `.env.example` (`AMIRO_SANDBOX_*`), this folder's
`progress/`.

## Exit criteria

1. `cargo test --manifest-path backend/sandboxd/Cargo.toml` passes, including
   the spec test asserting `CapDrop == ["ALL"]`, `no-new-privileges`,
   `ReadonlyRootfs`, limits, a single bind mount, and no `Privileged`.
2. With `scripts/sandbox.sh up` run, `cargo test --manifest-path backend/sandboxd/Cargo.toml --test live_docker`
   reports the live tests as passed (not skipped).
3. `cargo test --manifest-path backend/Cargo.toml --test agent_computer` passes.
4. `cargo test --manifest-path backend/Cargo.toml` passes overall.
5. `pnpm check-types && pnpm lint && pnpm test && pnpm check:i18n` pass.
6. `pnpm --dir tests e2e --project team` passes and the recording shows the
   Computer tab and the self-check result.
7. `grep -rn "AMIRO_SANDBOX_MASTER\|AMIRO_SANDBOX_TOKEN" backend/src src` shows
   them read only in `backend/src/sandbox.rs` — never in a response builder.

## Risks

- **Bind-mount ownership.** A container uid that differs from the folder's
  owner cannot write. Mitigation: run as the owner's uid:gid (still non-root);
  refuse uid 0.
- **Snap Docker confinement** may refuse bind mounts outside `$HOME`.
  Mitigation: `~/.amiro` is under `$HOME`; the live test proves it.
- **Long tool calls vs the runtime's 120 s callback timeout.** Mitigation:
  shell timeout capped at 110 s in Phase 00 (300 s needs a runtime change,
  recorded as a follow-up).
- **Session overlay owned by a dead connection.** `configure_tools` refuses a
  live owner; each turn reconfigures on its own connection, and a dropped
  connection clears the owner. Covered by the existing runtime tests.
