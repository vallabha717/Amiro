# Connectors

Connectors are everything the agent can reach outside itself: apps connected
through Composio and any MCP server, remote (Streamable HTTP or SSE) or local
(a command that runs on this machine). They used to live on two pages,
Connectors (Composio) and MCP Configuration; they are now one page at
`/connectors`, and the old `/mcp` routes forward there.

The model follows Vellum: the UI shows one list, while each source keeps its
own setup flow, and the agent can add connectors itself without ever seeing a
secret.

## One source of truth

Every connector is an entry in the runtime's MCP config,
`$AMIRO_RUNTIME_HOME/mcp.json` (`{"servers": {...}}`, `mcpServers` also
accepted). Composio's Tool Router is the `composio` entry; custom servers are
the rest. The backend and the runtime's `mcp` tool both edit the raw file
(no env expansion), keep every other entry and unknown top-level key, and
write atomically with mode 0600.

Before this change the MCP Configuration page saved servers to
`~/.amiro/store/mcp-servers.json`, which nothing synced to the runtime, so
those servers never reached the agent. The first `GET /api/connectors`
migrates them into `mcp.json` and renames the old file to
`mcp-servers.migrated.json`.

## Secrets

A secret is never written to `mcp.json`. It is stored in the encrypted
credential vault as service `mcp.<name>`, field `<field>`, and the config
references it by placeholder:

```json
"headers": { "Authorization": "Bearer ${AMIRO_CRED_MCP_LINEAR_AUTHORIZATION}" }
```

The placeholder is `${AMIRO_CRED_MCP_<NAME>_<FIELD>}` (upper case,
non-alphanumerics as `_`), the same name the vault already exports to the
runtime's environment. Because that environment is fixed when the runtime
starts, the backend also mirrors every vault variable into
`$AMIRO_RUNTIME_HOME/credential-env.json` (0600) on each credential change,
and the runtime's MCP config expansion reads it after the process
environment. A new key therefore works on the next reload, with no runtime
restart and no dropped turns.

The runtime does not dial a server while one of its `${AMIRO_CRED_…}`
placeholders is unresolved; it reports "waiting for a key" instead of
earning a 401. Its reconnect cooldown after a failure applies only while the
resolved config is unchanged, so a key that just arrived retries at once.

The secrets a server needs are derived from its placeholders; there is no
separate metadata file. When a header template carries a prefix
(`Bearer ${…}`), a pasted value that repeats it (`Bearer abc…`) is stored
without it.

## The agent sets up connectors

The runtime's `mcp` tool has two persistent actions besides
`list/connect/disconnect/reload/status/logout`:

- `add`: `server` plus `url` (+ `transport`, `headers`) or `command`
  (+ `args`, `env`), and `secrets: [{key, header | env, prefix?}]`. It writes
  the entry with placeholders for the secrets, connects if every secret is
  already present, and otherwise tells the model to wait for the user. It
  rejects values that look like a literal token (`sk-…`, `ghp_…`,
  `Bearer <long>`, long opaque strings) so the model cannot paste secrets into
  the config. A local `command` also goes through the bash destructive-command
  gate. Its output ends with a machine-readable line:
  `CONNECTOR_SETUP {"missingSecrets":["authorization"],"server":"linear"}`.
- `remove`: deletes the entry and disconnects it. `composio` is managed on
  the Connectors page and refused here.

`mcp_call_requires_approval` classifies `add`, `remove` and `connect` with a
`command` as needing approval. The runtime itself has no per-tool approval
gate; the host enforces it.

In the chat, a `mcp` tool result carrying `CONNECTOR_SETUP` renders a secure
card (`src/components/connectors/connector-setup-card.tsx`) with a password
field for each missing key. The value goes straight to
`PUT /api/connectors/custom/{name}/secrets`, never into the transcript or the
model's context. Once saved, "Continue with <name>" tells the agent the key
is in, and it connects and carries on.

## Backend API (`backend/src/routes/connectors.rs`)

Reads need a session; changes need the owner.

| Route | Purpose |
| --- | --- |
| `GET /api/connectors` | `{composio:{configured}, statusAvailable, servers:[…]}`. Each server has name, source (`composio`/`custom`), transport, url or command/args, header and env NAMES (never values), enabled, secrets (`field`, `envVar`, `location`, `prefix`, `present`), status (`connected`, `error`, `disabled`, `needs-secret`, `unknown`), error and tools. |
| `POST /api/connectors/custom` | Create or edit a custom server. Header/env entries marked `secret` go to the vault; blank values on edit keep the current ones. |
| `PUT /api/connectors/custom/{name}/secrets` | Store keys the server's placeholders reference. |
| `POST /api/connectors/{name}/enabled` | Turn any entry on or off, Composio included. |
| `DELETE /api/connectors/custom/{name}` | Remove a custom server and its vault keys. |
| `POST /api/connectors/reload` | Reload MCP in idle sessions and return the fresh list. |

Live status comes from the runtime command `mcp_status`
(`RuntimeCommand::McpStatus`), which reads a session's MCP manager without
taking the agent lock and reports every configured server with its
connection, last error and tools. The backend asks the most recently active
idle session and caches the answer for five seconds. With no session running,
`statusAvailable` is false and servers read as `unknown`.

## UI

`src/components/connectors/`:

- `connectors-page.tsx`: the page. "Your connectors" lists custom servers
  and connected Composio apps with status, tools, an on/off switch and
  Edit / Update keys / Remove; the Composio app catalog (or its key setup)
  follows.
- `connector-dialogs.tsx`: "Add custom" (remote URL with bearer or API-key
  header auth and extra headers, or a local command with environment
  variables; any row can be marked secret) and the secure keys form.
- `connector-setup-card.tsx`: the in-chat card for agent-added connectors.

`src/lib/backend/connectors-api.ts` holds the client, the slug and
command-line helpers and the `CONNECTOR_SETUP` parser.

## Verification (2026-10-18)

- Backend `cargo test connectors`: 9 passed (placeholders, prefix stripping,
  preservation of other entries, migration, the HTTP lifecycle).
- Runtime: `amiro-base` MCP tests 116 passed, `amiro-app-core` `tool::mcp`
  32 passed, `amiro-storage` 45, `amiro-harness-api` 12.
- Frontend: `src/lib/backend/connectors-api.test.ts` 4 passed.
- End to end on an isolated stack with a scripted LLM and a test MCP server
  that requires a bearer token: `/mcp` forwarded to `/connectors`; a migrated
  legacy server showed its auth error; a server added in the dialog connected
  with its two tools, turned off and was removed; asked to "connect the demo
  MCP server", the agent called `mcp add`, the secure card took the token, the
  agent connected and confirmed. The token never appeared in the chat, the
  LLM requests or `mcp.json`, and the browser logged no errors.

## Limits

- OAuth-only remote servers still need `amiro mcp login <server>` in a
  terminal; there is no browser OAuth flow for custom servers yet.
- Status reflects one session's MCP manager. A server can be connected in one
  session and still dialing in another.
- Vault variables are visible to processes the runtime starts (the existing
  vault design); they are kept out of the transcript and the model's prompt,
  not out of the machine.
