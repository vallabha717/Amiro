# 04: Artifacts and logs

Every run creates one directory. Everything any surface produces goes
inside it. Nothing is written anywhere else.

```
tests/logs/2026-08-19T14-32-05Z-a1b2c3/
```

`tests/logs/latest` is a symlink to the newest run. `tests/logs/` is
gitignored and pruned to `logging.keepRuns` (default 20) at the start of
each run.

## The tree

```
logs/<run-id>/
├── run.json                    ← resolved config, selection, git SHA, tool versions
├── summary.md                  ← human-readable report, written at the end
├── summary.json                ← machine-readable results, one entry per test
├── events.ndjson               ← THE MERGED TIMELINE: every surface, one clock
│
├── backend/
│   ├── <test-id>/
│   │   ├── server.stdout.log
│   │   ├── server.stderr.log
│   │   ├── http.ndjson         ← every request/response through the harness client
│   │   ├── db/amiro.db         ← kept on failure (or always, if configured)
│   │   └── workspace/          ← the agent's file-tool sandbox, as it ended up
│   └── build.log
│
├── tui/
│   └── <test-id>/
│       ├── session.cast        ← asciinema v2: replayable with `asciinema play`
│       ├── frames/
│       │   ├── 0001-launch.txt         ← plain text screen
│       │   ├── 0001-launch.ansi        ← with escape sequences intact
│       │   └── 0002-after-submit.txt
│       ├── keys.ndjson         ← every keystroke injected, with timestamps
│       ├── golden.diff         ← only on a golden mismatch: expected vs actual
│       └── stdout.log · stderr.log
│
├── ui/
│   ├── results.json            ← Playwright's JSON reporter output
│   ├── html/                   ← Playwright HTML report
│   └── <spec>/<test>/
│       ├── trace.zip           ← `pnpm exec playwright show-trace <path>`
│       ├── video.webm          ← the recording of the run
│       ├── screenshots/
│       │   ├── 001-signed-in.png
│       │   └── failure.png
│       ├── console.ndjson      ← browser console, including errors and warnings
│       ├── pageerrors.ndjson   ← uncaught exceptions
│       └── network.har         ← every browser request
│
├── desktop/
│   └── <test-id>/
│       ├── tauri.stdout.log · tauri.stderr.log
│       ├── sidecar.stdout.log · sidecar.stderr.log   ← the spawned Go server
│       ├── ports.ndjson        ← PORT= handoff, discovery-lock reads/writes
│       └── screenshots/
│
└── providers/
    ├── calls.ndjson            ← every LLM/search call: model, tokens, latency, cost
    ├── cassettes.ndjson        ← hit / miss / recorded, per request
    └── cost.json               ← total spend for the run (0.00 unless live)
```

`<test-id>` is the slugified test address: `backend-chat-TestStream_EmitsTextDeltas`.
It is stable across runs, so diffing two runs' artifacts is trivial.

## `events.ndjson`: the merged timeline

The single most useful artifact. One JSON object per line, one monotonic
clock, every surface interleaved:

```json
{"ts":"2026-08-19T14:32:11.204Z","run":"a1b2c3","surface":"ui","test":"ui/chat/streams tokens","kind":"action","msg":"click","detail":{"selector":"[data-testid=send]"}}
{"ts":"2026-08-19T14:32:11.219Z","run":"a1b2c3","surface":"backend","test":"ui/chat/streams tokens","kind":"http","msg":"POST /api/chat","detail":{"status":200,"ms":14}}
{"ts":"2026-08-19T14:32:11.231Z","run":"a1b2c3","surface":"provider","test":"ui/chat/streams tokens","kind":"cassette","msg":"hit","detail":{"cassette":"chat/basic-turn.yaml","model":"claude-sonnet-5"}}
{"ts":"2026-08-19T14:32:11.402Z","run":"a1b2c3","surface":"backend","test":"ui/chat/streams tokens","kind":"stream","msg":"frame","detail":{"type":"text-delta","len":18}}
{"ts":"2026-08-19T14:32:11.455Z","run":"a1b2c3","surface":"ui","test":"ui/chat/streams tokens","kind":"assert","msg":"FAIL","detail":{"expected":"Hello","actual":""}}
```

That trace answers "the browser clicked, the backend got the request, the
provider replayed, frames came back, the DOM never updated": a frontend
bug: without opening five files. `amirotest report --run <id> --timeline
--test <address>` filters it to one test.

The Playwright fixture and the Go harness both append to this file through
`harness/logging`, which serialises writes. Clock skew between processes is
not a problem because every process stamps against the run's start time,
carried in `AMIRO_TEST_RUN_STARTED_AT`.

## Recordings

You asked specifically for recordings. There are three kinds, and all
three are on by default:

| Surface | Artifact | How to view |
|---|---|---|
| UI | `trace.zip` | `pnpm exec playwright show-trace logs/latest/ui/<spec>/<test>/trace.zip`: DOM snapshots, network, console, and a timeline scrubber per action |
| UI | `video.webm` | any player; retained on failure by default, `ui.video: on` for always |
| TUI | `session.cast` | `asciinema play logs/latest/tui/<test>/session.cast`: a real replayable terminal recording, not a screenshot |

Playwright's trace is the important one: it is a full recording *plus* the
state needed to inspect any moment, which is strictly more useful than
video for debugging. Video is kept for the cases where someone wants to
watch it without tooling.

TUI casts are produced by `harness/pty`, which already owns the byte stream
between the test and the terminal. Writing asciinema v2 is a small format
(a JSON header line, then `[time, "o", data]` lines) and is worth having
natively rather than shelling out to `asciinema rec`.

## `summary.md`

Written at the end of every run, designed to be readable in a terminal or
pasted into a PR:

```markdown
# Amiro test run a1b2c3: 2026-08-19 14:32:05 UTC

**FAILED** · 148 passed · 3 failed · 12 skipped · 2m 14s
Selection: --surface ui --feature chat · providers: replay · git 1e9b78e

| Surface  | Passed | Failed | Skipped | Duration |
|----------|--------|--------|---------|----------|
| backend  |     92 |      0 |       2 |    41s   |
| tui      |     31 |      1 |       0 |    28s   |
| ui       |     25 |      2 |       4 |    52s   |
| desktop  |      0 |      0 |       6 |     0s   |  ← skipped: cargo not found

## Failures

### ui/chat/"streams tokens into the bubble"
Expected the assistant bubble to contain "Hello", found "".
  trace     logs/latest/ui/chat/streams-tokens/trace.zip
  video     logs/latest/ui/chat/streams-tokens/video.webm
  timeline  amirotest report --run a1b2c3 --timeline --test 'ui/chat/streams tokens'
Last backend event before the failure:
  14:32:11.402  POST /api/chat  200  frame{type: text-delta, len: 18}
```

Every failure entry names its artifacts by path. An agent reading
`summary.md` has everything it needs to investigate without guessing where
files went.

## Redaction

Redaction is applied by `harness/logging` at write time, not as a
post-processing pass: a secret that reaches disk once has leaked.
`providers.redact` (see [02](02-config.md)) names the header and JSON
fields whose values become `<redacted:sha256:8chars>`. The short hash lets
you assert *"the same key was used in both requests"* without ever storing
the key.

This covers `http.ndjson`, `network.har`, cassettes, `run.json`, browser
console output, and process stdout/stderr. A test in
`suites/backend/logging/` greps the entire produced log tree for every
configured secret value and fails if any appears: the redactor is itself
under test.

## Retention

`run.keepArtifacts` controls the heavy artifacts:

| Value | Kept |
|---|---|
| `always` | Everything, including videos and DB snapshots for passing tests |
| `on-failure` *(default)* | Heavy artifacts only for failed tests; logs and timeline for all |
| `never` | Logs, timeline and summaries only |

`run.json`, `summary.*` and `events.ndjson` are **always** kept regardless: they are small and they are what makes an old run interpretable.
