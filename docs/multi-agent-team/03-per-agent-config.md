# 03 — Per-agent providers, connectors and keys

Requirement (owner, 2026-10-21): Amiro is only the default agent. Every agent
has everything of its own — AI providers and models, connectors (MCP and
Composio), saved keys, and its workspace — and the owner opens each agent's
full page to set them.

## Decision: one runtime per agent

Everything that makes up an agent's "brain and hands" already lives under two
`AppState` fields:

| Lives under | What |
| --- | --- |
| `state.runtime_home` | providers and models (`config.toml`, `auth.json`, `*_oauth.json`), connectors (`mcp.json`), the decrypted credential env (`credential-env.json`), skills, search providers, runtime memory and sessions |
| `state.runtime_socket` | the runtime process the backend talks to |
| `state.home/<PROTECTED_DIR>` | the encrypted key vault |

So an agent gets its own everything by giving it its own copy of those paths
and therefore its **own runtime process**:

```
~/.amiro/
├── runtime/                         main agent (unchanged)
├── agents/<id>/                     the agent's workspace (what its tools see)
└── agents-private/<id>/             never mounted into the agent's container
    ├── runtime/                     its runtime home: providers, mcp.json, memory, sessions
    └── protected/                   its key vault
   run/<id12>/api.sock               its runtime socket (short path: Unix sockets cap at ~108 bytes)
```

`AppState::for_agent(id)` returns a clone with `runtime_home`,
`runtime_socket` and `workspace` pointing at the agent; `home` (users,
sessions, threads, the agent registry) stays shared. `ensure_bridge` already
spawns a runtime from whatever state it is given, so the agent's runtime
starts lazily on its first use.

Rejected: one runtime with per-session provider/MCP switches. The runtime has
one provider config and one MCP registry per process; per-session overrides
would be a deep runtime fork and still share memory and auth state.

## Scoping requests

- A request is scoped to an agent by the `X-Amiro-Agent: <id>` header (the
  UI sets it on the agent page). An `AgentState` extractor resolves it
  (unknown id → 404, `main` or absent → the default state) and replaces
  `State<AppState>` in the provider, model, connector, Composio, credential,
  search and skill routes. The same pages and components then work for any
  agent.
- Chat and thread routes take the scope from the **thread entry's
  `agentId`**, never from the client, so a thread always talks to its
  agent's runtime.
- The vault root is derived from the runtime home, so `credentials.rs`
  needs no new `AppState` field (adding one would touch every test fixture).

## A new agent's starting point

The wizard asks for the brain: **copy Amiro's providers** (default; copies
`config.toml` and provider auth files, never memory, sessions or keys) or
**set up later**. Connectors and keys always start empty — that is the point
of separation.

## UI

**Open <name>** (e.g. **Open Nova**) on an agent's Team thread opens `/?agent=<id>`: the agent's
space, where the existing pages (Admin → Models & Providers, Connectors,
Admin → Keys, Schedules, Agent → Personality/Memory/Workspace) configure that
agent. The query sets the **agent scope** (`src/lib/backend/agent-scope.ts`):

- every API call then carries `X-Amiro-Agent` (`client.ts`), so the
  unchanged pages read and write that agent's runtime and vault;
- the scope survives navigation inside those pages (sessionStorage for the
  tab), because their own flows move between routes (Add provider opens
  `/admin/providers/create`);
- a banner on every main-app page says whose space it is, with **Back to
  Team** and **Switch to Amiro** (clears it and opens `/`);
- Team itself and its **Open Amiro** button clear it;
- a scope change revalidates every SWR key so no page keeps the previous
  agent's data.

The wizard's second step asks **AI providers**: start with Amiro's API-key
providers (default) or set up its own later.

## Runtime processes

The backend tracks the runtimes it started per socket (`runtime.rs`
`BRIDGE_CHILD` map), so restarting the main runtime never kills an agent's
and vice versa. An agent's runtime starts on first use and exits on its own
after the runtime's idle timeout (five minutes without clients); the main
runtime keeps its keepalive. Deleting an agent stops its runtime and removes
`agents-private/<id>` (its keys included) and its socket folder; the
workspace still moves to `agents-archive/`.

## Costs and limits

- One runtime process per active agent.
- Composio's API key and connections, the heartbeat, voice and notification
  settings stay shared for now (their state is in `home/store`, not in a
  runtime home). Schedules are per agent (`agentId` on each schedule).
- Team agents may only add remote (URL) connectors: a stdio connector would
  run on the host outside the agent's container (`connectors.rs`
  `mutate_mcp_servers` refuses it in an agent scope).
- Threads a team agent ran on the shared runtime before this change start a
  new session on the agent's runtime the next time they are used
  (`runtime: "agent"` marks threads that already live there).
- Team agents get no runtime defaults (Stage 2 rule): their MCP connectors
  reach the model only once Stage 2 allows each agent's own `mcp__*` tools.
