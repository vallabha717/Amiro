# How to run the backend tests

The Go backend lives in its own module at `backend-go/` (module
`betterchatbot/backend`, `go 1.26.5`) — it is *not* wired into any root
Makefile, package.json script, or CI workflow (none exist in this repo).
Run it directly with the Go toolchain, from inside `backend-go/`:

```bash
cd backend-go
go build ./...   # compiles everything, catches type errors fast
go vet ./...     # static checks
go test ./...    # the actual test suite
```

This is also documented in `README.md` under "## Testing" (Backend
section) — that's the source of truth if this drifts.

Notes:
- No separate test tags/build constraints observed; `go test ./...` covers
  unit tests colocated with source (`*_test.go` throughout `internal/`)
  plus the dedicated suites under `backend-go/tests/` (`e2e/`,
  `migration/`, `repository/`).
- The frontend has its own separate test path: `pnpm test` (vitest) from
  the repo root, unrelated to the Go suite.
- `backend-go/evals/` is a different thing entirely — LLM-agent eval
  fixtures/tasks (`smoke.json`), not part of the regular test run.
- **Update 2026-08-19: all four of the failures below now pass.** Re-ran
  `go test ./...` on Go 1.26.5 while building Phase 0 of the testing plan
  (`docs/testing/`); the whole suite is green, `tests/e2e`'s
  `TestSidecar_*` included. Nothing was changed to fix them, which
  supports the environment-specific reading recorded below rather than a
  logic bug. This matters beyond bookkeeping: the `PORT=` stdout handoff
  those tests cover is what the planned test harness uses to find a
  backend, so it needed to be trustworthy before anything was built on it
  (see `docs/testing/phases/phase-01-harness-foundation.md`'s entry
  condition).

- Confirmed runnable as of 2026-08-16 (`cd backend-go && go test ./...`,
  Go 1.26.5). Most packages pass. At that point in time there were 4
  pre-existing failures, apparently unrelated to any change I made —
  worth checking if they're still failing before assuming a change broke
  them:
  - `internal/auth`: `TestRegister_MakesTheFirstAccountAdminAndEveryLaterOneAPlainUser`
  - `internal/httpserver`: `TestAdminRoutes_NonAdminGetsForbidden`,
    `TestRouter_McpDeleteRejectsNonOwnerAndSucceedsForOwner`
  - `tests/e2e`: all 4 sidecar tests (`TestSidecar_*`) — these spawn the
    compiled binary and expect a `PORT=` line on stdout; they failed with
    "sidecar exited or closed stdout before printing a PORT= line",
    which smells environment-specific (binary build/path issue) rather
    than a logic bug.
