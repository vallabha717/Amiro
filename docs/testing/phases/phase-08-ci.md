# Phase 8 — CI, guardrails, and reporting

**Depends on:** 7 · **Blocks:** — · **Size:** M

Everything built so far runs when someone remembers to run it. This phase
makes it run automatically, makes failures land where they are seen, and
adds the self-checks that keep the system from rotting.

## Starting point

There is no CI in this repo. No `.github/workflows`, no Makefile, no root
script that runs the Go module's tests —
`docs/notes-backend-testing.md` says so explicitly, and the four
pre-existing failures it records are precisely what happens without a gate.

## Deliverables

### 1. Workflows

Per [07](../07-ci.md):

| Workflow | Trigger | Runs |
|---|---|---|
| `lint.yml` | push | `go vet` · `biome lint` · `tsc --noEmit` · `amirotest config example --check` |
| `unit.yml` | push | `backend-go`'s `go test ./...` · root `pnpm test` |
| `smoke.yml` | push | `amirotest run --tag smoke` |
| `full.yml` | PR, main | `amirotest run --surface backend,tui,ui`, sqlite and postgres shards |
| `desktop.yml` | PR touching `src-tauri/**`, nightly | `amirotest run --surface desktop` |
| `live.yml` | nightly | `amirotest run --live --tag smoke`, cost-capped |
| `perf.yml` | nightly | `amirotest run --tag slow --feature perf` |
| `cassettes.yml` | weekly | `amirotest doctor --cassettes` — TTL and staleness report |

CI settings that matter: `strictCassettes: true`, `retries: 0`,
`keepArtifacts: on-failure`, and a prebuilt `backend.binary` so the build
happens once per workflow rather than once per test.

### 2. Build and cache steps

- One `go build` step producing `cmd/server` and `cmd/amiro`, cached by
  source hash.
- One `pnpm build` + `scripts/build-ui.sh` producing the embedded bundle.
- Cached: Go module cache, Go build cache, pnpm store, Playwright browsers,
  cargo registry and target for the desktop job.

### 3. Reporting

- `summary.md` posted as a PR comment, updated in place rather than
  appended, with failures and their artifact paths.
- The run directory uploaded as a build artifact on failure.
- `amirotest report --flaky` reading the last N runs and listing tests with
  mixed pass/fail history — including untagged ones, which is how
  quarantine candidates are found.
- A trend line for the perf budgets.

### 4. Self-guards — `suites/meta/`

The tests that test the test system. Several were added in earlier phases;
this phase completes the set and makes them all blocking:

| Guard | Fails when |
|---|---|
| Config drift | `config.example.yaml` ≠ `defaults.go` |
| Route coverage | A route in `router.go` is exercised by no test and has no waiver |
| Secret leakage | A configured secret's literal value appears anywhere in the log tree |
| Orphan processes | A spawned process outlives its test, or a port stays bound |
| Artifact contract | A failed test did not produce its surface's promised artifacts |
| No sleeps | A `time.Sleep` or `page.waitForTimeout` appears in a suite |
| Address uniqueness | Two tests share an address, or a feature directory has no tests |
| Import boundary | A suite imports `amiro/backend/internal/...` outside the permitted list |
| Runtime budget | The default run exceeds 10 minutes on the reference runner |
| Doc freshness | A phase's exit criteria reference a command that no longer exists |

### 5. Developer ergonomics

- `tests/README.md`: copy the config, run the command, read the logs. Three
  paragraphs, not a manual.
- `tests/Taskfile.yml` with the common invocations.
- A `CLAUDE.md` section — or the `run` skill's equivalent — telling an agent
  how to run one feature and where to read the artifacts. Given how much of
  this repo is agent-written, an agent that knows to run
  `amirotest run --surface ui --feature chat` and then read
  `logs/latest/summary.md` is a meaningful part of the value here.
- A git hook (the repo already uses husky) running `--tag smoke` on the
  surfaces touched by the staged diff.

## Exit criteria

1. Every workflow runs green on main.
2. A PR that breaks a route gets a red `full` job with `summary.md` in a comment naming the failure and its artifacts.
3. A PR that adds a route without a test gets a red route-coverage guard.
4. The nightly live job runs, reports its cost, and stays under the ceiling.
5. Every `suites/meta/` guard is blocking and passes.
6. A new contributor can go from clone to a green `amirotest run` using only `tests/README.md`.
7. `amirotest report --flaky` produces a useful list after 10 runs.

## Risks

- **CI runtime creeping past the point of usefulness.** The 10-minute budget on the merge gate is enforced by a guard, not by good intentions; anything slower gets tagged and moved to nightly.
- **Guards that fire spuriously get disabled.** Each guard needs a waiver mechanism with a recorded reason and an owner. A guard with no escape hatch gets deleted the first time it blocks an urgent fix.
- **The nightly live job failing on provider outages** trains people to ignore it. It opens or updates a single tracking issue rather than notifying per failure, and distinguishes "provider changed" (live fails, replay passes) from "we broke something".
