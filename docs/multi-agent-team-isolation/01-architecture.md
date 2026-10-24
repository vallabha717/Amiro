# 01 — Architecture

## Components and who may do what

```
 browser ── HTTPS ──► amiro-backend ──── unix socket ───► amiro-runtime (host)
                        │   ▲                              │  team-agent session:
                        │   │ ToolCall(agent_shell, …)     │  built-in + MCP tools OFF,
                        │   └──────────────────────────────┘  custom tools = policy
                        │
                        │ HTTP 127.0.0.1:4313
                        │ Bearer <supervisor token>
                        │ X-Amiro-Agent-Credential: HMAC(master, "amiro-agent:"+id)
                        ▼
                 amiro-sandboxd (container)  ── /var/run/docker.sock ──► Docker Engine
                 cap_drop ALL, no-new-privileges,                         │
                 read-only rootfs, loopback port only                    ▼
                                                     amiro-agent-<id> (one per team agent)
                                                     user = owner uid (never 0), CapDrop ALL,
                                                     no-new-privileges, read-only rootfs,
                                                     memory/CPU/pids limits, tmpfs /tmp,
                                                     only ~/.amiro/agents/<id> → /home/agent
```

| Holder | Has | Does not have |
| --- | --- | --- |
| backend | supervisor token, master (derives per-agent credentials) | Docker socket |
| supervisor | Docker socket, supervisor token, master (to verify credentials) | model keys, vault, any agent folder contents |
| agent container | its own folder | Docker socket, supervisor token, master, any credential, other agents' folders, the vault, `~/.amiro/workspace` |
| runtime | the session; it only *names* the tool call | the supervisor address or any sandbox secret |

## Tool routing in a turn

1. `chat.rs` resolves the thread's `agentId` (Stage 1). For a team agent it
   reads the agent's tool policy and puts an `AgentToolset { agent_id, policy }`
   on the `TurnPlan`.
2. `runtime::drive_turn` calls `configure_tools(enabled: Some([]), custom:
   <defs for the switched-on tools>)` on the turn's own connection. `enabled:
   []` turns off every built-in and MCP tool for the session.
3. **Belt and braces:** if a session's working folder is inside
   `AMIRO_AGENTS_ROOT` and the plan carries no toolset (some other caller),
   `drive_turn` still applies `enabled: []` with no custom tools. A team
   agent folder can never get host tools.
4. The model calls `agent_shell` (say). The runtime emits `ToolCall`; the
   turn worker recognises an agent tool, runs it through the supervisor on a
   helper thread and answers with `submit_tool_result`. The runtime then
   emits `ToolDone`, which the chat stream already renders. The chat stream
   marks these calls `providerExecuted` so the UI never tries to answer them.
5. Supervisor unreachable, container fails to start, tool switched off since
   the turn began → the tool result is an error string that says which. No
   host fallback exists in the code.

## Tools

| Policy switch | Tool names | Runs |
| --- | --- | --- |
| `shell` | `agent_shell` `{command, timeoutSecs?}` | `sh -lc <command>` in `/home/agent`, 60 s default, 300 s max, 64 KiB output cap |
| `files` | `agent_read_file` `{path}` · `agent_write_file` `{path, content}` · `agent_list_files` `{path?}` | relative paths under `/home/agent`; read cap 256 KiB, write cap 1 MiB |
| `browser` | — (Phase 03) | |

Paths are validated twice: the backend rejects absolute paths and `..`; the
supervisor does the same and then acts **inside the container**, so even a
symlink the agent planted resolves in the container's filesystem, never on
the host.

## Supervisor API (`amiro-sandboxd`, `/v1`)

Every route except `/health` needs `Authorization: Bearer <supervisor token>`.
Agent-scoped routes also need `X-Amiro-Agent-Credential` equal to the
credential for the `{id}` in the path (constant-time compare). Ids must match
`^[a-f0-9]{32}$`, the same rule as the agent registry.

| Method & path | Does |
| --- | --- |
| `GET /health` | `{ok, docker}` — no auth, no detail |
| `POST /v1/agents/{id}/ensure` | create (if missing) and start the agent's container; replaces it when its spec hash label differs |
| `POST /v1/agents/{id}/stop` | stop it (files stay on the host) |
| `GET /v1/agents/{id}/status` | `{state: missing|running|stopped, image, runtime, network}` |
| `POST /v1/agents/{id}/exec` | `{command, timeoutSecs}` → `{exitCode, output, truncated, timedOut}` (ensures first) |
| `POST /v1/agents/{id}/files/read` | `{path}` → `{content, truncated}` |
| `POST /v1/agents/{id}/files/write` | `{path, content}` → `{bytes}` (Docker archive upload into `/home/agent`) |
| `POST /v1/agents/{id}/files/list` | `{path}` → `{entries: [{name, kind, size}]}` |
| `GET /v1/agents/{id}/selfcheck` | `{uid, gid, capEff, noNewPrivs, homeEntries, dockerSocket, readOnlyRoot, network, runtime}` — measured inside the container |

The caller never supplies an image, mount, user, capability or Docker
option. Those come only from the supervisor's own environment.

## Container spec

Built by one pure function (`sandboxd::spec::container_spec`) so a unit test
can assert every hardening field:

| Field | Value |
| --- | --- |
| `name` | `<namespace>-agent-<id>` |
| `Image` | `AMIRO_SANDBOX_IMAGE` (default `amiro-agent:local`) |
| `User` | `AMIRO_SANDBOX_USER` = the owner's `uid:gid`; uid `0` refused at start-up |
| `Cmd` | `sleep infinity` (an idle shell host; `Init: true` reaps children) |
| `WorkingDir` / `HOME` | `/home/agent` |
| `Env` | `HOME`, `AMIRO_AGENT_ID` only — no credential, no token |
| `HostConfig.Mounts` (bind) | `<AMIRO_SANDBOX_AGENTS_ROOT>/<id>` → `/home/agent` — the only mount. For `main` (Amiro's desktop) it is Amiro's own workspace, `AMIRO_SANDBOX_MAIN_WORKSPACE` (default `<AMIRO_HOME>/workspace`) |
| `CapDrop` / `SecurityOpt` | `["ALL"]` / `["no-new-privileges:true"]` (off only on snap-packaged Docker, see 03) |
| `ReadonlyRootfs` + `Tmpfs` | `true` + `/tmp: rw,nosuid,nodev,size=64m` |
| `Memory` = `MemorySwap`, `NanoCpus`, `PidsLimit` | 1 GiB, 1 CPU, 1024 (env-overridable; the virtual desktop needs ~300) |
| `NetworkMode` | `bridge` (default) or `none` (`AMIRO_SANDBOX_NETWORK`) |
| `Runtime` | unset, or `runsc` (`AMIRO_SANDBOX_RUNTIME`) |
| `Privileged`, `Devices`, `PortBindings` | never set |
| `Labels` | `amiro.sandbox.namespace`, `amiro.sandbox.agentId`, `amiro.sandbox.specHash` |

## Credentials

- `supervisor token` and `master`: 32 random bytes each, hex, in
  `$AMIRO_HOME/sandbox/supervisor.env` (`0600`, created by
  `scripts/sandbox.sh up` if missing). The backend reads that file (or
  `AMIRO_SANDBOX_TOKEN` / `AMIRO_SANDBOX_MASTER` from its environment);
  the script reads the same file and passes both values to compose as
  environment (not `env_file`: snap-packaged Docker's CLI cannot read hidden
  folders such as `~/.amiro`).
- Agent credential = lowercase hex of `HMAC-SHA256(master, "amiro-agent:" + id)`,
  computed in one shared function (`sandboxd::credential::agent_credential`)
  used by both sides. A credential for agent A is rejected on agent B's routes.
- The credential is **not** placed in the container in Phase 00: nothing in
  the container needs to call back yet. Phase 02 decides whether an in-container
  helper gets it.
