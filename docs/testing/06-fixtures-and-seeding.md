# 06 — Fixtures and seeding

Isolation is the property everything else depends on. Every test in this
suite gets a fresh database, a fresh workspace, a fresh app-data directory,
and its own backend process. Nothing is shared, so nothing is
order-dependent, so parallelism is safe.

## Per-test isolation

`harness.New(t)` allocates and registers cleanup for:

| Resource | What the test gets |
|---|---|
| App data dir | `<runDir>/backend/<test-id>/appdata/` → `AMIRO_APP_DATA_DIR` |
| Database | A fresh sqlite file inside it (or a fresh postgres schema, dropped on cleanup) |
| Workspace | A **copy** of a fixture workspace at `<runDir>/backend/<test-id>/workspace/` → `AMIRO_WORKSPACE_ROOT` |
| Auth token | A fresh random `AMIRO_AUTH_TOKEN` |
| Port | OS-assigned; never a fixed number |
| Keyring | An in-memory `secrets.Store`, never the OS keyring — see below |
| HOME | A temp HOME, so `~/.config/amiro/config.yaml` is the test's, not yours |

That last pair matter more than they look. `internal/secrets` uses
`zalando/go-keyring`, and a test suite that writes to a developer's real
login keychain is unacceptable. `harness` sets
`go-keyring`'s mock provider for in-process use and points a temp
`XDG_DATA_HOME`/`HOME` at the run directory for spawned binaries. Anything
that would touch the real keyring is tagged `destructive` and excluded from
the default run.

## Seeding

Fixtures are applied through the **real API**, not by writing rows. That is
slower, and it is the right trade: seeding through `POST /api/auth/register`
and `POST /api/agent` means the seed itself exercises the endpoints, and a
seed that breaks is a genuine signal.

```go
h := harness.New(t)
be := h.Backend()

be.Seed(seed.Default)      // admin + user + other, one thread each
be.Seed(seed.Agents(3))
be.Seed(seed.MCPFixtureServer)
be.Seed(seed.Workflow("linear-3-node"))
```

Seeds compose and are declarative. `seed.Default` is applied automatically
unless a test opts out with `harness.NoSeed()` — tests about first-run
behaviour (the first registered account becoming admin, the onboarding
flow) need a genuinely empty database.

### Ordering constraint worth knowing

`backend-go/internal/auth` makes **the first registered account the admin**.
Seeding therefore always registers `accounts.admin` first, and a test that
wants to verify that rule uses `harness.NoSeed()` and registers by hand.
This is exactly the kind of implicit ordering that produces
order-dependent flakes when a suite shares a database — another reason
every test gets its own.

## `fixtures/` — data, not code

```
tests/fixtures/
├── workspaces/
│   ├── basic/            ← a few files; the default agent sandbox
│   ├── go-project/       ← real go.mod + packages, for LSP and repomap tests
│   ├── ts-project/       ← real tsconfig + src, same
│   ├── large/            ← ~2k files, for repomap/glob performance budgets
│   └── unicode/          ← non-ASCII names, CRLF files, symlinks, a 5MB file
├── mcp/
│   └── server/           ← a real stdio MCP server (Go), deterministic tools
├── seeds/
│   ├── threads/*.json    ← canned conversations, including long ones for compaction
│   ├── agents/*.json
│   └── workflows/*.json
├── media/
│   ├── image.png · document.pdf · audio.wav   ← for upload/attachment tests
│   └── oversized.bin     ← deliberately over the size limit
└── configs/
    ├── amiro/            ← .amiro/config.yaml variants incl. a malformed one
    └── mcp/              ← MCP server config JSON variants
```

**Workspaces are always copied, never used in place.** Agent file tools
write, and a test that mutates a fixture poisons every later test. The copy
is what `AMIRO_WORKSPACE_ROOT` points at, and it is preserved in the run
directory on failure so you can see exactly what the agent did to it.

The `unicode/` and `large/` workspaces exist because file-tool bugs cluster
there: path escaping, encoding, line-ending handling, and the performance
cliff when a repomap walks a big tree.

## The MCP fixture server

`fixtures/mcp/server` is a small, real MCP server (stdio transport) with
deterministic tools:

| Tool | Behaviour |
|---|---|
| `echo` | Returns its input. The happy path. |
| `slow` | Sleeps a configurable duration. Tests `MCP_MAX_TOTAL_TIMEOUT` and cancellation. |
| `fail` | Returns a protocol error. |
| `crash` | Exits the process. Tests reconnect and the "server went away" UI state. |
| `big` | Returns a payload over the response limit. |
| `needs_approval` | Marked as requiring permission. Drives the approval-gate tests. |

Building this rather than mocking the MCP client means
`internal/mcp/manager.go`'s real lifecycle — spawn, initialise, list tools,
call, reconnect, shut down — is under test. The OAuth flow gets a second
fixture: a minimal OAuth authorisation server so
`internal/mcp/oauth_flow.go` and the `/api/mcp/oauth/callback` route can be
exercised without a third party.

## Golden files

Two kinds, both with the same update ergonomics:

- **TUI screens** — `suites/tui/**/testdata/<Test>/<case>.golden`, plain
  rendered text at `tui.terminal` dimensions. Follows the convention
  `backend-go/internal/tui/page` already uses with
  `charmbracelet/x/exp/golden`, so the two are readable side by side.
- **API responses** — `suites/backend/**/testdata/<Test>.json`, normalised
  (ids, timestamps and durations replaced with stable placeholders) then
  compared structurally.

`amirotest run --update-golden` rewrites them. Two rules keep goldens
honest:

1. A golden update in a PR must be visible in the diff and reviewed. The
   `--update-golden` flag is never set in `config.yaml` or CI.
2. Golden comparison failures write `golden.diff` into the run directory
   with a unified diff, so the failure is readable from `summary.md`
   without re-running.

Normalisation is the load-bearing part of API goldens. `harness/assert`
owns the normaliser, and it replaces: UUIDs, ISO timestamps, durations,
port numbers, absolute paths under the run directory, and token counts
(which vary even in replay when the prompt embeds a date).

## Time and randomness

- Tests never `sleep`. `harness.Eventually(t, cond, within)` polls with a
  deadline and, on timeout, dumps the last observed state into the log.
- Anything the harness generates (ids, tokens, account suffixes) comes from
  a seeded PRNG derived from the run id, so a run is reproducible with
  `amirotest run --seed <run-id>`.
- Tests that genuinely depend on wall-clock behaviour (session expiry,
  cassette TTL, MCP timeouts) parameterise the duration down to
  milliseconds rather than waiting.
