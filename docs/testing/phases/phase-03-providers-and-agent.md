# Phase 3 — Providers, cassettes, and the agent loop

**Depends on:** 1, 2 · **Blocks:** 4, 5, 7 · **Size:** L

The provider layer, and everything that needs a model to answer: chat
streaming, tool calls, approvals, MCP execution, compaction, workflows,
and `amiro run`'s in-process path.

## Deliverables

### 1. `harness/fakeprovider`

A real HTTP server speaking the OpenAI and Anthropic wire formats, scripted
declaratively:

```go
fake.OnPrompt("say hello").StreamText("Hello!", fake.PerChunk(3))
fake.OnPrompt(fake.Contains("read")).
     ToolCall("read_file", map[string]any{"path": "README.md"}).
     ThenStreamText("The file says: %s")
fake.OnAny().Error(429, `{"error":{"type":"rate_limit_error"}}`)
fake.OnAny().TruncateStreamAfter(3)     // connection dies mid-stream
```

It is both the no-keys fallback and the failure-injection tool. Scripted
failures — rate limits, 5xx, malformed SSE, a stream that dies mid-chunk, a
tool call with unparseable arguments, a response exceeding the context
window — are awkward to record and essential to test.

### 2. `harness/cassette`

The record/replay proxy, in full, per [05](../05-recording-and-replay.md):
YAML format with preserved chunk boundaries and scaled delays; normalised
matching; ordered-then-content-addressed lookup; strict vs degrading miss
behaviour; redaction on write; TTL reporting in `amirotest doctor`.

### 3. Provider suites

`suites/backend/providers/` grows the parts Phase 2 deferred:

- Each configured provider: key storage, `/test`, model listing, model sync.
- `internal/ai/bifrost` catalog resolution and the fallback provider.
- Key rotation and deletion; keys never returned in any response body
  (asserted against the whole `http.ndjson`, not just the immediate reply).
- `internal/secrets`: keyring store and env store, the latter's read-only
  contract, and the `google` → `GOOGLE_GENERATIVE_AI_API_KEY` naming
  exception.
- Pricing and token accounting: usage numbers in the response match the
  cassette's, and cost computation matches `internal/pricing`.

### 4. `suites/backend/chat/` — the agent loop

The centre of the product and the largest suite:

| Area | Cases |
|---|---|
| Streaming | Text deltas arrive in order; frame types match `uimessage`; the stream terminates; a client disconnect mid-stream cancels the turn server-side |
| Tools | Each built-in tool (read, write, edit, multi-edit, glob, grep, list, shell, todo) executes and reports; results feed back; multi-tool turns sequence correctly |
| Workspace safety | File tools cannot escape `WorkspaceRoot` — `../`, absolute paths, symlinks pointing out, encoded traversal. **Non-negotiable; agents write shell commands.** |
| Approvals | `interactive` mode gates; `auto` does not; `plan` refuses writes; `edit` allows edits but gates shell; approval resubmission carries the answered part; denial aborts cleanly |
| MCP | Tools from `fixtures/mcp/server` are discovered, called, and returned; `slow` hits the timeout; `crash` reconnects; `needs_approval` gates |
| Multi-turn | Thread state persists; resume produces the same context; message truncation rebuilds correctly |
| Compaction | `internal/agent/compaction` triggers at the threshold; the compacted context retains what it promises; the turn continues |
| Sessions | `internal/agent/session` logs every step; `amiro run --json` output matches the session log |
| Errors | Provider 429 / 500 / timeout / malformed SSE / mid-stream death → a clean error to the client and a recoverable thread, never a hang and never a corrupt thread |
| Cancellation | Interrupting mid-turn stops tool execution and leaves the thread consistent |
| Title | `/api/chat/title` generates and persists |
| Temporary | `/api/chat/temporary` leaves no persisted thread |
| Export | `/api/chat/export` produces a shareable artifact matching the thread |

### 5. `suites/backend/workflow/` — execution

Phase 2 covered workflow CRUD. This adds `POST /api/workflow/{id}/execute`:
node sequencing, `internal/ai/workflow/executor` behaviour, a failing node,
a node calling a tool, and cancellation mid-execution.

### 6. Cassette corpus

Record the initial cassettes against real providers for every scenario a
recording adds fidelity to. Everything else stays on the fake provider —
recording a rate limit is not more real than scripting one.

Target: every `smoke`-tagged chat test replays from a cassette, so the
nightly `--live` run is a meaningful comparison.

## Exit criteria

1. `amirotest run --surface backend --feature chat` passes in `fake`, `replay`, and (with keys) `live` mode.
2. `strictCassettes: true` passes — no silent degradation anywhere.
3. Workspace-escape tests cover `../`, absolute paths, symlinks, and encoded traversal, and all are refused.
4. Every permission mode's gate behaviour is covered, including approval resubmission and denial.
5. The MCP fixture server exercises discovery, call, timeout, crash-and-reconnect, and approval.
6. Every provider failure mode produces a clean client-visible error; no test hangs; no thread is left corrupt.
7. `providers/cost.json` reads `0.00` for a `replay` run.
8. Recording a cassette and replaying it produces byte-identical assertions.

## Risks

- **Cassette brittleness.** Over-strict matching makes every prompt tweak a mass re-record. The normaliser is the pressure valve, and it needs real care — under-normalise and everything breaks constantly, over-normalise and the cassettes stop proving anything. Start strict, relax with a recorded reason per field.
- **Streaming assertions are timing-shaped.** Assert on the *sequence and content* of frames, never on wall-clock arrival. `harness.Eventually` with a deadline, never a sleep.
- **The fake provider drifting from reality.** It is a model of two APIs and models rot. The nightly `--live` job is the detector; a `live`-only test asserting the fake's shape against a real response is the belt-and-braces.
- **Suite runtime.** This is the biggest suite. Tag the long multi-turn and compaction cases `slow` and keep the default path under 3 minutes.
