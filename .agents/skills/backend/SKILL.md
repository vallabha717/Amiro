---
name: backend
description: Amiro's Go backend standards — package layout, folder structure and implementation rules for `backend-go/`. Covers adding or changing HTTP API routes, handlers, repositories, database models and migrations (sqlite AND postgres), auth and middleware, provider/AI integration, MCP, storage, secrets, and the `amiro` CLI entrypoints (sidecar, `serve`, `run`, TUI). The one backend serves all Amiro surfaces — the Tauri desktop sidecar, the browser dashboard via `amiro serve`, and the terminal UI — so use whenever work touches `backend-go/**`, whenever a UI feature needs a new or changed endpoint, or when reviewing backend work for standards compliance.
---

# Amiro Backend Standards

The rules any agent must follow when implementing anything in `backend-go/`.
The frontend and terminal UI belong to the `ui` skill — read that one when
the change is user-facing.

## What this backend has to be

One Go module, `amiro/backend`, that runs in four modes off the same code.
Every change must hold in all of them.

| Mode | Entrypoint | Notes |
|---|---|---|
| **Desktop sidecar** | `cmd/server` | Spawned by Tauri, binds a random loopback port, prints `PORT=`/`SESSION_TOKEN=` on stdout. Built **without** `-tags embedui` |
| **Dashboard server** | `cmd/amiro serve` | API + embedded Next.js export on one listener; can bind `0.0.0.0`. Built **with** `-tags embedui` |
| **Terminal UI** | `cmd/amiro` | Attaches to a running backend or embeds one; `--serve` does both |
| **Headless** | `cmd/amiro run` | One prompt, exit codes 0 / 1 / 2 — a documented contract, do not change casually |

Standing constraints:

- **Pure Go, no cgo.** sqlite is `glebarez/sqlite` (modernc) precisely so
  the binary cross-compiles. Never introduce a cgo dependency.
- **Two dialects, always.** sqlite (desktop) and postgres (web deploy). Any
  schema or query work must be correct on both.
- **Single binary.** No external database, broker or Node runtime at runtime.
- **A build without `-tags embedui` must still compile and serve the API.**

## Folder structure — `backend-go/`

```
backend-go/
├── cmd/
│   ├── server/        # the Tauri sidecar entrypoint
│   ├── amiro/         # the CLI: TUI, serve, run, auth, version
│   ├── eval/          # eval runner
│   └── swebench-pin/
├── internal/
│   ├── api/<domain>/  # HTTP handlers, one package per domain
│   │   └── httpjson/  # the shared JSON response helpers
│   ├── httpserver/    # router.go — every route registered in one place
│   ├── middleware/    # auth (shared secret), browser/CSRF, cors, ratelimit
│   ├── auth/          # sessions, passwords, tokens, RequireSession
│   ├── db/            # driver.go, migrate.go, models/, repository/, migrations/
│   ├── ai/            # bifrost/ (provider engine), tools/, prompts/, workflow/, ...
│   ├── agent/         # the agentic loop: session, permission, workspace, memory, lsp, repomap
│   ├── mcp/           # MCP manager, OAuth, permissions, tool ids
│   ├── secrets/       # OS keyring store — provider keys live here, never in config
│   ├── storage/       # local + s3 blobs, signed tokens
│   ├── search/        # web-search providers
│   ├── config/        # process configuration
│   ├── appwiring/     # shared construction + the single-instance lockfile
│   ├── web/           # dashboard embedding (embed_on.go / embed_off.go / dist/)
│   ├── tui/           # the terminal UI — see the `ui` skill
│   ├── user/ pricing/
└── tests/             # in-module e2e, migration, repository suites
```

`internal/` is a hard boundary — nothing outside the module imports it, and
that is deliberate. The root `tests/` module (the cross-surface harness)
talks to Amiro over its **public surfaces only** and must never import
`amiro/backend`.

## Adding an API route

Four steps, in order:

1. **Handler package** — `internal/api/<domain>/`. Conventional file split:
   - `handler.go` — the `Handler` struct, `NewHandler(...)`, response types,
     narrow consumer-side interfaces, and a package doc comment saying what
     this domain owns.
   - `route.go` — one exported method per HTTP route.
   - `<topic>.go` — split further when a domain grows (see `api/chat/`).
   - `*_test.go` beside each file.
2. **Register it in `internal/httpserver/router.go`.** That file is the
   single index of the HTTP surface; nothing self-registers.
3. **Wire the handler** into `Handlers` and into every entrypoint that
   constructs it (`cmd/server`, `cmd/amiro`, `internal/appwiring`).
4. **Add the client side** in `src/lib/backend/<domain>-api.ts` — see the
   `ui` skill.

### Handler rules

```go
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	var req listRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	// ... repository call ...
	httpjson.OK(w, toResponse(rows))
}
```

- **Always use `internal/api/httpjson`** — `OK`, `Write`, `Success`,
  `Error`, `Unauthorized`, `Forbidden`, `NotFound`, `BadRequest`,
  `ServerError`, `Decode`. Four legacy packages (`auth`, `chat`, `mcp`,
  `workflow`) predate it and keep private copies; do not add a fifth.
- Validate every query param and body field explicitly, with a `400` naming
  the offending field.
- Response structs are unexported, defined in `handler.go`, with explicit
  `json:` tags that match what the TypeScript client expects. Use
  `omitempty` only where the client actually treats absent and empty
  differently.
- Depend on **narrow interfaces declared in the consumer package**
  (`Engine`, `MCPTools`, `WorkflowTools` in `api/agent/handler.go`), not on
  concrete provider clients — that is what makes handler tests possible
  without a live provider.
- A `nil` field in `Handlers` must mean "those routes are not registered",
  never a nil-pointer panic. `router.go`'s `if h.X != nil` guards are load
  bearing for tests and for the untagged sidecar build.

### Route path rules

- Go's `net/http.ServeMux` **statically rejects** two patterns where neither
  is more specific at every differing position. Wildcard-then-literal versus
  literal-then-wildcard is the collision that bites here — it is why MCP
  id-scoped routes nest under a literal `servers` segment
  (`/api/mcp/servers/{id}/refresh`) instead of a bare `/api/mcp/{id}`.
  Register the routes and run the tests before assuming a path is legal.
- Paths otherwise mirror the original TS routes byte for byte. Document any
  divergence in a comment at the registration site, as the existing ones do.

## Auth, and the three guards

Know which layer you are adding to; they stack.

| Guard | Where | What it proves |
|---|---|---|
| `middleware.RequireToken` | Process edge (sidecar) | The caller knows the per-launch shared secret. Exempt prefixes only: `/storage/` and `/api/mcp/oauth/callback` |
| `middleware.RequireTokenOrBrowser` | Process edge (serve mode) | Shared secret **or** a same-origin browser request proven by `Sec-Fetch-Site` — the CSRF defense for `amiro serve` |
| `auth.RequireSession(h.Auth)` | Per route | A real signed-in user; puts the user in the request context |

- Wrap every route that touches user data in `auth.RequireSession`. Read the
  user with `auth.UserFromContext(r.Context())` and scope every repository
  call by `user.ID`.
- Admin gating happens **inside the handler** (`user.Role != "admin"` →
  `httpjson.Forbidden`), not in the router.
- `amiro serve --host 0.0.0.0` means an untrusted LAN caller. Anything new
  that is reachable unauthenticated, or that echoes secrets, is a real
  vulnerability — `/api/ai/providers` leaking a provider key to a non-admin
  is a recorded finding in `docs/testing/progress/`, not a hypothetical.
- Rate limiting (`middleware.RateLimitConfig`) is installed for non-loopback
  binds only; new unauthenticated routes must be considered for it.

## Database

```
internal/db/
├── driver.go            # dialect selection + connection
├── migrate.go           # hand-rolled runner: schema_migrations, versioned, transactional
├── migrations/sqlite/   # NNNN_name.up.sql + NNNN_name.down.sql
├── migrations/postgres/ # the same version numbers, dialect-correct SQL
├── models/              # gorm models, one file per table
└── repository/          # all query logic, one file + one _test.go per domain
```

Rules:

- **Every migration ships four files**: `up`/`down` × `sqlite`/`postgres`,
  sharing one version number. A sqlite-only migration is a broken web deploy.
- Migrations are append-only and immutable once committed. Fix a mistake
  with a new version, never by editing an applied one.
- Migrations are not run through golang-migrate (its sqlite source driver
  needs cgo) — the runner in `migrate.go` is deliberate. Don't replace it.
- **All SQL lives in `repository/`.** A handler never builds a query, and a
  repository never writes an HTTP response.
- Repository methods take `ctx` first and a `userID` for anything
  user-scoped. Ownership is enforced in the query, not after it.
- Dialect differences (`ON CONFLICT`, `RETURNING`, JSON columns, boolean and
  time types) are the usual trap — use `gorm.io/datatypes` for JSON columns
  as the existing models do, and add a case to `tests/migration` when a new
  shape appears.
- Postgres is written but under-exercised in this environment; when you
  touch dialect-sensitive SQL, say so in the phase record rather than
  claiming it was verified.

## Secrets, providers and MCP

- **Provider API keys go to the OS keyring** (`internal/secrets`) — never to
  `.env`, `config`, the database, a log line, or an API response. Return
  presence/status, not the key.
- Provider calls go through `internal/ai/bifrost`. Add a provider there, not
  in a handler.
- Consume the engine through a narrow interface so tests can fake it. The
  test system's fake provider and cassettes (`tests/cassettes/`) depend on
  provider traffic staying behind that seam.
- MCP servers are user-scoped; `internal/mcp` owns lifecycle, OAuth
  (RFC 9728/8414/7591/7636) and tool-id encoding. The OAuth callback route
  is deliberately unauthenticated and shared-secret-exempt — keep it
  narrow, and validate state.

## Errors, logging and comments

- Wrap with context: `fmt.Errorf("db: read migrations dir: %w", err)`.
- `httpjson.ServerError` deliberately reports `err.Error()` — the sidecar is
  loopback-only. If you add a route reachable in `--host 0.0.0.0` serve mode
  that could leak internals, sanitize at that route.
- Never log tokens, session ids, provider keys, or full request bodies.
- This codebase's comments explain **why**, especially where the Go
  implementation diverges from the original TypeScript route or from an
  obvious approach. Match that: a divergence with no comment will be
  re-litigated later.

## Testing

Three layers, all of which must stay green:

```bash
cd backend-go
go build ./... && go vet ./... && go test ./...      # unit + package tests
go test ./tests/...                                  # in-module e2e / migration / repository
```

```bash
cd tests                                             # the cross-surface harness
go run ./cmd/amirotest run --surface backend
```

- A new route gets a `*_test.go` in its handler package **and** is covered
  by a route-level test in `internal/httpserver/`.
- New schema gets a `tests/migration` case, both dialects.
- The root `tests/` harness is the phase-level proof; see `docs/testing/`.
  Run with `-race` when touching anything shared or concurrent — a latent
  data race in shared harness code survived six phases here.

## Build and packaging

```bash
go build ./...                                       # API only; must always work
pnpm build && ./scripts/build-ui.sh                  # stage the export for go:embed
go build -tags embedui -o bin/amiro ./cmd/amiro      # with the dashboard inside
GOOS=windows go build ./... ; GOOS=darwin go build ./...   # must stay clean
```

`internal/web/embed_on.go` / `embed_off.go` is the tag seam. A typed-nil
`*web.Handler` panicking an untagged build on a non-API route is a recorded
real defect — when you touch this seam, exercise **both** builds.

## Anti-patterns seen in this repo

| Don't | Do |
|---|---|
| A private `writeJSON` in a new package | `internal/api/httpjson` |
| SQL in a handler | a method on the repository |
| A sqlite-only migration | four files, one version, both dialects |
| Registering routes inside a handler package | `internal/httpserver/router.go` |
| Depending on `*bifrost.Client` in a handler | a narrow `Engine` interface in the consumer package |
| Returning a provider key in a response | return status/presence only |
| Admin checks in the router | `user.Role != "admin"` inside the handler |
| Adding a cgo dependency | keep it pure Go |
| Editing a committed migration | add the next version |
| Assuming a route path is legal | register it and run `httpserver`'s tests |
