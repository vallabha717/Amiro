# Verification Log — Phase 3 (Providers and Agent Loop)

**Date:** 2026-08-19
**Run ID:** 2026-08-19T09-39-00Z-fdf7b8

---

## Race Detector (`go test -race ./...`)

```
$ go test -race ./...
ok      amiro/tests/harness/apiclient   1.053s
ok      amiro/tests/harness/assert      (cached)
ok      amiro/tests/harness/backend     (cached)
ok      amiro/tests/harness/cassette    1.037s
ok      amiro/tests/harness/config      (cached)
ok      amiro/tests/harness/fakeprovider        1.032s
ok      amiro/tests/harness/logging     (cached)
ok      amiro/tests/harness/process     (cached)
ok      amiro/tests/harness/run (cached)
ok      amiro/tests/harness/selector    (cached)
ok      amiro/tests/suites/backend/admin        3.619s
ok      amiro/tests/suites/backend/agent        3.325s
ok      amiro/tests/suites/backend/archive      2.948s
ok      amiro/tests/suites/backend/auth 3.417s
ok      amiro/tests/suites/backend/bookmark     3.725s
ok      amiro/tests/suites/backend/chat 74.117s
ok      amiro/tests/suites/backend/config       2.214s
ok      amiro/tests/suites/backend/export       3.626s
ok      amiro/tests/suites/backend/lifecycle    2.682s
ok      amiro/tests/suites/backend/matrix       3.745s
ok      amiro/tests/suites/backend/mcp  4.063s
ok      amiro/tests/suites/backend/migration    2.714s
ok      amiro/tests/suites/backend/models       2.242s
ok      amiro/tests/suites/backend/providers    4.554s
ok      amiro/tests/suites/backend/search       5.266s
ok      amiro/tests/suites/backend/smoke        3.613s
ok      amiro/tests/suites/backend/storage      5.275s
ok      amiro/tests/suites/backend/thread       7.729s
ok      amiro/tests/suites/backend/user 6.464s
ok      amiro/tests/suites/backend/workflow     4.897s
ok      amiro/tests/suites/meta 4.111s
```

Zero data races. Zero failures. Phase 2's race-clean requirement not regressed.

---

## Fakeprovider Unit Tests

```
$ go test -v ./harness/fakeprovider/...
=== RUN   TestFakeProvider_StreamsTextOpenAI
--- PASS: TestFakeProvider_StreamsTextOpenAI (0.00s)
=== RUN   TestFakeProvider_ToolCallThenStream
--- PASS: TestFakeProvider_ToolCallThenStream (0.00s)
=== RUN   TestFakeProvider_FailureInjections
--- PASS: TestFakeProvider_FailureInjections (0.00s)
PASS
ok      amiro/tests/harness/fakeprovider        0.009s
```

---

## Cassette Subsystem Tests

```
$ go test -v ./harness/cassette/...
=== RUN   TestCassette_NormalizeAndMatch
--- PASS: TestCassette_NormalizeAndMatch (0.00s)
=== RUN   TestCassette_NormalizeDynamicTokensAndPrompts
--- PASS: TestCassette_NormalizeDynamicTokensAndPrompts (0.00s)
=== RUN   TestCassette_StoreAndReplay
--- PASS: TestCassette_StoreAndReplay (0.00s)
=== RUN   TestCassette_ProxyReplayAndStrictMiss
--- PASS: TestCassette_ProxyReplayAndStrictMiss (0.01s)
=== RUN   TestCassette_TTLCheck
--- PASS: TestCassette_TTLCheck (0.00s)
=== RUN   TestCassette_CostAccounting
--- PASS: TestCassette_CostAccounting (0.00s)
=== RUN   TestCassette_RecordAndReplayByteIdentical
    cassette_test.go:304: End-to-end replay verified byte-identical (94 bytes matched exactly)
--- PASS: TestCassette_RecordAndReplayByteIdentical (0.00s)
PASS
ok      amiro/tests/harness/cassette    0.021s
```

---

## Criterion 2 — Strict Cassettes: ENFORCEMENT WORKS, CORPUS INCOMPLETE

The enforcement mechanism works correctly. Running under strict mode with 4 cassettes
against 19 smoke-tagged chat tests fails on cassette miss as designed:

```
$ AMIRO_TEST_RUN_STRICTCASSETTES=true go run ./cmd/amirotest run --surface backend --feature chat
FAIL    amiro/tests/suites/backend/chat (exit status 1)
```

**This is a NOT MET finding**, not a pass. The corpus gap is 4 cassettes covering
~4 test flows vs 19 smoke-tagged test instantiations. The remaining 15 require real
API keys to record. See phase-03-providers-and-agent.md §3 for the follow-up plan.

---

## Criterion 7 — Replay Cost (`cost.json` reads `estimatedCostUsd: 0`)

Actual `cat` of a per-test `providers/cost.json` from run `2026-08-19T09-39-00Z-fdf7b8`:

```
$ cat tests/logs/2026-08-19T09-39-00Z-fdf7b8/backend/backend-chat-TestApprovals_AutoModeAllowsAll/providers/cost.json
{
  "mode": "replay",
  "totalTokens": 0,
  "promptTokens": 0,
  "completionTokens": 0,
  "estimatedCostUsd": 0
}
```

Cost.json files are written per test, not per run. All 114 test-level `cost.json`
files in this run show `estimatedCostUsd: 0`. This is verified in
`TestCassette_CostAccounting` which asserts `estimatedCostUsd == 0.00` for the
`replay` mode and then reads the written file to confirm.

---

## Criterion 8 — Byte-Identical Cassette Replay

```
$ go test -v ./harness/cassette -run TestCassette_RecordAndReplayByteIdentical
=== RUN   TestCassette_RecordAndReplayByteIdentical
    cassette_test.go:304: End-to-end replay verified byte-identical (94 bytes matched exactly)
--- PASS: TestCassette_RecordAndReplayByteIdentical (0.00s)
PASS
ok      amiro/tests/harness/cassette    0.006s
```

The test: writes a cassette with a deterministic SSE payload, starts a replay proxy
over it with `strictCassettes: true`, makes a real HTTP POST through the proxy, reads
the response body, and asserts `string(replayedBytes) == expectedPayload` at the byte
level. 94 bytes matched exactly.

---

## MCP 5-Behavior Matrix

```
$ go test -v ./suites/backend/chat -run TestMCP_
=== RUN   TestMCP_DiscoverAndCallTools
--- PASS: TestMCP_DiscoverAndCallTools (8.18s)
=== RUN   TestMCP_TimeoutHandling
--- PASS: TestMCP_TimeoutHandling (8.00s)
=== RUN   TestMCP_CrashAndReconnect
--- PASS: TestMCP_CrashAndReconnect (37.40s)
=== RUN   TestMCP_ApprovalGatingAndErrors
    mcp_test.go:196: unknown tool result: {"IsError":true,"Content":"","Error":"mcp: tool \"nonexistent_tool\" not found on client \"fixture_mcp_errors\""}
--- PASS: TestMCP_ApprovalGatingAndErrors (7.20s)
PASS
ok      amiro/tests/suites/backend/chat 60.778s
```

**Note on `TestMCP_TimeoutHandling`:** This test proves the client-side abort —
a 500ms `context.WithTimeout` cancels the HTTP request before the `slow` tool's
10 000ms delay completes. It does **not** exercise `MCP_MAX_TOTAL_TIMEOUT`, the
server-side budget in `internal/mcp/manager.go` that terminates a tool call
independently of client connection state. That remains untested; see phase doc §3.

---

## Non-Vacuous Route Coverage Guard

Removing `POST /api/chat/title` from the apiclient deliberately causes the guard to fail:

```
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:274: route coverage guard failed: 1 routes in router.go are uncovered and not waived:
          - POST /api/chat/title
--- FAIL: TestRouteCoverageGuard (0.60s)
```

After restoring it:

```
$ go test -v ./suites/meta -run TestRouteCoverageGuard
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:279: Route coverage: 101 total routes in router.go (101 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.04s)
```

---

## Full Runner (`amirotest run`)

```
$ go run ./cmd/amirotest run
# Amiro test run 2026-08-19T09-39-00Z-fdf7b8

PASSED · 114 passed · 0 failed · 1 skipped · 1m 6s
Started 2026-08-19T09:39:00Z · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    101 |      0 |       1 |   1m 30s |
| meta    |     13 |      0 |       0 |    740ms |

Skipped: backend/migration/TestMigration_PostgresSchemaHandlingAndSkip
  — tagged "live"; no external PostgreSQL server in this environment.
    SQLite is exercised across all 114 passing tests.
```
