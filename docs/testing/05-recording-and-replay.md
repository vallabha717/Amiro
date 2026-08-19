# 05 — Recording and replay

"Test everything with real values" and "tests must be fast, free and
deterministic" are both true requirements. The hybrid resolves them:
**record real provider traffic once, replay it by default, re-record on
demand, and verify the recordings against reality on a schedule.**

## The four modes

| Mode | Network | Cost | Determinism | When |
|---|---|---|---|---|
| `fake` | none | none | total | No keys configured. Deterministic canned streams from `harness/fakeprovider`. |
| `replay` **(default)** | none | none | total | Normal development and CI. Serves recorded responses. |
| `record` | real | yes | n/a | Creating or refreshing a cassette. |
| `live` | real | yes | none | Nightly verification that the real APIs still behave as recorded. |

`fake` and `replay` differ in fidelity: `fake` invents a plausible
provider, `replay` serves bytes that a real provider actually sent. `fake`
exists so a contributor with no keys and no cassettes still gets a green
run; `replay` is what actually proves the wire format.

## How interception works

**By rewriting base URLs, not by patching the HTTP client.**

`backend-go/internal/api/ai/providers.go` already resolves a per-provider
base URL, and `providers.llm[].baseUrl` in `config.yaml` is stored in the
database alongside the key. So in `replay`/`record` mode the harness:

1. starts the cassette proxy on a loopback port,
2. seeds each provider through `POST /api/ai/providers` with
   `baseUrl: http://127.0.0.1:<proxy>/<provider>`,
3. lets the backend make a completely ordinary outbound HTTPS-shaped
   request.

Nothing in the backend knows it is under test. The agent loop, streaming
parser, token accounting, retry logic and error handling all run for real.
This is the property that makes replayed tests worth trusting — the only
substituted component is the remote server.

```
backend ──HTTP──► cassette proxy ──┬── replay: read cassettes/<name>.yaml
                       │           └── record: forward to api.anthropic.com, write cassette
                       └── log to providers/cassettes.ndjson
```

## Cassette format

One YAML file per logical interaction, under
`tests/cassettes/<surface>/<feature>/<name>.yaml`:

```yaml
# tests/cassettes/backend/chat/basic-turn.yaml
meta:
  recorded: 2026-08-19T14:02:11Z
  provider: anthropic
  model: claude-sonnet-5
  amiroSha: 1e9b78e
  ttlDays: 90
interactions:
  - request:
      method: POST
      path: /v1/messages
      headers: { content-type: application/json, x-api-key: "<redacted:sha256:9f2a1c04>" }
      body:
        model: claude-sonnet-5
        stream: true
        messages: [{ role: user, content: "say hello" }]
    response:
      status: 200
      headers: { content-type: text/event-stream }
      # SSE preserved verbatim, including chunk boundaries and timing
      stream:
        - { delayMs: 12,  data: 'event: message_start\ndata: {...}\n\n' }
        - { delayMs: 40,  data: 'event: content_block_delta\ndata: {"delta":{"text":"Hel"}}\n\n' }
        - { delayMs: 35,  data: 'event: content_block_delta\ndata: {"delta":{"text":"lo"}}\n\n' }
        - { delayMs: 8,   data: 'event: message_stop\ndata: {}\n\n' }
```

Design points that matter:

- **Chunk boundaries are preserved.** A streaming parser bug that only
  appears when a JSON object is split across two TCP reads is exactly the
  bug replay should catch. Collapsing the stream into one blob would hide
  it.
- **`delayMs` is preserved but scaled.** Replay uses `delayMs / 20` by
  default so the shape of the stream (fast start, slow middle) survives
  without the wall-clock cost. `--realtime` replays at recorded speed.
- **YAML, not binary.** Cassettes are reviewed in PRs. A diff on a cassette
  is a diff on what the provider sends us, which is genuinely worth
  reading.
- **`ttlDays`** makes staleness visible: `amirotest doctor` reports
  cassettes past their TTL, and the nightly `live` job re-records them.

## Matching

A replayed request is matched on: method, path, and a **normalised** body.
Normalisation strips fields that legitimately vary between runs and would
otherwise cause spurious misses:

- generated ids (thread id, message id, tool call id, request id)
- timestamps
- the system prompt's dynamic segments (cwd, date, workspace listing)
- `max_tokens` and other values a test may parameterise

Everything else — the model, the messages, the tool definitions, the
temperature — is matched exactly. If the agent loop starts sending a
different tool schema, the cassette misses, and that is the correct
outcome: the request changed, so the recording is no longer valid
evidence.

Matching is **ordered within a cassette** (a multi-turn agent loop replays
turn 1, then turn 2) and **content-addressed across cassettes** (any
cassette in the directory can satisfy a request). Ordered-first, then
fallback.

### On a miss

Default: fall back to `fake` mode for that request, log a `miss` to
`providers/cassettes.ndjson`, and report it in `summary.md`. The test still
runs; the run still reports that its fidelity was degraded.

With `run.strictCassettes: true` (CI's setting): a miss is a test failure,
with a message naming the cassette that would have been written and the
exact command to record it. This is what stops cassette rot from silently
turning the whole suite into `fake` mode.

## Recording workflow

```bash
# one feature, against the real API
amirotest record --surface backend --feature chat

# refresh everything (nightly job / after a provider deprecation)
amirotest record --all --confirm

# check recordings still match reality without rewriting them
amirotest run --live --tag smoke
```

`record` requires real keys, prints an estimated cost before starting, and
refuses to run without `--confirm` when it would rewrite more than 20
cassettes. Recorded cassettes are redacted on write — an API key never
reaches the file.

The nightly CI job runs `--live` on the `smoke`-tagged tests. A `live`
failure where `replay` passes means **the provider changed**, which is a
different alert from a code regression and is routed accordingly.

## The fake provider

`harness/fakeprovider` is a real HTTP server speaking the OpenAI and
Anthropic wire formats, driven by a small script:

```go
fake.OnPrompt("say hello").StreamText("Hello!", fake.PerChunk(3))
fake.OnPrompt(fake.Contains("read the file")).
     ToolCall("read_file", map[string]any{"path": "README.md"}).
     ThenStreamText("The file says: %s")
fake.OnAny().Error(429, `{"error":{"type":"rate_limit_error"}}`)
```

It exists for three jobs:

1. **The no-keys, no-cassettes path** — a green run from a clean checkout.
2. **Failure injection** — rate limits, 500s, malformed SSE, a stream that
   dies mid-chunk, a tool call with invalid JSON arguments. These are
   awkward to record and essential to test. `suites/backend/resilience/`
   is built entirely on it.
3. **Precise assertions** — "the approval gate fires before the tool
   executes" needs a tool call at an exact point, which is easier to script
   than to elicit from a real model.

## What is never recorded

- MCP traffic. `fixtures/mcp/server` is a **real** MCP server started as a
  subprocess with deterministic tools. The protocol is ours to control, so
  there is no reason to fake it.
- The Amiro backend's own API. Tests always talk to a real server.
- Database access. Always a real sqlite file (or postgres schema).
- Search providers in `fake` mode get a canned result set; in `replay` they
  use cassettes exactly as LLM providers do.

## Cost control

`providers/cost.json` records per-run spend, computed from token counts
and `backend-go/internal/pricing`. It is `0.00` for every non-live run.
The nightly live job posts its cost into the run summary, and CI fails a
live run that exceeds a configured ceiling — a runaway agent loop that
burns budget should stop the job, not the credit card.
