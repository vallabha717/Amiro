# 02 — Configuration

One file, `tests/config.yaml`, configures every surface. The committed
template is [`reference/config.example.yaml`](reference/config.example.yaml)
— it is annotated with the default for every single key and is the
authoritative schema reference. This document explains the *rules* around
it.

## The core rule

> **Everything is optional. Anything you don't set uses a documented
> default. A missing `config.yaml` is a valid, passing configuration.**

This is not politeness — it is what makes the suite usable by a new
contributor, by CI, and by an AI agent that has no credentials. Concretely:

| You have | You get |
|---|---|
| No `config.yaml`, no keys | `fake` providers, sqlite, chromium, all four surfaces (desktop auto-skips) — a green run |
| No `config.yaml`, cassettes committed | `replay` providers — full-fidelity request/response assertions, still no network |
| `config.yaml` with real keys | `record` or `live` mode available; everything else still defaulted |

`harness/config/defaults.go` holds the complete default tree as a Go value.
It is the single source of truth; `config.example.yaml` is generated from it
by `amirotest config example`, and a test asserts the two never drift.

## Precedence

Lowest to highest — later layers overwrite earlier ones, key by key:

```
1. built-in defaults        harness/config/defaults.go
2. tests/config.yaml        the user's file, if present
3. tests/config.local.yaml  gitignored per-machine overrides, if present
4. AMIRO_TEST_* env vars    AMIRO_TEST_PROVIDERS_MODE=live
5. CLI flags                amirotest run --live --surface ui
```

Merging is **deep for maps, replace for lists**. Setting
`providers.llm` in `config.yaml` replaces the default list entirely rather
than appending to it — a partial list of providers is what you meant, not a
merge you have to reason about.

The env-var mapping is mechanical: dot-path uppercased, dots to
underscores, prefixed `AMIRO_TEST_`. `run.parallel` → `AMIRO_TEST_RUN_PARALLEL`.
List values are comma-separated: `AMIRO_TEST_RUN_SURFACES=ui,backend`.

## Variable expansion

`${VAR}` and `${VAR:-fallback}` are expanded in every string value, from
the process environment and from `tests/.env` if it exists. This keeps
secrets out of `config.yaml` even though `config.yaml` is gitignored —
belt and braces, and it means the same `config.yaml` works in CI where keys
come from the secret store.

An unset `${VAR}` with no fallback expands to the empty string and is
treated as "not configured", not as an error. A provider entry with an
empty `apiKey` is silently dropped from the resolved config and noted in
`run.json` — so a `config.yaml` listing six providers on a machine with one
key configured does the obvious thing.

## Validation

Validation runs at step 2 of the [run lifecycle](01-architecture.md#run-lifecycle),
before anything is built or spawned, and fails the run with a single
readable report rather than one error at a time:

- **Unknown keys are errors.** A typo like `providers.mode: replya` or
  `run.paralel: 8` must not silently do nothing. The error names the key,
  the file, the line, and the nearest valid key.
- **Enums are checked** against their allowed values, with the valid set in
  the message.
- **Durations and sizes** are parsed (`30m`, `2m`, `65536`, `64KiB`).
- **Paths are resolved and checked** — `backend.binary`, `ui.distDir`,
  `providers.cassetteDir` must exist if set.
- **Cross-field rules**: `providers.mode: record` requires at least one
  provider with a non-empty key; `backend.database.driver: postgres`
  requires a `dsn`; `ui.mode: static` requires `distDir` to contain
  `index.html`.
- **Warnings, not errors**, for things that are legal but probably
  unintended: `ui.host: 0.0.0.0` (recorded in the summary), `run.retries`
  above 3, `logging.keepRuns: 0`.

The fully resolved, redacted config is written to
`logs/<run-id>/run.json`. Every question of the form "what was this run
actually configured with?" is answered by that file, never by re-reading
`config.yaml`.

## Mapping to what the app actually reads

The harness translates resolved config into the environment each binary
expects. That translation is one function, `harness/backend.Env()`, and it
is the only place that knows about `AMIRO_*` variable names.

| Config key | Becomes |
|---|---|
| `backend.bindHost` | `AMIRO_BIND_HOST` |
| `backend.port` | `AMIRO_PORT` |
| `backend.database.driver` | `AMIRO_DATABASE_DRIVER` |
| `backend.database.dsn` | `AMIRO_DATABASE_URL` |
| `backend.workspaceRoot` | `AMIRO_WORKSPACE_ROOT` |
| (per-run generated) | `AMIRO_AUTH_TOKEN`, `AMIRO_APP_DATA_DIR` |
| `providers.llm[].apiKey` | seeded into the DB via `POST /api/ai/providers`, **not** env |
| `providers.llm[].baseUrl` | rewritten to the cassette proxy in `replay`/`record` mode |
| `tui.terminal.*` | PTY size + `TERM` |
| `accounts.*` | registered via `POST /api/auth/register` during seeding |

Two of those deserve a note:

**Provider keys go through the API, not the environment.** Amiro stores
provider configs in the database (`/api/ai/providers`) with
`internal/secrets` behind them; injecting `OPENAI_API_KEY` into the
environment would exercise `EnvStore`, which is the *web deployment* path,
not the desktop path most users are on. Seeding through the real endpoint
tests the real storage. A dedicated suite covers the env path separately.

**Base URLs are rewritten, not intercepted.** In `replay` and `record`
mode the harness starts the cassette proxy and seeds each provider's
`baseUrl` pointing at it. No monkey-patching, no HTTP client injection —
the backend genuinely makes an outbound request and genuinely gets a
response. See [05](05-recording-and-replay.md).

## Per-test overrides

A test can override config for its own scope without touching the file:

```go
h := harness.New(t, harness.With(func(c *config.Config) {
    c.Backend.Database.Driver = "postgres"
    c.Providers.Mode = config.ProviderFake
}))
```

Overrides are recorded in the test's entry in `summary.json`, so a result
never depends on config you can't see from the artifacts.

## `config.yaml` vs the app's own `.amiro/config.yaml`

These are different files and must not be confused:

- `tests/config.yaml` — **this plan's file.** Configures the test system.
- `.amiro/config.yaml` / `~/.config/amiro/config.yaml` — **the app's file**,
  read by `backend-go/internal/tui/config`. Today it holds `defaultMode`
  and `defaultModel`.

The app's file is itself something under test: `suites/tui/launch/` writes
project- and user-level `.amiro/config.yaml` files into a temp HOME and
asserts the documented precedence (CLI flags → project → user → `AMIRO_*`
env → built-in defaults) actually holds, including the "a malformed file is
ignored, not fatal" behaviour its loader promises.
