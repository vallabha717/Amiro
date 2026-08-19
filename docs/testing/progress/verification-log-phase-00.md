# Verification log

Phase 0 was verified against a real running binary, not only against its
own tests. This is what was run and what came back, so any claim in
[phase-00-serve-and-embed.md](phase-00-serve-and-embed.md) can be
re-checked rather than taken on trust.

**Date:** 2026-08-19 · **Platform:** Linux 6.17 · **Go:** 1.26.5

---

## 0. Build

```bash
pnpm build && ./scripts/build-ui.sh
```
```
==> staging out -> backend-go/internal/web/dist
==> staged 740 files (24M)
```

```bash
cd backend-go && go build -tags embedui -o bin/amiro ./cmd/amiro
```
```
real  0m3.610s          # 87M binary
```

```bash
./bin/amiro version
```
```
amiro dev
dashboard c13fe09381ec
```

A binary built *without* `-tags embedui` reports
`dashboard (not embedded -- built without -tags embedui)` instead — asserted
by `TestVersion_ReportsWhetherADashboardIsEmbedded`.

---

## 1. Dashboard and deep links

Started with `./bin/amiro serve --host 0.0.0.0 --port 8899`. Every request
below sends `Sec-Fetch-Site`, because a request without it is not testing
the path a browser takes.

```
GET /                    status=200 type=text/html size=20808
```

Same-origin marker, and its position:

```
window.__BACKEND_ORIGIN__=""
marker idx 4152   </head> idx 4183      # inside <head>, ahead of the bundle's scripts
```

Deep links, cold, as on a hard refresh:

```
/admin                 status=200
/agents                status=200
/sign-in               status=200
/mcp                   status=200
/workflow              status=200
/admin/providers       status=200
/admin/users/detail    status=200
/onboarding            status=200
```

Hashed asset caching:

```
/_next/static/chunks/b73e666b1dfe6e35.js
  status=200  cache=public, max-age=31536000, immutable
```

API on the same listener, and the two 404 kinds:

```
/health           {"status":"ok"}          status=200
/api/auth/status  {"isFirstUser":false}    status=200
/api/nope         {"error":"not found"}    status=404   type=application/json
/nope/page        (the export's 404.html)  status=404   type=text/html
```

That last pair is the `apiAware` contract: an unmatched API path answers as
an API, an unmatched page answers as a page.

---

## 2. Security guards

Restarted against a throwaway `AMIRO_APP_DATA_DIR` so the auth flow below
could not touch a real database.

```
same-origin browser GET /health          status=200
navigation (Sec-Fetch-Site: none)        status=200
CROSS-SITE GET /health (evil.example)    status=401
CROSS-SITE POST /api/auth/register       status=401
foreign Origin, no Sec-Fetch-Site        status=401
valid shared secret from a foreign site  status=200
```

The fourth line is the one that matters most. The first registered account
becomes admin (`internal/auth`), so a cross-site `POST /api/auth/register`
that succeeded would let a page the user merely *visits* claim the admin
account on a fresh instance. It is refused.

The sixth line is the compatibility floor: relaxing the header for browsers
did not break any programmatic client.

CORS, serve mode:

```
preflight from http://localhost:9999     ACAO=[]
```

Empty — the any-loopback-port allowance is off. In sidecar mode the same
request still reflects the origin, asserted by
`TestServeMode_DropsTheAnyLoopbackPortCORSAllowance`.

---

## 3. Full auth flow over the served origin

```
status (fresh db)   {"isFirstUser":true}

register            {"user":{"id":"7fe602db-...","name":"Phase Zero",
                             "email":"phase0@amiro.test","role":"admin"},
                     "token":"95a4dc09be656af2..."}

GET /api/thread                 status=200      # with Authorization: Bearer
GET /api/thread (no session)    status=401
```

First account becomes admin, the bearer session authorises API calls, and
no session means 401 — all with no shared secret anywhere in the exchange.

---

## 4. Rate limiting

Fourteen wrong-password attempts against `/api/auth/login` on a `0.0.0.0`
bind:

```
401 401 401 401 401 401 401 401 401 401 429 429 429 429
```

Ten (the configured burst), then refused. On a loopback bind no limiter is
installed at all — asserted by
`TestEmbeddedOptions_LoopbackNeedsNoRateLimit`.

---

## 5. Path traversal

Against the live server, with `curl --path-as-is` so the shapes reach the
handler rather than being normalised away by curl:

```
/../../../etc/passwd             no leak
/%2e%2e/%2e%2e/etc/passwd        no leak
/_next/../../../../etc/passwd    no leak
```

A separate unit test proves these genuinely reach the handler rather than
being rejected earlier by `net/http` — otherwise the test would pass for
the wrong reason:

```
"/../secret.txt"       -> URL.Path="/../secret.txt"      resolved="secret.txt"      ok=true
"/%2e%2e/secret.txt"   -> URL.Path="/../secret.txt"      resolved="secret.txt"      ok=true
"/..%2fsecret.txt"     -> URL.Path="/../secret.txt"      resolved="secret.txt"      ok=true
"/\\..\\secret.txt"    -> URL.Path="/\\..\\secret.txt"   resolved=""                ok=false
"/....//secret.txt"    -> URL.Path="/....//secret.txt"   resolved="..../secret.txt" ok=true
```

Each resolves to a name *inside* the bundle, where no such file exists, so
each 404s. The backslash form is rejected outright.

---

## 6. Network reachability

```
GET http://10.77.248.44:8899/    status=200 size=20808
```

Served on the machine's real LAN address, not just loopback — the thing
`--host 0.0.0.0` exists for.

---

## 7. `amiro --serve` — TUI and dashboard together

Run under a pty (`script -qfc`), since the TUI needs a terminal:

```
GET /         status=200 size=20808     # dashboard live while the TUI runs
GET /health   status=200
```
```
http://10.77.248.44:8901                # the URL, in the TUI status bar
WARNING: bound to 0.0.0.0               # printed before the alt-screen opens
```

Both halves of one embedded backend, one database.

---

## 8. Refusing a second backend

`attach-or-embed` exists because two processes writing one SQLite file is
how a desktop app corrupts its own state. `serve` is not an exception:

```
$ AMIRO_APP_DATA_DIR=$APPDIR ./bin/amiro serve --port 9001
amiro: another Amiro backend is already running for /tmp/tmp.By537cB0Tx
  quit the desktop app (or the other `amiro`) first -- two backends must not share one database

$ AMIRO_APP_DATA_DIR=$APPDIR ./bin/amiro --serve --port 9002
amiro: another Amiro backend is already running for /tmp/tmp.By537cB0Tx
  --serve needs its own backend, and two must not share one database
  quit the desktop app (or the other `amiro`) first, or run plain `amiro` to attach to it
```

And the normal path is unchanged — plain `amiro` still attaches to it.

---

## 9. Flag validation

```
amiro --host 0.0.0.0                   -> --host has no effect without --serve
amiro --port 9002                      -> --port has no effect without --serve
amiro --ui-dir /tmp                    -> --ui-dir has no effect without --serve
amiro --allow-origin https://x.example -> --allow-origin has no effect without --serve
amiro --serve --connect URL --token T  -> --serve cannot be combined with --connect:
                                          --connect attaches to a backend this process does not own
```

Someone who types `amiro --port 8080` expecting a dashboard and silently
gets a TUI with no server has been failed by the CLI, not by their own
reading.

---

## 10. Lifecycle

`TestServe_ShutsDownGracefullyOnSIGTERM` sends SIGTERM, waits for exit, then
confirms the port is actually released rather than merely the process
reaped — a serve process that ignored SIGTERM would leak the listener and,
worse, keep the discovery lock, so the next `amiro` would attach to a
backend on its way out.

---

## 11. Regression check

```bash
cd backend-go
go build ./...              # no tag — must work without a bundle    OK
go build -tags embedui ./...                                        OK
go vet ./...                                                        OK
go test ./...               # 1058 test functions                   all pass

cd .. && npx tsc --noEmit                                           clean
npx biome lint src/lib/backend/{config,client}.ts                   clean
npx vitest run              # 354 tests                             all pass
```

Notably `go test ./...` now includes the four suites
`docs/notes-backend-testing.md` recorded as failing on 2026-08-16 —
`internal/auth`'s first-user test, two `internal/httpserver` ownership
tests, and all four `tests/e2e` `TestSidecar_*`. All pass, with nothing
changed to fix them.
