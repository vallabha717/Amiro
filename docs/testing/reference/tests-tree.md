# Reference — the target `tests/` tree

The full layout, as it exists once every phase is complete. The phase that
creates each part is noted in the right column.

> **What exists today (2026-08-19, after Phase 1):** everything marked P1,
> with three corrections recorded in
> [progress/phase-01](../progress/phase-01-harness-foundation.md):
> `go.mod` has **no** `replace amiro/backend` (the Go compiler forbids it),
> `config.example.yaml` is generated rather than hand-written, and
> `suites/meta/` holds its guards as flat files rather than the
> `waivers.yaml` + per-guard split sketched below. `cassettes/` and
> `package.json` exist as placeholders. Nothing marked P2–P8 exists.

```
tests/
├── README.md                          # quickstart: copy config, run, read logs      P1
├── config.example.yaml                # generated from defaults.go — see reference/  P1
├── config.yaml                        # yours; gitignored                            —
├── config.local.yaml                  # per-machine overrides; gitignored            —
├── .env                               # ${VAR} source; gitignored                    —
├── .gitignore                         # config*.yaml, .env, logs/, node_modules/     P1
├── go.mod · go.sum                    # module amiro/tests; no app dependency        P1
├── package.json · pnpm-lock.yaml      # @amiro/tests — playwright only               P5
├── playwright.config.ts               # derives everything from the harness          P5
├── Taskfile.yml                       # thin wrappers over amirotest                 P1
│
├── cmd/
│   └── amirotest/                     # the one entrypoint binary                    P1
│       ├── main.go
│       ├── run.go · list.go · doctor.go · record.go
│       ├── report.go · env.go · config.go · clean.go
│       └── backend.go                 # `backend start --json` for the PW fixture    P5
│
├── harness/                           # the shared Go library
│   ├── harness.go                     # harness.New(t, opts...) — the entry point    P1
│   ├── options.go                     # Tags, NoSeed, With, Surface                  P1
│   ├── config/
│   │   ├── config.go · defaults.go · merge.go · expand.go · validate.go
│   │   ├── env.go                     # AMIRO_TEST_* overlay
│   │   ├── redact.go
│   │   └── testdata/                  # valid, malformed, unknown-key fixtures
│   ├── run/                           # run id, run dir, run.json, summary           P1
│   ├── logging/                       # NDJSON fan-out + events.ndjson + redaction   P1
│   ├── process/                       # spawn, readiness, groups, teardown asserts   P1
│   ├── backend/                       # build, env, spawn, PORT=, /health, db, ws    P1
│   ├── apiclient/                     # typed /api/* client; logs every exchange     P1
│   │   ├── client.go · auth.go · thread.go · chat.go · agent.go · mcp.go
│   │   ├── workflow.go · archive.go · export.go · search.go · provider.go
│   │   ├── user.go · admin.go · storage.go
│   │   └── stream.go                  # SSE → uimessage.Frame decoding
│   ├── seed/                          # declarative seeds, applied via the real API  P1
│   ├── selector/                      # surface/feature/grep/tag → runner args       P1
│   ├── assert/                        # golden, normalise, Eventually, JSON subset   P1
│   ├── cassette/                      # record/replay proxy                          P3
│   │   ├── proxy.go · record.go · replay.go · match.go · normalize.go · format.go
│   ├── fakeprovider/                  # deterministic OpenAI/Anthropic-shaped server P3
│   │   ├── server.go · script.go · openai.go · anthropic.go · failures.go
│   ├── pty/                           # PTY, ANSI screen, keys, frames, asciinema    P4
│   │   ├── pty.go · screen.go · keys.go · frames.go · cast.go · wait.go
│   ├── browser/                       # Go↔Playwright bridge: env, results collect   P5
│   └── desktop/                       # Tauri launch, toolchain detect, port trace   P6
│
├── suites/                            # Go suites — path IS the test address
│   ├── backend/                                                                    P2/P3
│   │   ├── smoke/ auth/ thread/ agent/ mcp/ workflow/ archive/ bookmark/
│   │   ├── export/ user/ admin/ providers/ search/ storage/ models/
│   │   ├── config/ migration/ lifecycle/
│   │   ├── chat/                      # the agent loop — largest suite               P3
│   │   ├── resilience/                # failure injection                            P7
│   │   ├── perf/                      # budgets, slow-tagged                         P7
│   │   ├── security/                  # mechanical checks                            P7
│   │   └── **/testdata/               # normalised API goldens
│   ├── tui/                                                                          P4
│   │   ├── launch/ config/ auth/ chat/ approval/ palette/ pickers/
│   │   ├── headless/ rendering/
│   │   └── **/testdata/               # golden screens at tui.terminal size
│   ├── desktop/                                                                      P6
│   │   ├── lifecycle/ orphans/ discovery/ ports/ data/ ipc/ webview/
│   │   ├── packaging/                 # slow-tagged
│   │   └── ui-parity/                 # smoke UI specs against the webview
│   ├── cross/                                                                        P7
│   │   ├── tui-ui/ config/ providers/ transport/ concurrency/ export/ serve/
│   └── meta/                          # the guards — tests of the test system    P1→P8
│       ├── config_drift_test.go · route_coverage_test.go · secret_leak_test.go
│       ├── orphan_test.go · artifact_contract_test.go · no_sleep_test.go
│       ├── address_unique_test.go · import_boundary_test.go · runtime_budget_test.go
│       └── waivers.yaml               # explicit, reviewed exceptions
│
├── ui/                                # TypeScript / Playwright                      P5
│   ├── fixtures/
│   │   ├── amiro.ts                   # per-test backend, seeded accounts
│   │   ├── auth.ts                    # signedIn / admin fixtures
│   │   └── console.ts                 # console + pageerror capture, fail-on-error
│   ├── pages/                         # page objects, data-testid selectors
│   │   ├── sign-in.page.ts · sign-up.page.ts · onboarding.page.ts
│   │   ├── chat.page.ts · agents.page.ts · mcp.page.ts · workflow.page.ts
│   │   ├── archive.page.ts · admin.page.ts · export.page.ts · settings.page.ts
│   ├── specs/                         # feature dir == --feature name
│   │   ├── auth/ onboarding/ chat/ threads/ agents/ mcp/ workflow/
│   │   ├── archive/ export/ admin/ settings/ dashboard/ a11y/ responsive/
│   │   └── visual/                    # deliberately small scope
│   └── support/
│       ├── resolve-run.ts             # AMIRO_TEST_RUN_DIR or `amirotest env`
│       ├── timeline-reporter.ts       # appends into events.ndjson
│       └── matchers.ts
│
├── fixtures/                          # data, not code                           P1→P3
│   ├── workspaces/{basic,go-project,ts-project,large,unicode}/
│   ├── mcp/server/                    # a real stdio MCP server, deterministic tools
│   ├── mcp/oauth/                     # minimal OAuth authorization server
│   ├── seeds/{threads,agents,workflows}/*.json
│   ├── media/{image.png,document.pdf,audio.wav,oversized.bin}
│   └── configs/{amiro,mcp}/           # incl. deliberately malformed variants
│
├── cassettes/                         # committed provider recordings               P3
│   └── <surface>/<feature>/<name>.yaml
│
└── logs/                              # gitignored, created per run                 P1
    ├── latest -> <newest run>
    └── <run-id>/                      # see 04-artifacts-and-logs.md
```

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Feature directory | lowercase, single word where possible | `chat`, `mcp`, `workflow` |
| Go test file | `<what>_test.go` | `stream_test.go` |
| Go test name | `Test<Subject>_<Behaviour>` | `TestStream_EmitsTextDeltasInOrder` |
| Playwright spec | `<what>.spec.ts` | `streaming.spec.ts` |
| Playwright title | a sentence describing the behaviour | `"streams tokens into the bubble"` |
| Test id (slug) | `<surface>-<feature>-<name>` | `backend-chat-TestStream_EmitsTextDeltas` |
| Golden file | `testdata/<Test>/<case>.golden` | `testdata/TestChat_Approval/dialog.golden` |
| Cassette | `<surface>/<feature>/<scenario>.yaml` | `backend/chat/basic-turn.yaml` |

## What deliberately is *not* here

- **`backend-go/tests/`** — stays where it is. Those suites import
  `internal/...` and belong inside the module. The root tree is black-box.
- **Unit tests** — stay colocated with the code they test.
- **`backend-go/evals/`** — LLM quality evaluation, a different discipline.
- **Mocks of Amiro's own components.** The root tree never mocks Amiro.
  It mocks the outside world (providers) and nothing else.
