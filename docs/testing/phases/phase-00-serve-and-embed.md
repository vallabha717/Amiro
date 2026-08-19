# Phase 0 — Serve the dashboard

**Status: DONE** (2026-08-19) · **Depends on:** nothing · **Blocks:** 5, 6, 7
**This is the one phase that changes product code, not test code.**

> **Full record:** [`../progress/phase-00-serve-and-embed.md`](../progress/phase-00-serve-and-embed.md)
> · **Verification:** [`../progress/verification-log-phase-00.md`](../progress/verification-log-phase-00.md)
>
> **What shipped.** `internal/web` (embedded bundle + SPA fallback),
> `amiro serve`, `amiro --serve`, `middleware.RequireTokenOrBrowser`,
> `middleware.RateLimit`, `httpserver.Options`, `scripts/build-ui.sh`,
> and same-origin support in `src/lib/backend/`. 32 new tests across
> `internal/web`, `internal/middleware`, `internal/httpserver`,
> `cmd/amiro` and `tests/e2e`; the full Go suite, `tsc`, `biome` and
> `vitest` are green. See **Outcome** at the bottom for the two places
> the implementation deliberately diverged from the plan below.

## Why this is first

You want `amiro` to serve the dashboard on `0.0.0.0` with a `--port`. That
command does not exist, and neither does anything it would need:

- `next.config.ts` sets `output: "export"` — `out/` is a static bundle with
  no server behind it.
- The Go module has no static file serving anywhere.
  `grep -rn "embed.FS\|http.FileServer\|StripPrefix" backend-go` returns
  exactly one hit: `internal/db/migrate.go`, for migrations.
- `cmd/amiro` has four subcommands (`chat`, `run`, `auth`, `version`).
  No `serve`.
- `cmd/server` binds `127.0.0.1` by design and documents that it must never
  be `0.0.0.0` — it is a Tauri sidecar, not a server.
- `internal/httpserver.New` allows exactly one CORS origin, defaulting to
  `tauri://localhost`, and every `/api/*` route sits behind a shared-secret
  guard plus a session.

So UI end-to-end testing has nothing to point a browser at that resembles
what users get. Building this first means Phase 5 tests the shipped path
instead of a development approximation.

## Deliverables

### 1. Embed the built UI

`backend-go/internal/web/` — a new package:

```go
//go:embed all:dist
var dist embed.FS

// Handler serves the exported Next.js bundle with SPA fallback.
func Handler() (http.Handler, bool)   // false when built without the bundle
```

`internal/web/dist/` is populated from the repo root's `out/` by a build
step and is gitignored. A build tag (`//go:build !embedui`) provides a stub
returning `false`, so `go build ./...` works in a clean checkout with no
`pnpm build` — the server just reports that no UI is embedded. This keeps
the existing developer loop intact.

**Routing rules the handler must get right**, because Next.js static export
has specific shapes:

- `/_next/static/*` → serve with `Cache-Control: immutable`, hashed
  filenames.
- `/foo` → try `foo.html`, then `foo/index.html`, then fall back to
  `404.html`. The export produces `out/admin.html`, `out/agents.html` etc.,
  not directories, and getting this wrong makes deep links 404 on refresh —
  the classic SPA bug this must not ship with.
- Route groups (`(chat)`, `(auth)`, `(public)`) do not appear in URLs;
  the handler works from `out/`'s actual layout, not from `src/app`'s.
- `/api/*` must **never** be shadowed by a static file. API routes are
  registered first and the static handler is the last fallback.

### 2. `amiro serve`

```
amiro serve [flags]

  --host HOST     interface to bind (default 127.0.0.1)
  --port PORT     port to bind (default 0 = OS-assigned)
  --open          open the dashboard in a browser once ready
  --no-ui         API only; do not serve the dashboard
  -C dir          workspace root for agent file tools
  --token TOK     shared secret; generated and printed if omitted
```

And, per your ask, the TUI grows the same ability so one command gives you
both:

```
amiro --serve [--host 0.0.0.0] [--port 8080]
```

`amiro --serve` starts the TUI *and* exposes its embedded backend's
dashboard, printing the URL in the status bar. This is a natural fit for
the existing attach-or-embed transport in `cmd/amiro/serve.go`: today
`StartEmbedded` binds a loopback port "nobody outside this process ever
sees", and `--serve` is precisely the case where someone does.

### 3. Make binding beyond loopback safe and deliberate

`0.0.0.0` means anyone on the network can reach an agent that runs shell
commands and reads files. This phase must not ship a footgun.

- **Explicit opt-in.** `--host 0.0.0.0` never happens by default and never
  by inference.
- **A loud warning on startup**, matching the one `cmd/server/main.go`
  already prints for a non-loopback `BindHost`.
- **A real token, always.** When bound beyond loopback, the shared secret is
  mandatory — generated and printed if not supplied, never blank, never
  defaulted.
- **CORS.** `internal/httpserver` currently allows one origin. Serving the
  UI from the same origin as the API is the clean answer: same-origin
  needs no CORS at all. `--allow-origin` (repeatable) exists for the
  genuinely cross-origin case and defaults to empty.
- **Auth over a network.** Today the token arrives as a header the webview
  sets. A browser loading the page over the network cannot set a header on
  its own document request, so the served page needs a first-party session:
  the existing `/api/auth/login` flow with an `HttpOnly` cookie, which
  `internal/auth` already models. The shared-secret guard stays for the
  sidecar path.
- **Rate limiting on the auth endpoints** when bound beyond loopback.
  A network-reachable login is a brute-force target.

### 4. Build wiring

- `scripts/build-ui.sh` — `pnpm build` then sync `out/` →
  `backend-go/internal/web/dist/`.
- `amiro version` reports whether a UI bundle is embedded and its build
  hash, so a test can assert it is testing the bundle it thinks it is.
- `.gitignore` gains `backend-go/internal/web/dist/`.

## Tests written in this phase

These are ordinary Go tests in `backend-go`, colocated — the `tests/` tree
does not exist yet.

- `internal/web`: SPA fallback for every route shape in `out/`; deep links
  resolve; `/api` is never shadowed; missing bundle degrades cleanly;
  cache headers on hashed assets; no path traversal (`../../etc/passwd`,
  encoded variants, backslashes on Windows).
- `cmd/amiro`: `serve` flag parsing, the `--host 0.0.0.0` warning, the
  token-required rule, `--no-ui`.
- `tests/e2e`: start `amiro serve --port 0`, read the port, `GET /` returns
  the dashboard HTML, `GET /admin` returns HTML not 404, `GET /api/health`
  returns JSON, SIGTERM shuts down cleanly.

## Exit criteria

1. `pnpm build && ./scripts/build-ui.sh && cd backend-go && go build -tags embedui ./cmd/amiro` produces a single binary with the UI inside it.
2. `amiro serve --host 0.0.0.0 --port 8080` serves the dashboard, and a browser on another machine on the LAN can load it, log in, and hold a conversation.
3. A deep link (`http://host:8080/agents`) loads correctly on a hard refresh.
4. `amiro --serve --port 8080` runs the TUI and serves the dashboard from the same embedded backend, sharing one database — a thread started in the TUI appears in the browser.
5. Binding beyond loopback without a token is refused; binding beyond loopback prints the warning.
6. `go build ./...` still works with no bundle present, and `go test ./...` shows no new failures.

## Risks

- **`out/` staleness.** A stale embed means testing yesterday's UI. `amiro version` exposing the bundle hash, plus the harness comparing it against `src/`'s newest mtime, is the mitigation.
- **Binary size.** The bundle will add tens of MB. Acceptable; note it, and gzip the embedded assets if it becomes a problem.
- **Auth model divergence.** Two auth paths (header token for the sidecar, cookie session for the browser) is a real complexity increase. Keeping them as two guards over one session model — which `internal/auth` already supports — rather than two session models is the discipline that keeps it manageable.


---

## Outcome

Built as planned, with two deliberate divergences worth recording because
both change how the thing is used.

### 1. The served page authenticates structurally, not with the shared secret

The plan said "a real token, always" and imagined the browser proving
itself the way the Tauri webview does. Working through it, that turns out
to be impossible in principle rather than merely awkward: the secret works
for the webview only because Rust injects it privately
(`src-tauri/src/lib.rs`'s `initialization_script`). A page served over HTTP
has no private channel — anything it needs to authenticate is handed to
every browser that loads it, so embedding the secret would not be a second
factor, only a longer URL.

So `middleware.RequireTokenOrBrowser` keeps the header path intact for
every programmatic client (`amiro --connect`, the TUI attaching, the
sidecar) and lets a browser prove itself with `Sec-Fetch-Site` instead —
a forbidden header, so a page cannot forge it. Cross-site requests are
refused outright, which is a stronger CSRF defence than an `Origin` check
alone: `Origin` is absent on same-origin GETs, making "no Origin"
ambiguous between the dashboard and a script.

The token requirement survives where it still means something: a
non-loopback bind refuses to start without one, and `--no-ui` (no served
page, so no browser has earned the relaxation) keeps the header mandatory
for every caller.

Verified live: a cross-site `POST /api/auth/register` — the request that
would otherwise let a drive-by page claim the admin account on a fresh
instance — is refused with 401.

### 2. Cookies were not needed

The plan called for an `HttpOnly` cookie session for the browser. That
would have added a second session model *and* a CSRF surface, since
cookies are attached automatically. The existing bearer-token session
(`internal/auth`, `Authorization: Bearer`) already works from a served
page, is inherently CSRF-immune because setting the header cross-origin
requires a preflight, and needed no changes at all. One session model, not
two.

## Verified against a real build

`pnpm build && ./scripts/build-ui.sh` (740 files, 24MB) →
`go build -tags embedui` → an 87MB single binary, run on `0.0.0.0:8899`:

| Checked | Result |
|---|---|
| `/` serves the dashboard | 200, 20808 bytes |
| Deep links on hard refresh — `/admin`, `/agents`, `/sign-in`, `/mcp`, `/workflow`, `/admin/providers`, `/admin/users/detail`, `/onboarding` | all 200 |
| Hashed assets | `Cache-Control: public, max-age=31536000, immutable` |
| `/health`, `/api/auth/status` on the same listener | 200 JSON |
| Unknown API path | 404 **JSON**, not the SPA shell |
| Unknown page | 404 with the export's own `404.html` |
| Same-origin marker | `window.__BACKEND_ORIGIN__=""` injected inside `<head>` |
| Cross-site GET and `POST /api/auth/register` | 401 |
| Shared secret from a foreign site | 200 (programmatic clients unaffected) |
| Preflight from `http://localhost:9999` | no `Access-Control-Allow-Origin` |
| Register → session → `GET /api/thread` | 200; without a session, 401 |
| Login brute force | 10 attempts, then 429 |
| Path traversal (`../`, `%2e%2e`, `_next/../../..`) | no leak |
| LAN reachability from another interface | 200 |
| `amiro --serve` | TUI runs, dashboard on `0.0.0.0:8901`, URL in the status bar, warning printed before the alt-screen |
| Second backend on the same database | refused, both from `serve` and `--serve` |
| SIGTERM | exits, listener released |

## Exit criteria — all met

1. ✅ Single binary with the UI inside (87MB, `amiro version` reports bundle `c13fe09381ec`).
2. ✅ `--host 0.0.0.0 --port 8080` serves the dashboard; reachable over the LAN; sign-in works.
3. ✅ Deep links load on hard refresh.
4. ✅ `amiro --serve` runs the TUI and the dashboard off one embedded backend and one database.
5. ✅ Non-loopback without a token is refused; the warning prints.
6. ✅ `go build ./...` works with no bundle; `go test ./...` fully green.

## Follow-ups this phase surfaced

- **Bifrost writes startup logs to stdout**, ahead of the `PORT=` line. Any
  reader must scan line by line for the prefix rather than reading the
  first line — `tests/e2e` and `src-tauri/src/lib.rs` both already do, but
  Phase 1's `harness/backend` needs to know.
- **`docs/notes-backend-testing.md`'s four failures now pass**, including
  all four `TestSidecar_*`. That was Phase 1's entry condition, so Phase 1
  is unblocked.
- **`--ui-dir` turned out to be the more useful flag than expected.** It
  serves an export from disk with no Go rebuild, which is how the e2e
  tests avoid needing a frontend build — and it is what Phase 5's
  Playwright suite should use for iteration, keeping the embedded path for
  what it actually tests.
