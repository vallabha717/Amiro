# Phase 2 — Backend API suite

> ✅ **Shipped 2026-08-19.** Implementation record:
> [`../progress/phase-02-backend-api.md`](../progress/phase-02-backend-api.md)
> · **Verification:** [`../progress/verification-log-phase-02.md`](../progress/verification-log-phase-02.md)

**Depends on:** 1 · **Blocks:** 3, 7 · **Size:** L

Every route group in `internal/httpserver/router.go` that does not require
a model, exercised against a real spawned server over real HTTP. The
LLM-dependent routes wait for Phase 3.

## Feature directories

Each becomes `suites/backend/<feature>/` and is independently runnable via
`amirotest run --surface backend --feature <name>`.

| Feature | Routes | What matters |
|---|---|---|
| `auth` | `/api/auth/{status,register,login,logout,session}` | First account becomes admin; later ones don't; sessions expire; logout invalidates; password rules; duplicate email; `RequireSession` rejects absent/expired/malformed tokens |
| `thread` | `/api/thread*` | CRUD; ownership isolation; message deletion; `truncate` after a message; `DELETE /api/thread` deletes only the caller's |
| `agent` | `/api/agent*` | CRUD; ownership; validation; visibility/sharing |
| `mcp` | `/api/mcp*` (config half) | Save/list/get/delete servers; ownership on delete; server + tool customizations; refresh; share |
| `workflow` | `/api/workflow*` | CRUD; structure save/get; node graph validation; ownership |
| `archive` | `/api/archive*` | CRUD; items add/remove; ownership |
| `bookmark` | `/api/bookmark` | Create/delete; idempotency |
| `export` | `/api/export*` | Public read via `optional` auth vs authenticated write; comments; delete permissions — **the only place unauthenticated access is legal**, so its boundary deserves the most attention |
| `user` | `/api/user/*` | Details read/update; preferences round-trip |
| `admin` | `/api/admin/*` | Non-admin gets 403 on every route; admin succeeds; privilege escalation attempts fail |
| `providers` | `/api/ai/providers*` | Set/list/delete keys; keys never echoed back in responses; `/test` against the fake provider; model sync |
| `search` | `/api/search/*` | Provider config; activate; catalog; `/test` |
| `storage` | `/api/storage/*` | Upload, presigned URL, size limits, content-type handling, path traversal |
| `models` | `/api/chat/models` | Catalog shape; reflects configured providers |
| `config` | — | `AMIRO_*` precedence; sqlite path fallback (`amiro.db` vs legacy `betterchatbot.db`); postgres requiring DSN and bucket |
| `migration` | — | Migrations apply to an empty DB; are idempotent; sqlite and postgres produce equivalent schemas |
| `lifecycle` | — | `PORT=` on stdout; discovery lock written and removed; SIGTERM graceful; second instance attaches rather than double-binding |

## Cross-cutting patterns

Rather than writing these per-feature, the harness applies them
systematically:

**Ownership matrix.** For every resource type, a table test asserting that
`other` cannot read, update, or delete `user`'s resource — and gets 403 or
404, never 200 and never a 500. This is where the two currently-failing
`internal/httpserver` tests live (`TestAdminRoutes_NonAdminGetsForbidden`,
`TestRouter_McpDeleteRejectsNonOwnerAndSucceedsForOwner`), and it is worth
covering exhaustively because ownership bugs in agent-written code are both
common and serious.

**Auth matrix.** Every route, called with: no credentials, an expired
session, a malformed token, a valid session for the wrong user, a valid
admin session. Driven from the parsed route list, so a new route is covered
the moment it is added.

**Input robustness.** Per route: empty body, malformed JSON, wrong content
type, oversized payload, unknown fields, wrong types, unicode, null bytes,
SQL-shaped strings, very long strings. The bar is *never a 500 and never a
panic* — a 4xx with a clear message is a pass.

**Method and path.** Wrong method → 405; unknown path → 404; trailing
slashes and double slashes handled consistently.

**Concurrency.** Simultaneous writes to the same resource from two
sessions; simultaneous session creation; parallel thread creation. Go's
race detector on (`-race` in the default run).

**CORS.** `internal/middleware/cors.go` with the allowed origin, a
disallowed origin, and preflight.

## Route-coverage guard

Added to `suites/meta/` in this phase and it is the most valuable single
guard in the plan: parse `router.go` for its
`mux.Handle*("METHOD /path", …)` registrations, diff against the set
`harness/apiclient` actually exercised during the run, and fail on any
route never called. With ~120 routes in a mostly agent-written codebase,
the realistic failure mode is a route nobody has ever invoked. This turns
that from invisible into a build failure.

Routes may be explicitly waived in `suites/meta/waivers.yaml` with a
reason and an owner — a waiver is a visible, reviewable decision, unlike
silence.

## Exit criteria

1. `amirotest run --surface backend` passes, `-race` enabled, in under 4 minutes.
2. The route-coverage guard reports 100% of `router.go`'s routes covered or explicitly waived.
3. The auth matrix runs against every route and passes.
4. The ownership matrix covers every user-owned resource type.
5. Both `sqlite` and `postgres` shards pass.
6. `amirotest run --surface backend --feature auth` runs only the auth suite, in under 20 seconds.
7. No test depends on another; `--parallel 8` and `--parallel 1` produce identical results, and so does shuffled ordering.

## Risks

- **Volume.** ~120 routes is a lot of test code, and hand-writing it invites inconsistency. Mitigation: matrices are table-driven off the parsed route list; only genuinely per-route semantics are written by hand.
- **Storage and S3.** `internal/storage/s3.go` needs either a real bucket or a local S3-compatible server. Use a minio-shaped fixture where available and tag the real-bucket tests `live`.
- **Postgres in the default run.** Requiring a running postgres for a local run breaks the "green from a clean checkout" promise. Postgres tests skip with a recorded reason when no DSN is configured, and run as a CI shard.
