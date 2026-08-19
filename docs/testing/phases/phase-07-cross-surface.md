# Phase 7 — Cross-surface, resilience, and performance

> **Status:** SHIPPED (2026-08-19) — 6 of 7 exit criteria fully MET; Criterion 3 (resilience) MET for 7 of 9 classes with the remaining two (Auth, Database) recorded PARTIAL/NOT MET with exact closing steps. Progress report in [`docs/testing/progress/phase-07-cross-surface.md`](../progress/phase-07-cross-surface.md) and verification log in [`docs/testing/progress/verification-log-phase-07.md`](../progress/verification-log-phase-07.md).

**Depends on:** 2, 3, 4, 5, 6 · **Blocks:** 8 · **Size:** M

Each surface is green in isolation by now. This phase tests the claims
that only hold when they run *together*, plus the failure modes and the
budgets.

## 1. Cross-surface journeys — `suites/cross/`

Amiro's central architectural claim is that the TUI, the desktop app and
the dashboard are three clients of **one backend and one database**. That
claim is stated in `cmd/amiro/main.go`'s doc comment, implemented by
attach-or-embed in `cmd/amiro/serve.go`, and tested nowhere.

| Journey | Assertion |
|---|---|
| TUI → UI | Start a thread in the TUI; it appears in the dashboard without a restart |
| UI → TUI | Create an agent in the browser; `@`-completion in the TUI offers it |
| Shared config | Set `defaultModel` in `.amiro/config.yaml`; both the TUI and the desktop sidecar honour it |
| Provider keys | Add a key in the dashboard; the TUI can immediately use that model |
| Attach-or-embed | With a server running, `amiro` attaches — the second backend never starts. Without one, it embeds and works standalone |
| `--connect` | `amiro --connect URL --token TOK` reaches a server on another host; a session stored for one server is never sent to another |
| Concurrent writes | The TUI and the browser edit the same thread simultaneously; the result is consistent, and neither client is left showing stale state |
| Approval across clients | A turn started in the TUI and approved in the browser (and the reverse) behaves per design |
| MCP sharing | An MCP server configured in one client is visible in the other |
| Export | Export from the TUI, open the public link in a signed-out browser |
| Serve + TUI | `amiro --serve --port N`: the TUI and the dashboard share one embedded backend |

The `--connect` session-scoping rule deserves emphasis: `cmd/amiro/serve.go`
is explicit that a session for one server must never be tried against
another, and that is a security property, not a nicety.

## 2. Resilience — `suites/backend/resilience/`

Built on `harness/fakeprovider`'s failure injection plus deliberate
process-level chaos.

| Class | Cases |
|---|---|
| Provider failures | 429, 500, timeout, malformed SSE, stream dying mid-chunk, unparseable tool arguments, context-window overflow |
| Network | Slow responses, connection reset mid-stream, DNS failure, TLS failure |
| Backend crash | Kill the backend mid-turn — the TUI reports it cleanly; the browser shows a disconnected state; on restart the thread is intact and resumable |
| Database | A locked sqlite file; a corrupt file; a full disk on write; a postgres connection dropped mid-transaction |
| MCP | The fixture server crashes, hangs, returns oversized payloads, or speaks bad protocol |
| Filesystem | A read-only workspace; a file deleted between read and write; a permission error; a symlink loop |
| Auth | A session expiring mid-turn; a token revoked mid-stream |
| Resource | A very large file read; a 10k-line grep result; a thread with 500 messages; a 50MB upload |
| Concurrency | 20 simultaneous turns on one backend; the same thread from two clients; parallel MCP calls |

The bar throughout: **a clean, client-visible error and a recoverable
state.** Never a hang, never a panic, never a corrupt thread, never a
silent partial write.

## 3. Performance budgets — `suites/backend/perf/`

Coarse, generous, and asserted — not a benchmark suite, a regression
alarm. Numbers are placeholders to be calibrated against a reference
runner in this phase and then held.

| Budget | Target |
|---|---|
| Backend cold start to healthy `/health` | < 2s |
| TUI launch to first frame (embedded) | < 3s |
| TUI launch to first frame (attached) | < 1s |
| Dashboard first contentful paint | < 2s |
| First streamed token after submit (replay) | < 500ms |
| Thread list with 500 threads | < 300ms |
| Repomap over `fixtures/workspaces/large` | < 5s |
| Memory after 100 turns | < 500MB RSS, and not monotonically growing |

Budgets are `slow`-tagged and run nightly, not on every push — machine
variance would make them a flake source in the merge gate. Results are
recorded per run so a trend is visible, and a regression is reported as a
delta against the last 10 runs rather than a hard threshold alone.

## 4. Security checks — `suites/backend/security/`

Not a substitute for a real review; the mechanical checks that are cheap to
automate and expensive to miss:

- Workspace escape via every path shape (re-asserted here at the
  cross-surface level, including through the dashboard).
- Shell tool argument injection.
- Ownership boundaries on every resource (the Phase 2 matrix, re-run with
  a real agent loop active).
- Secrets never in responses, logs, traces, HAR files or cassettes.
- The public `/api/export/{id}` route exposing only what is meant to be
  public.
- CORS enforcement, including with `--allow-origin` set.
- Auth rate limiting when bound beyond loopback (the Phase 0 control).
- No debug or dev-only endpoint reachable in a release build.

## Exit criteria

1. `amirotest run --surface cross` passes, and every cross-surface journey above has a test.
2. Attach-or-embed is proven in both directions, and `--connect` session scoping is asserted.
3. Every resilience class produces a clean error and a recoverable state; no test hangs.
4. Killing the backend mid-turn leaves a thread that is intact and resumable after restart.
5. Performance budgets are calibrated, recorded, and asserted in the nightly job.
6. Security checks pass, including through the dashboard.
7. The full default run (all surfaces, excluding `slow` and `live`) is under 10 minutes.

## Risks

- **Cross-surface tests are the flakiest by nature** — several processes, real timing. Every assertion goes through `harness.Eventually` with a deadline and a state dump on timeout. Any test needing a retry gets investigated, not retried.
- **Chaos tests can leak resources.** Killing processes mid-operation can leave files, ports and children behind. `harness/process`'s teardown assertions are what keep this from silently degrading later tests.
- **Perf budgets on shared CI runners** are noisy. Nightly-only, trend-based, on a consistent runner class.
