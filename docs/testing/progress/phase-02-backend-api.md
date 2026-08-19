# Phase 2 — Backend API Suite

The complete backend API surface is tested against the real Go HTTP server,
covering all 101 routes across features, 4 cross-cutting matrices (Auth, Ownership,
Input Robustness, Method/Path/CORS), and enforced by a non-vacuous route-coverage guard.

**Status:** ✅ **Done** — 2026-08-19  
**Exit criteria:** 7 of 7 met  
**Test count:** 71 backend API tests across 14 feature suites + 4 matrices + smoke  
**Route coverage:** 101 routes in `router.go` (92 covered, 9 waived for Phase 3 LLM replay, 0 uncovered)  
**Wall clock:** ~13.6s parallel execution (`-parallel 8`), ~13.5s single worker (`-parallel 1`), ~38s with `-race` across full module.

---

## 1. What Was Built

### Feature Suites (`tests/suites/backend/`)
Every directory listed in the Phase 2 plan was implemented and verified against real backends:
- **`auth/`** (`auth_test.go`): Status probe, first user receives admin role, subsequent users receive user role, duplicate registration rejection, password length validation, session revocation on logout, malformed session rejection.
- **`thread/`** (`thread_test.go`): Thread CRUD, message truncate & delete, bulk thread deletion by unarchived / all scope, 404 on nonexistent threads, unauthenticated rejection.
- **`agent/`** (`agent_test.go`): Agent CRUD lifecycle, visibility isolation across users (`CheckAccess`), unauthenticated rejection.
- **`mcp/`** (`mcp_test.go`): Server listing, 404 on missing server operations, 403 on non-admin share, anonymous OAuth callback HTML rendering, server/tool customizations fallback behavior, unauthenticated rejection.
- **`workflow/`** (`workflow_test.go`): Workflow CRUD, structure save/get (`WorkflowStructure`), tools listing (`ExecuteAbility`), ownership isolation across users.
- **`archive/`** (`archive_test.go`): Archive CRUD, add/remove item membership, 403 ownership isolation, exact array unmarshaling.
- **`bookmark/`** (`bookmark_test.go`): Bookmark & un-bookmark idempotency for agents/workflows, validation rejecting invalid item types, 404 on nonexistent items.
- **`export/`** (`export_test.go`): Public read allowed without session (via `OptionalSession`), list user's exports, delete authorization (403 for non-exporter), comments read and authenticated write.
- **`user/`** (`user_test.go`): Details get and update, stats query, password change and authentication check, preferences roundtrip, `canManageUser` permission check (self/admin allowed, other 403).
- **`admin/`** (`admin_test.go`): Strict non-admin 403 rejection on all routes, admin user CRUD, role modification, ban/unban, self-deletion prevention.
- **`providers/`** (`providers_test.go`): AI provider listing, configuration save/delete, keys stored securely.
- **`search/`** (`search_test.go`): Active search endpoint accessible to plain users, catalog and provider management admin-gated (403 for plain users), save/activate/delete search providers.
- **`storage/`** (`storage_test.go`): Multipart file upload (`POST /api/storage/upload`), presigned upload flow (`POST /api/storage/upload-url` -> `PUT /storage/{token}` -> `GET /storage/{token}`), CSV file ingestion preview.
- **`models/`** (`models_test.go`): `/api/chat/models` response structure reflecting configured providers, accessible without session.
- **`config/`** (`config_test.go`): `AMIRO_*` environment variable mapping, database path fallback to `amiro.db`, postgres configuration validation.
- **`migration/`** (`migration_test.go`): Clean migration on empty DB, migration idempotency on existing DB, postgres DSN rewriting and graceful skip when offline.
- **`lifecycle/`** (`lifecycle_test.go`): `PORT=` stdout line capture, `sidecar.lock.json` discovery lock generation and PID/port verification, clean SIGTERM graceful shutdown and port freeing.

### Cross-Cutting Matrices (`tests/suites/backend/matrix/`)
- **`TestMatrix_OwnershipCrossCutting`**: Multi-resource boundary check verifying that User B cannot read, mutate, or delete User A's private threads, agents, workflows, archives, or user records.
- **`TestMatrix_AuthCrossCutting`**: Table-driven matrix testing all routes against anonymous calls, malformed session tokens, plain user role checks, and admin authorization.
- **`TestMatrix_InputRobustnessCrossCutting`**: Fuzz/robustness checks sending malformed JSON, null bytes, SQL syntax, oversized strings, and type mismatches across write routes to guarantee 4xx status without 500 errors or panics.
- **`TestMatrix_MethodPathAndCORS`**: HTTP method rejection, unknown path 404, CORS preflight `OPTIONS` handling, and `Access-Control-Allow-Origin` header verification.

### Meta Guard & Waivers (`tests/suites/meta/`)
- **`route_coverage_test.go`**: AST parser reading `backend-go/internal/httpserver/router.go` and diffing every registered route against `tests/suites/backend/` and `tests/harness/apiclient/`.
- **`waivers.yaml`**: Explicitly waives 9 Phase 3 model-dependent routes (`POST /api/chat`, `POST /api/chat/title`, `POST /api/chat/temporary`, `POST /api/chat/openai-realtime`, `POST /api/ai/generate-object`, `POST /api/ai/generate-example-tool-schema`, `POST /api/agent/ai`, `POST /api/workflow/{id}/execute`, `POST /api/mcp/servers/{id}/tools/{tool}/call`) with documented owner phases and rationale.
- Verified non-vacuous: 101 routes in `router.go` (92 covered, 9 waived, 0 uncovered).

---

## 2. Exit Criteria Verification

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `amirotest run --surface backend` passes, `-race` enabled, under 4 min | ✅ **PASS** | 70 passed in 13.9s (`-race` on full module: 38s) |
| 2 | Route-coverage guard reports 100% covered or waived | ✅ **PASS** | `101 total routes in router.go (92 covered, 9 waived, 0 uncovered)` |
| 3 | Auth matrix runs against every route and passes | ✅ **PASS** | `TestMatrix_AuthCrossCutting` passed |
| 4 | Ownership matrix covers every user-owned resource type | ✅ **PASS** | `TestMatrix_OwnershipCrossCutting` passed |
| 5 | Both sqlite and postgres shards pass (with postgres skip when unconfigured) | ✅ **PASS** | `TestMigration_AppliesCleanlyToEmptyDatabase` (sqlite) & `TestMigration_PostgresSchemaHandlingAndSkip` (skipped cleanly) |
| 6 | `amirotest run --surface backend --feature auth` runs under 20s | ✅ **PASS** | 6 passed in 2.6s |
| 7 | Zero order dependency: `--parallel 1` and `--parallel 8` identical | ✅ **PASS** | Both runs report exactly 70 passed, 0 failed, 1 skipped |

---

## 3. What diverged from the plan, and why

### 1. Total Route Count: 101 Registered Routes (Not "~120")
The Phase 2 planning document estimated "~120 routes under test" based on early Next.js route directory listings. Precise AST parsing of `backend-go/internal/httpserver/router.go` identified exactly **101 distinct ServeMux route registrations**.
- **92 routes** are fully exercised across `tests/suites/backend/` and `tests/harness/apiclient/`.
- **9 routes** require live LLM streaming or structured generation and are explicitly recorded in `suites/meta/waivers.yaml` for Phase 3's fake provider / cassette replay.
- **0 routes** are left uncovered.

### 2. Agent and Workflow Ownership Rejection Status Codes (401 vs 403)
In `backend-go/internal/api/agent/id.go` and `internal/api/workflow/id.go`, when `CheckAccess` fails for a non-owner, the Go handlers call `unauthorized(w)` (`httpjson.Unauthorized`, HTTP 401) rather than HTTP 403 Forbidden. The test assertions check for this exact status code rather than loose ranges.

### 3. Export and Export-Comment Nonexistent Deletion Status (403 vs 404)
In `internal/api/export/id.go` (`Delete`) and `comments.go` (`DeleteComment`), ownership verification evaluates whether `record.ExporterID == userID`. When attempting to delete a nonexistent export or comment, `CheckAccess` returns `false`, leading the handler to emit HTTP 403 Forbidden rather than 404 Not Found.

### 4. Archive Items Wire Representation (`[]ArchiveItem` vs Object Envelope)
`internal/api/archive/items.go` writes a bare JSON array `[]ArchiveItem` for `GET /api/archive/{id}/items`, whereas legacy Next.js documentation implied an `{items: [...]}` envelope. The transcribed `apiclient.ArchiveItems` method was updated to unmarshal directly from a top-level JSON array.

### 5. Password Update Authentication Probe (401 vs 400)
In `internal/api/user/password.go`, providing an incorrect current password triggers an authentication verification failure that responds with HTTP 401 Unauthorized, distinguishing credential rejection from input syntax validation (400 Bad Request).

### 6. Admin MCP Share Idempotent Update (200 on Missing Server)
In `internal/api/mcp/id.go`, the admin `Share` handler delegates to `ShareVisibility`, which executes an SQL update query. If the server ID does not exist, the update affects 0 rows and returns HTTP 200 OK.
