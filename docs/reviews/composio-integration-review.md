# Composio integration review

Review snapshot: 2026-10-18 09:06 UTC. Implementation is being edited by another swarm, so findings describe this snapshot and must be rechecked after fixes.

## Independent verification

From `backend/`, `cargo test --test composio --test credentials` passed. The credential suite passed five tests covering authentication, input validation, secret redaction, admin-only writes and validation input handling. These are integration tests, not proof that a genuine Composio OAuth connection or normal chat tool turn works.

## Priorities before declaring completion

1. **Use the typed runtime reload path.** `routes/composio.rs::request_reload` derives a debug socket from `state.runtime_socket`, which is the harness API socket. With `amiro-api.sock`, that produces `amiro-api-debug.sock`, not the daemon's `amiro-debug.sock`. It also omits a target session. The SDK supports `HarnessClient::runtime_command(session_id, RuntimeCommand::McpReload, vec![])`. This method is synchronous, so use a blocking task following the existing backend runtime helper pattern. The bridge and daemon must include the new command before deployment.
2. **Handle existing sessions and changed credentials.** Reload the intended existing chat sessions, not an arbitrary default session. Busy-session failures should remain explicit and retryable. A saved or rotated API key does not update the environment of an already running daemon. An environment placeholder in `mcp.json` needs a controlled restart or another explicit secure refresh mechanism.
3. **Do not confuse Composio entity filtering with runtime isolation.** API calls filter by the authenticated Amiro user ID, but sync writes a single global `composio` entry in one shared runtime home. One user's sync or disconnect can replace or remove another user's runtime integration. Until runtime/session isolation exists, enforce and explain a single-operator boundary for shared runtime mutations.
4. **Keep upstream errors secret-free.** `composio_rejected` currently accepts upstream `error.message` or `message` text into client errors. A length limit does not prevent an echoed key, session URL or user information from leaking. Use sanitized fixed errors or a narrowly validated error-code mapping, and test a credential sentinel in upstream errors.
5. **Verify normal chat exposure.** The running backend's trusted-operator/tool-profile flags were unset during the earlier readiness check. The runtime can have MCP tools registered while normal app chat offers no tools. Test through the actual app session policy. Do not enable every tool or automatic approval merely to hide the gap.

## Documentation corrections

- Amiro's embedded runtime home is normally `~/.amiro/runtime`, not `~/.jcode`.
- `HarnessClient::runtime_command` returns a synchronous `Result`, not an awaitable future.
- A provider without native deferred tools still gets the fixed `mcp_search` and `mcp_call` definitions, so a table describing top-level definitions should count two, not zero.
- Encrypted-at-rest credentials in the backend are not a separate-process credential broker or OS sandbox. The master key and encrypted records reside on the same host.

## Acceptance checklist

- Authenticated UI save/test yields masked metadata only.
- Saving a key before the first connection and rotating one after a daemon starts both work without plaintext in UI, logs or exported configuration.
- Sync preserves unrelated MCP entries and removal disconnects the intended integration.
- An existing chat session receives the new definitions after a typed reload without a paid model turn.
- Busy sessions expose a retryable status rather than false completion.
- An ordinary second user cannot replace the operator's shared runtime integration.
- Unknown/unsupported commands from an older bridge return an actionable error.
- The real chat policy exposes intended MCP tools and denies prohibited tools.
- Actual Composio authorization and a non-destructive tool call require authorized service access. Local fixtures cannot establish this final external boundary.
