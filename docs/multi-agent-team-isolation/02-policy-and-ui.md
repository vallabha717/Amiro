# 02 — Tool policy, API and UI

## Stored policy

Each record in `store/agents.json` gains:

```json
"tools": {"shell": false, "files": false, "browser": false}
```

Missing → all `false`. The main agent has no policy (its tools are the
runtime's own, unchanged).

## API (`backend/src/routes/agent_computer.rs`)

| Method & path | Who | Does |
| --- | --- | --- |
| `GET /api/agents/{id}/computer` | any user | `{tools, configured, available, state, isolation}` — `configured` = supervisor URL and secrets present; `available` = `/health` answered with Docker up; `state` from `/status` (or `null`) |
| `PATCH /api/agents/{id}/computer` | owner | `{tools: {shell?, files?, browser?}}` → the new policy. `browser: true` → 400 until Phase 03. `main` → 409 |
| `POST /api/agents/{id}/computer/check` | owner | Runs the supervisor self-check and returns it, so the owner can see the boundary measured from inside |

`isolation` is one of:

| Value | Meaning | Shown as |
| --- | --- | --- |
| `none` | every tool is off | "This agent has no tools. Nothing it does runs on this computer." |
| `container` | at least one tool on and the supervisor is available | "This agent's tools run in its own container. It can only see its own folder." |
| `unavailable` | at least one tool on, supervisor not configured or not reachable | "Its tools are on, but its container isn't available, so they will fail instead of running here." |

These are the only isolation statements the agent page makes for a team
agent. The Stage 1 `Team.isolationNote` is replaced by them.

## UI

The agent page (`src/components/team/agent-page.tsx`) gains a **Computer**
tab (`agent-tab-computer`) with:

- Two switches: **Shell** (`agent-tool-shell`) and **Files**
  (`agent-tool-files`), both off for a new agent, owner-only. Browser is not
  shown until Phase 03 builds it (honest-product rule).
- The isolation line above (`agent-isolation-note`) and the container state.
- A **Check isolation** button (`agent-computer-check`) that shows the
  self-check (`agent-computer-check-result`): user id, capabilities, whether
  the Docker socket or other agents' folders are visible.
- When the supervisor is not configured: one line pointing to
  `scripts/sandbox.sh up` (docs link), no secret fields.

Strings under `Team.computer.*` in `messages/en.json` and `messages/hi.json`.
