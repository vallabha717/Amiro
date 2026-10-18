# Composio Tool Router MCP

How the Amiro runtime loads a large remote MCP server such as Composio's
Tool Router (`https://app.composio.dev/tool_router/v3/<session>/mcp`,
Streamable HTTP, `x-api-key` header), what happens when a server exposes
hundreds of tools, and how the backend triggers a reload after writing
`mcp.json`.

Everything below is implemented in `runtime/crates`. No backend or web-frontend
changes are required to use it.

## 1. `mcp.json` schema for a Streamable HTTP server

`McpServerConfig` (`runtime/crates/amiro-base/src/mcp/protocol.rs`) already
supports Streamable HTTP with custom headers. Relevant fields:

| Field         | Type                      | Meaning |
|---------------|---------------------------|---------|
| `type`        | string                    | `"streamable-http"` (also accepts `"http"`, `"streamable_http"`, `"streamablehttp"`), or `"sse"` for legacy HTTP+SSE. An entry with only a `url` and no `command` defaults to Streamable HTTP. |
| `url`         | string                    | Endpoint, e.g. `https://app.composio.dev/tool_router/v3/<session>/mcp`. |
| `headers`     | object<string,string>     | Extra headers sent on every request. `${VAR}` / `${VAR:-default}` are env-expanded at load time. |
| `shared`      | bool (default `true`)     | Reuse one connection across sessions. Keep `true` for stateless API wrappers. |
| `enabled`     | bool (default `true`)     | Keep the entry registered but do not connect it. |
| `timeout_secs`| number (default `30`)     | Per-request reply timeout (raise for slow meta tools). |

The exact snippet the backend writes for a server named **`composio`**, into the
file `~/.jcode/mcp.json` (global) or `<project>/.jcode/mcp.json` (project-local;
`.mcp.json` and `.claude/mcp.json` are merged too, later sources winning):

```json
{
  "servers": {
    "composio": {
      "type": "streamable-http",
      "url": "https://app.composio.dev/tool_router/v3/<session>/mcp",
      "headers": {
        "x-api-key": "<composio-api-key>"
      },
      "shared": true
    }
  }
}
```

Notes:

- `"mcpServers"` is accepted as an alias for `"servers"` (Claude Code
  compatibility). Either key works; use one per file.
- The `<session>` in the URL and the API key are per-user secrets. They may also
  be written as `${COMPOSIO_API_KEY}` and
  `${COMPOSIO_SESSION}`; the runtime expands them from the environment when it
  loads the file, so the on-disk JSON can stay secret-free.
- Auth precedence: a configured `Authorization` header wins. Because Composio
  uses `x-api-key` (not `Authorization`), the runtime would only attach a stored
  OAuth bearer token if one had been saved for this exact URL via
  `amiro mcp login`. In practice none is stored, so only `x-api-key` is sent.
- Invalid entries (no `command` and no `url`, or an unusable `type`) are skipped
  with a log line rather than failing the load.

## 2. How many tools reach the model (and the eager cap)

Exposure is controlled by `tools.mcp_tools` (`McpToolsMode` in
`runtime/crates/amiro-base/src/config.rs`):

- **`auto`** (default) and **`deferred`** are identical and cache-stable.
  - On providers **with** native deferred tool loading, `mcp_search` stays
    eager and every `mcp__*` definition is sent as deferred, so the cached
    prefix never changes when servers connect late.
  - On providers **without** native deferred loading, the model sees only the
    fixed `mcp_search` / `mcp_call` surface. Per-server `mcp__*` definitions are
    removed from the tool list and described in the transcript instead
    (`announce_late_mcp_tools`). **This is why a Composio session with a handful
    of meta tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`,
    `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_GET_TOOL_SCHEMAS`, ...) loads fine
    on every provider**: it costs a fixed two-tool surface regardless of the
    server's catalog size.
- **`eager`** puts every `mcp__*` definition in the top-level tool list. That is
  the one mode where a server with hundreds of tools could bloat every request.

To keep `eager` safe there is now a configurable, global cap:

```toml
[tools]
mcp_tools = "eager"
mcp_eager_tool_limit = 100   # default; 0 disables the cap
```

- The cap counts the **union of all servers' `mcp__*` tools**. When it is
  exceeded, only a deterministic name-sorted prefix of `mcp_eager_tool_limit`
  definitions is exposed top-level; the overflow stays registered and is still
  callable through `mcp_search` / `mcp_call`, which remain in the tool list
  whenever the cap truncates anything.
- Below the cap, `eager` keeps its historical shape: all per-server tools
  top-level, no `mcp_search` / `mcp_call`.
- Env override: `AMIRO_MCP_EAGER_TOOL_LIMIT`.

Summary of worst-case top-level MCP definitions by mode:

| Provider capability        | `auto` / `deferred`     | `eager`                        |
|----------------------------|-------------------------|--------------------------------|
| native deferred loading    | ~0 (\(mcp\_search\) only) | min(tools, cap)             |
| no native deferred loading | 0 (\(mcp\_search\)+\(mcp\_call\)) | min(tools, cap) |

So the top-level MCP tool count never exceeds `mcp_eager_tool_limit`, and the
fixed `mcp_search` / `mcp_call` surface keeps any overflow reachable.

## 3. Reloading MCP after `mcp.json` changes (backend mechanism)

When the backend writes a new/changed server definition (for example
`composio`) into `mcp.json`, the running session must re-read the file and
reconnect. There are three layers:

1. **In-session `mcp` tool** — `{"action": "reload"}` on the `mcp` management
   tool re-reads config, unregisters old `mcp__*` tools, reconnects, and
   re-registers (`McpManagementTool::reload_config`). This is what the model
   calls and what the CLI/TUI `/mcp reload` maps to.
2. **Bridge API socket** — the programmatic path the backend should use. It is
   exposed as a `RuntimeCommand` variant, `McpReload`, so no model turn is
   needed. The bridge forwards it to the daemon, which runs the same reload and
   unlocks the tool snapshot.
3. **`reload-bridge`** (`runtime/crates/amiro-app-core/src/tool/bridge_reload.rs`)
   is unrelated: it restarts the *harness API bridge binary* onto a new build.
   It does not reload MCP config and must not be used for this.

### 3a. Trigger over the socket directly

Connect to the owner-only Unix socket from `amiro_harness_api::api_socket_path()`
(default `<runtime dir>/amiro-api.sock`, override with `AMIRO_API_SOCKET`).
Frames are NDJSON. First send the handshake, then the request:

```json
{"v":1,"id":1,"req":"hello","min_version":1,"max_version":1,"client":"backend/0.1.0"}
{"v":1,"id":2,"req":"runtime_command","session_id":"<session-id>","command":"mcp_reload","args":[]}
```

The reply to `id:2` is a `RuntimeCommandResult` frame:

```json
{"v":1,"reply_to":2,"ev":"runtime_command_result","session_id":"<session-id>","command":"mcp_reload","data":{"reloaded":true,"action":"reload","message":"Reloaded MCP config. Connected: 1/1\n\n## composio\n  - ...\n"},"message":"<same human-readable summary>"}
```

`command` is `"mcp_reload"` (snake_case wire name of
`amiro_harness_api::RuntimeCommand::McpReload`). `args` must be empty. Errors
are returned as an `Error` frame (for example if the session is mid-turn:
"Session is busy. Retry the MCP reload after the current turn.").

### 3b. Trigger through the SDK

The `amiro-sdk` client already wraps this:

```rust
use amiro_sdk::{HarnessClient, RuntimeCommand};

let output = client
    .runtime_command("<session-id>", RuntimeCommand::McpReload, vec![])
    .await?;
// output.data["reloaded"] == true, output.message is the human summary.
```

`runtime_command` requires the connected bridge/daemon to advertise the
`runtime_commands` capability (all current builds do). The same call works from
any client (Desktop, TUI, scripts).

### 3c. Notes for the backend agent

- Write `mcp.json` first, then send `McpReload`; the reload re-reads the file
  from disk, so there is no in-memory ordering to coordinate.
- After a successful reload the tool snapshot is unlocked on the next turn
  (`unlock_tools_if_needed("mcp")`), so `eager` mode picks up added/removed
  tools immediately. `auto`/`deferred` mode keeps its cache-stable fixed
  surface and learns about new tools through the transcript / deferred path.
- The session must be idle. A busy session returns an `Error` frame; retry
  after the current turn.
- The Amiro backend uses this path, not a debug socket: after writing `mcp.json`
  it lists the runtime's sessions and sends `McpReload` to every idle one,
  skipping any session that is mid-turn (`running`/`processing`/`busy`). No
  model turn is sent. The sync, connection-status and connection-delete replies
  report `{"reloaded": bool, "reloadedSessions": n, "skippedBusy": n}`, so a
  caller can tell "nothing to reload" from "the runtime refused".

## 4. Verification

Tests added with this change:

- `runtime/crates/amiro-base/src/config_tests.rs`:
  `tool_config_eager_tool_limit_deserializes_and_defaults`,
  `tool_config_mcp_exposure_env_overrides` (extended).
- `runtime/crates/amiro-base/src/mcp/protocol_tests.rs`:
  `composio_streamable_http_snippet_parses_with_headers` (the exact snippet
  above parses as a runnable Streamable HTTP entry, under both `servers` and the
  `mcpServers` alias).
- `runtime/crates/amiro-app-core/src/agent_tests.rs`:
  `eager_mode_caps_top_level_mcp_tools_and_keeps_search_surface`,
  `eager_mode_below_cap_keeps_historical_shape`,
  `eager_mode_zero_limit_disables_cap`,
  `composio_style_meta_tools_load_on_the_fixed_surface`.
- `runtime/crates/amiro-harness-api/src/runtime_commands.rs`:
  `mcp_reload_round_trips_as_snake_case_wire_name`,
  `server_reload_wire_name_is_unchanged`.

Run (offline, targeted):

```bash
cargo test -p amiro-base config_tests::tool_config
cargo test -p amiro-app-core mcp
cargo test -p amiro-harness-api runtime_commands
```
