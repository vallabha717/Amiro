# 03 — Selection: running exactly what you want

The requirement: *run all three (four) surfaces together, or one surface
alone, or one feature within one surface.* Selection is therefore a
first-class part of the design, not a flag bolted on afterwards.

## The addressing scheme

Every test has a stable address:

```
<surface> / <feature> / <test name>
```

- **surface** — `backend` · `tui` · `ui` · `desktop` · `cross`
- **feature** — the directory name under `suites/<surface>/` or `ui/specs/`
- **test name** — the Go test function name or the Playwright test title

The address is derived from the filesystem. There is no registry file to
keep in sync, and adding a feature means creating a directory.

```
suites/backend/chat/stream_test.go   → backend/chat/TestStream_EmitsTextDeltas
ui/specs/chat/streaming.spec.ts      → ui/chat/"streams tokens into the bubble"
```

## The command

```bash
cd tests

amirotest run                                   # everything config.yaml selects
amirotest run --surface ui                      # one surface
amirotest run --surface ui --feature chat       # one feature of one surface
amirotest run --surface ui --feature chat --grep "streams tokens"
amirotest run --surface backend,tui             # several surfaces
amirotest run --feature chat                    # the chat feature on EVERY surface
amirotest run --tag smoke                       # by tag, across surfaces
amirotest run --live                            # providers.mode=live for this run
amirotest run --update-golden --surface tui     # rewrite golden frames
```

Supporting commands:

```bash
amirotest list                        # every surface/feature/test address
amirotest list --surface ui           # scoped
amirotest doctor                      # is the toolchain complete? go, node, browsers, cargo, keys
amirotest record --surface backend --feature chat   # live + write cassettes
amirotest report --run <run-id>       # re-render summary.md from an old run
amirotest env --surface ui            # print the env a standalone runner needs
amirotest config example              # regenerate config.example.yaml from defaults
amirotest clean                       # prune logs/ per logging.keepRuns
```

Flags always beat `config.yaml`. `amirotest run --surface ui` on a config
that lists all four surfaces runs only the UI — the flag is an override of
`run.surfaces`, not an intersection with it.

## How selection resolves

`harness/selector` turns a selection into concrete runner invocations.

**Go surfaces** map to package paths:

```
--surface backend                → go test ./suites/backend/...
--surface backend --feature chat → go test ./suites/backend/chat/...
             ... --grep "Stream" → go test ./suites/backend/chat/... -run 'Stream'
--surface backend,tui            → go test ./suites/backend/... ./suites/tui/...
```

**The UI surface** maps to Playwright paths and grep:

```
--surface ui                → playwright test ui/specs
--surface ui --feature chat → playwright test ui/specs/chat
             ... --grep "x" → playwright test ui/specs/chat --grep "x"
--browser firefox           → playwright test --project firefox
```

**`--feature X` with no `--surface`** runs `X` wherever it exists —
`suites/backend/chat`, `suites/tui/chat`, `ui/specs/chat`,
`suites/cross/chat`. This is the "prove one feature end to end across every
surface" mode, and it is the most useful one when you have just changed a
feature.

An unknown feature name is an error listing the valid names, never a
silent zero-test pass. `amirotest run --surface ui --feature caht` fails
immediately with a suggestion.

## Tags

Directory structure handles *what* a test covers. Tags handle
cross-cutting properties:

| Tag | Meaning |
|---|---|
| `smoke` | The minimal path that proves the surface is alive. Runs first, fails fast. |
| `live` | Requires real provider credentials and network. Excluded by default. |
| `slow` | Over ~30s. Excluded by default; included by `--tag slow` or in the nightly job. |
| `flaky` | Quarantined. Runs, reports, never fails the build. Must carry a linked issue. |
| `destructive` | Mutates something outside the run's temp dirs (e.g. the real keyring). Opt-in only. |

In Go, a tag is a harness call at the top of the test — so it participates
in the same selection logic rather than needing build tags:

```go
func TestChat_AgainstRealAnthropic(t *testing.T) {
    h := harness.New(t, harness.Tags("live", "slow"))
    ...
}
```

`harness.New` skips the test (with a recorded reason, not a silent pass) if
the current selection excludes any of its tags. In Playwright, native test
tags do the same job:

```ts
test("streams tokens", { tag: ["@smoke"] }, async ({ amiro, page }) => { ... })
```

## Running without the wrapper

`amirotest` must never be the *only* way to run a test. Editors, debuggers,
CI shards, and agents all want to invoke the native runner directly, and
they must work with no ceremony:

```bash
cd tests
go test ./suites/backend/chat/ -run TestStream_EmitsTextDeltas -v
pnpm playwright test ui/specs/chat/streaming.spec.ts --headed
```

Both work because **the harness self-bootstraps**. `harness.New(t)` and
Playwright's `amiro` fixture each:

1. look for `AMIRO_TEST_RUN_DIR`; if set, join that run,
2. otherwise resolve `config.yaml` themselves and mint a fresh run
   directory.

So a bare `go test` produces the same log tree as a full orchestrated run —
just with one test in it. This matters most for agents: an agent iterating
on a single failing test gets the full artifact trail without knowing the
CLI exists.

## Composition and parallelism

- Surfaces run **in parallel with each other** by default; features within a
  surface run in parallel up to `run.parallel`.
- `backend`, `tui`, and `ui` each get their own backend instance per test —
  no shared state, so parallelism is safe by construction.
- `desktop` runs **serially and last**. It binds a real window and, in
  `bundled` mode, installs an app; overlapping instances fight.
- `cross` runs after the single-surface suites. A cross-surface failure
  when the single-surface suites are green is a genuinely different signal
  from everything failing, and the ordering makes that readable.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every selected test passed (or was skipped for a recorded reason) |
| 1 | At least one test failed |
| 2 | Configuration or validation error — nothing was run |
| 3 | Infrastructure failure — a binary would not build, a port would not bind, a browser was missing |

3 is distinct from 1 on purpose. "The suite could not run" and "the code is
broken" demand different responses, and CI should surface them differently.
