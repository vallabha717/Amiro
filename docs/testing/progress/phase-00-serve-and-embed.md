# Phase 0 — Serve the dashboard · implementation record

**Shipped:** 2026-08-19 · **Plan:** [phases/phase-00-serve-and-embed.md](../phases/phase-00-serve-and-embed.md)
**Verification:** [verification-log-phase-00.md](verification-log-phase-00.md)

The only phase in the plan that changes product code rather than test code.
It existed because UI end-to-end testing had nothing real to point at:
`next.config.ts` is `output: "export"`, so `out/` is a static bundle with no
server; `grep -rn "embed.FS\|http.FileServer" backend-go` returned exactly
one hit (`internal/db/migrate.go`, for migrations); and `cmd/server` binds
`127.0.0.1` by design, documenting that it must never be `0.0.0.0`.

## What shipped

### New packages and commands

| File | Lines | What it does |
|---|---:|---|
| `backend-go/internal/web/web.go` | 248 | Serves the Next.js export: resolution ladder, cache headers, bootstrap injection, build id |
| `backend-go/internal/web/embed_on.go` | 25 | `//go:build embedui` — `//go:embed all:dist` |
| `backend-go/internal/web/embed_off.go` | 17 | `//go:build !embedui` — reports no bundle |
| `backend-go/internal/middleware/browser.go` | 136 | `RequireTokenOrBrowser` — the serve-mode auth guard |
| `backend-go/internal/middleware/ratelimit.go` | 137 | Per-IP token bucket on the unauthenticated auth routes |
| `backend-go/cmd/amiro/serve_cmd.go` | 304 | `amiro serve`, and `serveTransport` for `amiro --serve` |
| `scripts/build-ui.sh` | 55 | `next build` → stage `out/` into `internal/web/dist` |

### Modified

| File | Change |
|---|---|
| `internal/httpserver/router.go` | `Options{UI, BrowserAuth, AllowedOrigins, LoopbackOriginWildcard, RateLimit}` + `NewWithOptions`; `apiAware` wrapper on the `/` catch-all. `New()` keeps its two-argument shape and its exact previous behaviour |
| `internal/middleware/cors.go` | `CORS(origins []string, loopbackWildcard bool)`; `LoopbackCORS` delegates to it, unchanged for callers |
| `internal/tui/client/embedded.go` | `EmbeddedOptions{BindHost, Port, UI, AllowedOrigins, RateLimit}` + `StartEmbeddedWith`, `Port()`, `BindHost()`. The zero value is the original behaviour |
| `cmd/amiro/main.go` | `serve` subcommand + usage |
| `cmd/amiro/tui.go` | `--serve --host --port --ui-dir --allow-origin`, with rejection of each when `--serve` is absent |
| `cmd/amiro/version.go` | Reports the embedded bundle's build id, or says there is none |
| `internal/tui/{app/app.go, page/chat.go, component/status/bar.go}` | `SetDashboardURL` threaded to a new status-bar field |
| `src/lib/backend/config.ts` | `__BACKEND_ORIGIN__` + `isSameOriginBackend()` |
| `src/lib/backend/client.ts` | Omits the shared-secret headers when same-origin |
| `.gitignore`, `README.md` | Ignore the staged bundle; document `amiro serve` |

### Tests — 53 new

| Package | Tests | Runtime |
|---|---:|---:|
| `internal/web` | 10 | 0.02s |
| `internal/middleware` | 15 | 0.01s |
| `internal/httpserver` | 9 | 26.5s* |
| `cmd/amiro` | 9 | 0.4s |
| `tests/e2e` | 10 | 38.7s* |

\* whole-package figures — those packages already held slow suites; the
new tests are a small part of each. The `tests/e2e` cost is dominated by
`go build ./cmd/amiro` per test, which Phase 1's binary caching removes.

## What diverged from the plan, and why

Two things, both decided while implementing and both worth keeping.

### 1. A served page cannot use the shared secret — so it doesn't

The plan said *"A real token, always."* It assumed the browser could prove
itself the way the Tauri webview does. Working through it, that turns out
to be impossible in principle rather than merely awkward.

The shared secret works for the webview only because Rust injects it
privately — `src-tauri/src/lib.rs` builds an `initialization_script`
carrying `window.__BACKEND_TOKEN__` before any frontend script runs. A page
delivered over HTTP has no equivalent channel. Anything it needs to
authenticate is, by construction, handed to every browser that loads it. So
embedding the secret would not be a second factor; it would be a longer
URL that every visitor already has.

`middleware.RequireTokenOrBrowser` resolves this by keeping the header path
exactly as it was for programmatic clients — `amiro --connect`, the TUI
attaching, the sidecar — and letting a browser prove itself structurally
instead:

```
allow if the shared-secret header matches            → every existing client
   or Sec-Fetch-Site is same-origin / none           → the page we just served
   or Sec-Fetch-Site is cross-site and Origin is     → --allow-origin
      explicitly allowed
   or there is no origin signal at all               → curl/scripts, on to
                                                        auth.RequireSession
otherwise 401
```

`Sec-Fetch-Site` is the load-bearing choice. It is on the browser's
forbidden-header list, so a page cannot set it and cannot lie about being
same-origin. An `Origin` check alone is weaker: `Origin` is absent on
same-origin GETs, which makes "no Origin" ambiguous between the dashboard
and a script.

The token requirement survives wherever it still means something: a
non-loopback bind refuses to start without one, and `--no-ui` — no served
page, so no browser has earned the relaxation — keeps the header mandatory
for every caller. That last one was found by a test asserting the opposite;
the design was right and the test was wrong.

Verified live: a cross-site `POST /api/auth/register` is refused with 401.
That is the request that would otherwise let a drive-by page claim the
admin account on a fresh instance, since the first registered account
becomes admin.

### 2. Cookies turned out to be unnecessary

The plan called for an `HttpOnly` cookie session for the browser. That
would have added a second session model *and* a CSRF surface, because
cookies are attached automatically to cross-site requests.

The existing bearer-token session (`internal/auth`,
`Authorization: Bearer`) already works from a served page, needed no
changes at all, and is CSRF-immune by construction: setting a custom header
cross-origin requires a preflight, which CORS refuses. One session model,
not two.

## Design notes worth keeping

**The build tag is not an optimisation.** `go:embed` resolves at compile
time against files that only exist after `pnpm build` plus
`scripts/build-ui.sh`. Making it unconditional would mean a fresh clone
could not `go build ./...` until someone had installed Node and run a
frontend build — a Go contributor hitting a TypeScript-shaped wall on their
first command. Release builds pass `-tags embedui`; everything else gets a
working binary that says plainly it has no UI.

**`apiAware` exists because `/` matches everything.** The dashboard is
registered on the bare `/` pattern, which `ServeMux` reaches only after
every method+path API pattern has failed. Without the wrapper, a mistyped
`/api/...` route would hand back the SPA shell with a 200 — a client would
parse HTML as JSON, and a person debugging would see a page that looks like
it briefly loaded. Unmatched `/api/`, `/storage/` and `/health` paths answer 404
JSON instead.

**The any-`localhost:<port>` CORS allowance is switched off in serve mode.**
Reflecting every loopback origin is a reasonable convenience for a listener
only this machine can reach. It stops being harmless the moment the
listener is bound past loopback, because it becomes a blanket cross-origin
pass to whatever a local process happens to be serving. The served
dashboard is same-origin and needs no CORS allowance at all, so the list
starts empty and grows only by `--allow-origin`.

**`0.0.0.0` is never printed as a URL.** It is a bind directive, not a
destination — pasting it on another device does not work. `dashboardURL`
resolves a real reachable address for a wildcard bind.

## Exit criteria — all met

Against the plan's own list:

1. ✅ `pnpm build && ./scripts/build-ui.sh && go build -tags embedui ./cmd/amiro` → one binary with the UI inside (87MB; bundle 740 files / 24MB).
2. ✅ `amiro serve --host 0.0.0.0 --port 8899` serves the dashboard; reachable over the LAN; register → session → authorised API call all work.
3. ✅ Deep links load on hard refresh — 8 real routes checked, all 200.
4. ✅ `amiro --serve` runs the TUI and serves the dashboard from one embedded backend and one database; URL in the status bar.
5. ✅ A non-loopback bind without a token is refused; the warning prints before the alt-screen opens.
6. ✅ `go build ./...` works with no bundle present; `go test ./...` fully green (1058 test functions).

Beyond the list: `tsc --noEmit`, `biome lint` and `vitest` (354 tests) are
also clean.

## Follow-ups surfaced

Recorded here rather than fixed, because each belongs to a later phase:

- **Bifrost logs to stdout ahead of `PORT=`.** Any reader must scan
  line-by-line for the prefix, not read the first line. `tests/e2e` and
  `src-tauri/src/lib.rs` already do; Phase 1's `harness/backend` must.
- **`docs/notes-backend-testing.md`'s four failures now pass**, including
  all four `TestSidecar_*`, with nothing changed to fix them. That was
  Phase 1's entry condition. Both that file and the phases index have been
  updated.
- **`--ui-dir` is more useful than anticipated.** It serves an export from
  disk with no Go rebuild, which is how the e2e tests avoid needing a
  frontend build at all. Phase 5's Playwright suite should use it for
  iteration and keep `ui.mode: embedded` for what it actually tests — the
  shipped path.
- **`tests/e2e` rebuilds `cmd/amiro` per test** (~2.7s each). Fine at ten
  tests; Phase 1's binary caching (`harness/backend`) should absorb it
  before the suite grows.
- **The desktop app still loads its own bundled frontend**, not
  `internal/web`. Unifying them is not required and was not attempted —
  but Phase 6's `ui-parity` feature is where any divergence between the
  webview and the served page will show up.
