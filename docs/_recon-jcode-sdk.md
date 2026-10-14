# Jcode SDK Reconnaissance Report

- Date: 2026-10-14
- Jcode Binary: v0.95.0 (6487bbd7e)
- Node Runtime: v26.4.0
- SDK: `@1jehuang/jcode-sdk` (protocol v1, API version 1.9)
- Live Bridge: `jcode api-bridge --api-socket /root/.jcode/scratch/amiro-api.sock`

---

## 1. Full JcodeClient Method Signatures

Exported from `@1jehuang/jcode-sdk` (`dist/client.d.ts`):

### Static Methods

- `static launch(options?: LaunchOptions & ConnectOptions): Promise<JcodeClient>`
  Starts an isolated private jcode daemon and bridge process under a dedicated `JCODE_HOME` and connects to it. Shuts down on `client.close()`.
- `static connect(options?: ConnectOptions): Promise<JcodeClient>`
  Connects to an existing jcode instance via Unix domain socket (or named pipe on Windows) or custom duplex transport.

### Instance Properties & Inspection

- `server: string`
  Server identity string returned from handshake (e.g. `jcode-harness-api-bridge/0.1.0`).
- `capabilities: string[]`
  List of capability strings advertised by the bridge.
- `supports(capability: string): boolean`
  Checks whether a given capability string is present in `capabilities`.
- `get instanceHome(): string | undefined`
  Path to the ephemeral or persistent instance directory if launched via `launch()`.

### Session Lifecycle & Management

- `createSession(options?: string | CreateSessionOptions): Promise<SessionInfo>`
- `listSessions(options?: { includeArchived?: boolean; limit?: number }): Promise<SessionInfo[]>`
- `listSessionsLimited(limit: number): Promise<SessionInfo[]>`
- `attachSession(sessionId: string): Promise<SessionInfo>`
- `forkSession(sessionId: string): Promise<SessionInfo>`
- `detachSession(sessionId: string): Promise<void>`
- `archiveSession(sessionId: string): Promise<void>`
- `restoreSession(sessionId: string): Promise<void>`
- `setRetentionPolicy(archiveAfterDays?: number): Promise<void>`
- `renameSession(sessionId: string, title?: string): Promise<void>`
- `setSessionSaved(sessionId: string, saved: boolean, label?: string): Promise<void>`

### Tools Configuration & Execution

- `listTools(sessionId: string): Promise<SessionToolDefinition[]>`
- `configureTools(sessionId: string, options: SessionToolsOptions): Promise<void>`
- `submitToolResult(sessionId: string, callId: string, result: string | ToolResult): Promise<void>`
- `backgroundTool(sessionId: string): Promise<void>`
- `backgroundToolResult(sessionId: string): Promise<{ moved: boolean; toolCallId?: string; toolName?: string }>`

### Messaging, Turns & Streaming

- `sendMessage(sessionId: string, content: string, options?: SendMessageOptions): Promise<void>`
- `sendMessage(sessionId: string, content: string, images?: ImageAttachment[], options?: Omit<SendMessageOptions, "images">): Promise<void>`
- `sendSystemReminder(sessionId: string, reminder: string): Promise<void>`
- `cancel(sessionId: string): Promise<void>`
- `softInterrupt(sessionId: string, content: string, urgent?: boolean): Promise<void>`
- `softInterruptWithImages(sessionId: string, content: string, images: ImageAttachment[], urgent?: boolean): Promise<void>`
- `softInterruptWithId(sessionId: string, content: string, options?: { clientId?: string; images?: ImageAttachment[]; urgent?: boolean }): Promise<void>`
- `cancelSoftInterrupts(sessionId: string): Promise<void>`
- `cancelSoftInterruptsById(sessionId: string, clientIds: string[]): Promise<{ cancelled: string[]; notQueued: string[] }>`
- `cancelSoftInterrupt(sessionId: string, clientId: string): Promise<boolean>`
- `events(sessionId?: string): AsyncIterableIterator<ApiEvent>`
- `globalEvents(options?: GlobalEventsOptions): AsyncIterableIterator<ApiEvent>`
- `run(sessionId: string, content: string, options?: RunOptions): Promise<TurnResult>`
- `runStructured<T = unknown>(sessionId: string, content: string, options: RunStructuredOptions<T>): Promise<StructuredTurnResult<T>>`

### History, Context & Undo

- `getHistory(sessionId: string): Promise<HistoryMessage[]>`
- `getHistoryWithImages(sessionId: string): Promise<{ messages: HistoryMessage[]; images: RenderedImage[] }>`
- `peekSession(sessionId: string, limit?: number): Promise<HistoryMessage[]>`
- `clear(sessionId: string): Promise<void>`
- `rewind(sessionId: string, messageIndex: number): Promise<void>`
- `rewindUndo(sessionId: string): Promise<void>`
- `compact(sessionId: string): Promise<string>`

### Models & Provider Routing

- `listModels(sessionId: string): Promise<{ models: string[]; current?: string }>`
- `getRuntimeInfo(sessionId: string): Promise<RuntimeInfo>`
- `setModel(sessionId: string, model: string): Promise<void>`
- `setReasoningEffort(sessionId: string, effort: string): Promise<void>`
- `setApiKey(provider: string, apiKey: string): Promise<void>`
- `clearApiKey(provider: string): Promise<void>`
- `notifyAuthChanged(provider: string): Promise<void>`
- `invalidateUsage(provider: string, accountLabel?: string): Promise<void>`

### Filesystem & Workspace Operations

- `readFile(sessionId: string, path: string, maxBytes?: number): Promise<FileContent>`
- `findFiles(sessionId: string, query: string, limit?: number): Promise<string[]>`
- `searchText(sessionId: string, query: string, options?: { path?: string; limit?: number }): Promise<TextMatch[]>`
- `fileStatus(sessionId: string, path: string): Promise<FileStatus>`

### Applets & Native Controls

- `appletAction(sessionId: string, instance: string, action: AppletAction, state?: Record<string, unknown>, sourceKey?: string): Promise<void>`
- `closeApplet(sessionId: string, instance: string): Promise<void>`

### Permissions & Policy

- `respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>`
- `todoState(sessionId: string): Promise<TodoSnapshot>`
- `ackTodoFollowUp(sessionId: string, effects: TodoEffects): Promise<void>`

### Transport & Raw Frames

- `request(request: ApiRequest): Promise<ServerFrame>`
- `notify(request: ApiRequest): void`
- `ping(): Promise<void>`
- `close(): Promise<void>`

---

## 2. Protocol Frames (`protocol.d.ts`)

Wire framing uses newline-delimited JSON (NDJSON). Every client request has tag `req`, request identifier `id`, and protocol version `v: 1`. Every server frame has event tag `ev` or error code, version `v: 1`, and optional correlation tag `reply_to`.

### Client Requests (`KNOWN_REQUEST_KINDS`, 42 kinds)

1. `hello`: `{ min_version: number, max_version: number, client: string }`
2. `list_sessions`: `{ include_archived?: boolean, limit?: number }`
3. `archive_session`: `{ session_id: string }`
4. `restore_session`: `{ session_id: string }`
5. `set_retention_policy`: `{ archive_after_days?: number }`
6. `create_session`: `{ working_dir?: string, system_prompt?: string }`
7. `attach_session`: `{ session_id: string }`
8. `fork_session`: `{ session_id: string }`
9. `detach_session`: `{ session_id: string }`
10. `configure_tools`: `{ session_id: string, tools: ToolConfiguration }`
11. `list_tools`: `{ session_id: string }`
12. `tool_result`: `{ session_id: string, call_id: string, output: string, error?: string }`
13. `send_message`: `{ session_id: string, content: string, images?: ImageAttachment[], no_reply?: boolean, system_reminder?: string }`
14. `cancel`: `{ session_id: string }`
15. `soft_interrupt`: `{ session_id: string, content: string, images?: ImageAttachment[], urgent?: boolean, client_id?: string }`
16. `get_history`: `{ session_id: string }`
17. `peek_session`: `{ session_id: string, limit?: number }`
18. `clear`: `{ session_id: string }`
19. `rewind`: `{ session_id: string, message_index: number }`
20. `permission_response`: `{ session_id: string, request_id: string, decision: "allow" | "allow_always" | "deny" }`
21. `list_models`: `{ session_id: string }`
22. `get_runtime_info`: `{ session_id: string }`
23. `set_api_key`: `{ provider: string, api_key: string }`
24. `clear_api_key`: `{ provider: string }`
25. `notify_auth_changed`: `{ provider: string }`
26. `invalidate_usage`: `{ provider: string, account_label?: string }`
27. `read_file`: `{ session_id: string, path: string, max_bytes?: number }`
28. `find_files`: `{ session_id: string, query: string, limit?: number }`
29. `search_text`: `{ session_id: string, query: string, path?: string, limit?: number }`
30. `file_status`: `{ session_id: string, path: string }`
31. `get_todo_state`: `{ session_id: string }`
32. `ack_todo_follow_up`: `{ session_id: string, effects: TodoEffects }`
33. `set_model`: `{ session_id: string, model: string }`
34. `set_reasoning_effort`: `{ session_id: string, effort: string }`
35. `compact`: `{ session_id: string }`
36. `rename_session`: `{ session_id: string, title?: string }`
37. `set_session_saved`: `{ session_id: string, saved: boolean, label?: string }`
38. `applet_action`: `{ session_id: string, instance: string, action: AppletAction, state?: Record<string, unknown>, source_key?: string }`
39. `close_applet`: `{ session_id: string, instance: string }`
40. `rewind_undo`: `{ session_id: string }`
41. `cancel_soft_interrupts`: `{ session_id: string, client_ids?: string[] }`
42. `background_tool`: `{ session_id: string }`
43. `ping`: `{}`

### Server Events (`KNOWN_EVENT_KINDS`, 47 kinds)

1. `hello_ok`: `{ version: number, server: string, capabilities?: string[] }`
2. `ok`: `{}`
3. `error`: `{ code: "unsupported_version" | "unknown_request" | "unknown_session" | "invalid_request" | "internal", message: string }`
4. `sessions`: `{ sessions: SessionInfo[] }`
5. `attached`: `{ session: SessionInfo }`
6. `session_forked`: `{ session: SessionInfo }`
7. `history`: `{ session_id: string, messages: HistoryMessage[], images?: RenderedImage[] }`
8. `side_pane_images`: `{ session_id: string, images: RenderedImage[] }`
9. `side_panel_state`: `{ session_id: string, snapshot: SidePanelSnapshot }`
10. `applet_state`: `{ session_id: string, snapshot: AgentApplets }`
11. `pong`: `{}`
12. `text_delta`: `{ session_id: string, text: string, message_id?: string }`
13. `text_done`: `{ session_id: string, message_id?: string }`
14. `text_replace`: `{ session_id: string, message_id?: string, text: string }`
15. `reasoning_delta`: `{ session_id: string, text: string }`
16. `reasoning_done`: `{ session_id: string, duration_secs?: number }`
17. `tool_start`: `{ session_id: string, call_id: string, name: string }`
18. `tools`: `{ session_id: string, tools: SessionToolDefinition[] }`
19. `tool_call`: `{ session_id: string, call_id: string, name: string, input: unknown }`
20. `tool_input_delta`: `{ session_id: string, call_id: string, delta: string }`
21. `tool_exec`: `{ session_id: string, call_id: string, name: string }`
22. `tool_done`: `{ session_id: string, call_id: string, name: string, output: string, error?: string }`
23. `token_usage`: `{ session_id: string, input: number, output: number, cache_read_input?: number, cache_creation_input?: number }`
24. `kv_cache_miss`: `{ session_id: string, reason: string, harness_caused: boolean, missed_tokens: number, expected_tokens: number, read_tokens: number, documented_cause?: string, message: string }`
25. `turn_done`: `{ session_id: string, pending_soft_interrupts?: number }`
26. `soft_interrupt_injected`: `{ session_id: string, client_ids: string[], point: string, tools_skipped?: number, display_role?: string }`
27. `soft_interrupts_cancelled`: `{ cancelled: string[], not_queued: string[] }`
28. `background_tool_result`: `{ moved: boolean, tool_call_id?: string, tool_name?: string }`
29. `turn_stopped`: `{ session_id: string, reason: TurnStopReason, message: string, provider_stop_reason?: string }`
30. `wake_requested`: `{ session_id: string, reason: string, notification: string }`
31. `background_progress`: `{ session_id: string, task_id: string, label: string, percent?: number, summary: string, done?: boolean }`
32. `message_accepted`: `{ session_id: string }`
33. `permission_request`: `{ session_id: string, request_id: string, tool_name: string, description: string }`
34. `session_status`: `{ session_id: string, status: string, pending_soft_interrupts?: number }`
35. `session_recovery`: `{ session_id: string, continuation_message: string, reconnect_notice?: string }`
36. `connection_phase`: `{ session_id: string, phase: string }`
37. `model_info`: `{ session_id: string, provider?: string, model?: string, reasoning_effort?: string, auth_method?: string }`
38. `models`: `{ session_id: string, models: string[], current?: string }`
39. `runtime_info`: `{ session_id: string, provider?: string, model?: string, reasoning_effort?: string, auth_method?: string, routes: ModelRouteInfo[] }`
40. `credential_updated`: `{ provider: string, configured: boolean }`
41. `file_content`: `{ session_id: string, path: string, content: string, size: number, truncated: boolean }`
42. `files`: `{ session_id: string, paths: string[] }`
43. `text_matches`: `{ session_id: string, matches: TextMatch[] }`
44. `file_status`: `{ session_id: string, path: string, exists: boolean, kind: string, size?: number, modified_ms?: number }`
45. `todo_state`: `{ session_id: string, state: TodoSnapshot }`
46. `compacted`: `{ session_id: string, message: string }`
47. `session_renamed`: `{ session_id: string, title?: string, display_title: string }`

---

## 3. Capabilities Advertised by the Bridge

The bridge returned `server: "jcode-harness-api-bridge/0.1.0"` with 18 advertised capabilities:

1. `sessions`
2. `streaming`
3. `text_framing`
4. `turn_stop_reasons`
5. `side_panel`
6. `persisted_session_discovery`
7. `runtime_info`
8. `api_key_provisioning`
9. `auth_changed_notification`
10. `usage_invalidation`
11. `session_archive`
12. `session_retention`
13. `session_files`
14. `session_fork`
15. `todo_state`
16. `session_tools`
17. `soft_interrupt_ids`
18. `background_tool_result`

Notice that `permissions` is NOT advertised by the bridge.

---

## 4. Live Verification Results (Step 4 Calls)

Executed against live bridge socket `/root/.jcode/scratch/amiro-api.sock`:

| Call | Result | Details |
|------|--------|---------|
| `JcodeClient.connect` | PASS | Connected to bridge socket. Server: `jcode-harness-api-bridge/0.1.0` |
| Capability `session_tools` check | PASS | `client.supports("session_tools")` returned `true` |
| `createSession` | PASS | Created session `session_bird_1791974904991_8e2e7ec058a70433` with scratch workingDir |
| `listTools` | PASS | Returned 34 active tools |
| `configureTools` (`enabled: []`) | PASS | Bridge accepts tool configuration and policy update without error |
| `getRuntimeInfo` | PASS | Healthy, returned provider `OpenAI-compatible`, model `anthropic/claude-sonnet-4`, and 150 route entries |
| `listModels` | PASS | Returned 150 models |
| `listSessions` | PASS | Returned 51 active sessions |
| `getHistory` | PASS | Returned 0 messages for fresh session |
| `sendMessage` / `run` | FAIL (expected) | Exact error below |

### Exact Error on Message Turn:
```
internal: OpenAI-compatible chat request failed
  endpoint: https://personal9router.xn--vnda-5g5a.com/v1/chat/completions
  model: anthropic/claude-sonnet-4
  auth: OPENAI_COMPAT_API_KEY
  status: 404 Not Found
  response: {"error":{"message":"No active credentials for provider: anthropic","type":"invalid_request_error","code":"model_not_found"}}
Hint: the endpoint or model was not found. Check that the base URL includes the API version (usually /v1) and that the model exists on the provider.
```

---

## 5. Usage-Source Schemas and Field Definitions

### A. CLI Command: `jcode usage --json` (Read-only)

Returns top-level object `{ "providers": ProviderUsage[] }`:

```typescript
interface ProviderUsage {
  provider_name: string;           // e.g. "OpenAI (ChatGPT) (v***7@gmail.com)"
  limits: Array<{
    name: string;                  // e.g. "5-hour window", "7-day window"
    usage_percent: number;         // e.g. 0.0 or 91.1
    resets_at: string;             // ISO-8601 UTC timestamp
    reset_in: string;              // Human readable, e.g. "4h 34m"
  }>;
  extra_info: Array<[string, string]>; // Key-value pairs: ["Account", "..."], ["Plan", "..."], ["Today", "..."]
  banked_reset?: {
    provider: string;              // e.g. "openai"
    account_label: string;         // e.g. "openai-otter"
    available_count: number;       // e.g. 1
    limit_reached: boolean;
    next_available_at: string | null;
  };
  error: string | null;
}
```

### B. SQLite Database: `~/.jcode/model-usage-v1.sqlite3`

Contains two tables:

1. Table `tracking`:
   - `id INTEGER PRIMARY KEY CHECK(id=1)`
   - `started INTEGER NOT NULL` (unix timestamp seconds when tracking began)

2. Table `turns`:
   - `turn_id TEXT NOT NULL` (composite format: `<sessionId>:<messageId>`)
   - `model TEXT NOT NULL` (e.g. `gpt-6.1-sol`, `deepseek-v4.1-flash`)
   - `provider TEXT NOT NULL` (e.g. `openai`, `opencode-go`)
   - `api_method TEXT NOT NULL` (e.g. `openai-oauth`, `openai-compatible:opencode-go`)
   - `last_used INTEGER NOT NULL` (unix timestamp seconds)
   - Primary Key: `(turn_id, model, provider, api_method)`

### C. JSON File: `~/.jcode/openai_oauth_usage.json`

Top-level object: `{ "accounts": Record<string, AccountUsage> }` where keys are account labels (e.g. `openai-otter`).

```typescript
interface AccountUsage {
  first_recorded: number;          // Unix timestamp seconds
  lifetime: TokenCostStats;
  days: Record<string, TokenCostStats>; // Keys are YYYY-MM-DD
}

interface TokenCostStats {
  requests: number;                // Count of requests
  input: number;                   // Input tokens
  output: number;                  // Output tokens
  cached: number;                  // Prompt cached tokens
  known_usd: number;               // Floating point estimated USD
  unpriced_requests: number;       // Requests where pricing metadata was not available
  incomplete_requests: number;     // Aborted or failed requests
}
```

---

## 6. Gotchas for Building a Node Adapter

1. **One active session attachment per connection**:
   The bridge connects one client connection to one session attachment at a time (`attached` frame). To observe all sessions globally, use `client.globalEvents()`, which spawns and manages per-session child socket connections internally.

2. **Socket Path & Platform named pipe derivation**:
   On Linux/macOS, the bridge socket is a standard Unix domain socket at `$XDG_RUNTIME_DIR/jcode-api.sock` (or `/run/user/<uid>/jcode-api.sock`). On Windows, it is a named pipe derived as `\\\\.\\pipe\\<stem>-<sha256_hash>`. Always use the SDK's `transportEndpoint()` or pass `socketPath` directly to `unixSocketTransport()`.

3. **`session_tools` capability guard**:
   The TypeScript SDK enforces `client.supports("session_tools")` before allowing `client.configureTools(...)`. Because the bridge advertises this capability, configureTools succeeds. However, older daemon bridges might omit it, resulting in client-side rejection before wire transmission.

4. **`send_message` does not generate a request-level reply**:
   `send_message` does not reply with an `ok` frame. The server emits an asynchronous `message_accepted` event once queued. The SDK handles this by waiting for `message_accepted` (with `acceptTimeoutMs` default) or fire-and-forget when `waitForAccept: false`.

5. **`JCODE_HOME` sandboxing vs Credential sharing**:
   When testing or running isolated instances with `JCODE_HOME`, credentials in `~/.jcode` are not automatically visible unless inherited. In SDK `launchInstance`, credential files (`openai-auth.json`, `antigravity_oauth.json`, etc.) are symlinked into `$JCODE_HOME`, while configuration is copied. For connecting to the live shared daemon, `jcode api-bridge` must dial the daemon socket (`/run/user/<uid>/jcode.sock`), which is controlled by `JCODE_SOCKET`.

6. **Request timeouts**:
   Default `requestTimeoutMs` on requests is enforced on the client side. Heavy operations (such as session compaction or large transcripts) may require custom timeouts or async polling via events.
