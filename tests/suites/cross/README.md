# Amiro Cross-Surface Test Suites

The cross-surface suite tests Amiro's central architectural claim: the TUI,
the desktop app and the dashboard are three clients of **one backend and
one database** (`cmd/amiro/main.go`'s own doc comment). Every other suite
proves one surface works; this one proves the surfaces agree with each
other, and proves the two places that claim is a *security* property —
attach-or-embed, and `--connect` session scoping — hold up under attack,
not just under happy-path use.

## What a cross-surface test owns, versus a single-surface suite

A test belongs here, not in `suites/backend`, `suites/tui`, or `suites/ui`,
when the property under test **only exists because two clients share one
backend** — it cannot be stated, let alone violated, with a single client
talking to a single API. Concretely:

- **Owned here:** "a thread the TUI created is visible to a second client
  without a restart" (`threadvisibility`), "a session valid for server A
  must never authenticate against server B" (`connectscope`), "the second
  `amiro` process attaches instead of embedding a second backend"
  (`attachembed`), "an approval raised by one client can be answered by
  another" (`approvals`) — none of these are expressible with one client.
- **NOT owned here, even though it sounds cross-surface:** "workspace
  escape is refused" (a single-client property, re-asserted at the
  cross-surface/dashboard level by `suites/backend/security`, not
  duplicated here), "the agent loop streams tokens correctly"
  (`suites/backend/chat`), "the TUI renders Unicode correctly"
  (`suites/tui/rendering`). If a test would still make sense with the
  other surface deleted, it belongs to that other surface, not here.

**`cross` is a Go-test-driven surface, not a browser-driven one**
(`harness/selector.GoSurfaces`) — there is no way for a `go test` binary to
drive a rendered browser DOM. Wherever a journey below says "the
dashboard" or "the browser", the faithful (not mocked) representation is a
second `apiclient.Client` hitting the exact same backend a real dashboard
would — the dashboard and the TUI are both just HTTP clients of one
backend, which is the architectural claim under test. Package doc
comments say plainly where this substitution is faithful and where it
falls short of a real rendered check (see `threadvisibility`,
`sharedconfig`).

## Structure

```
tests/suites/cross/
├── attachembed/      # A second `amiro` attaches to a running backend; it never starts a second one
├── connectscope/     # A --connect session for one server is never accepted against another
├── threadvisibility/ # A thread started in the TUI is visible to a second client, no restart
├── agentmention/     # An agent created via the API is offered by the TUI's @-completion
├── sharedconfig/     # .amiro/config.yaml's defaultModel is honoured by a real TUI turn
├── providerkeys/     # A provider key added by one client is immediately usable by a TUI already running
├── concurrent/       # Two clients writing the same thread converge; no write is silently lost
├── approvals/        # A turn's approval gate can be answered by a DIFFERENT client than the one that started it
├── mcpsharing/       # An MCP server configured by one client is visible, callable, and @-mentionable from another
├── export/           # A thread exported from the TUI is readable by a genuinely signed-out client
├── servetui/         # `amiro --serve --port N`: the TUI and that port serve one embedded backend
└── skills/           # Dynamic skills discovered in project and user locations are visible identically in dashboard and TUI
```

## Known gaps (recorded here so they are not silently assumed covered)

- **`sharedconfig`:** only the TUI half of "both the TUI and the desktop
  sidecar honour it" is provable today. `backend-go/cmd/server` (the
  sidecar) never reads `.amiro/config.yaml` — only `cmd/amiro`'s own
  `internal/tui/config` does, despite that package's doc comment claiming
  otherwise. See the phase's progress doc for the closing decision this
  needs (a real product change, or correcting the doc/phase-table row).
- **`concurrent`:** "neither client is left showing stale state" is proven
  at the API level (both clients converge on one value, next read, no
  loss) — there is no push channel in the backend today (no websocket, no
  thread-events SSE), so a *rendered* surface repainting without a manual
  refresh is not covered here. A Playwright companion spec is the closing
  step.
- **`servetui`, `threadvisibility`, `agentmention`, `mcpsharing`, `providerkeys`:**
  drive a real `amiro` TUI under `harness/pty`, whose terminal emulator has
  a known rendering-fidelity gap (repaints can accumulate instead of
  replace, long rows hard-wrap mid-token) — worked around with a documented
  `unwrapped()` helper rather than weakened assertions, but this is also
  the most likely source of the rare (roughly 1-in-5 observed) flake in
  `servetui` specifically: a scripted turn's answer occasionally does not
  reach the rendered frame inside its wait window even though the backend
  answered correctly. Investigated, not silently retried away — see the
  verification log's Criterion 3 section.

## Running

```bash
# Run the whole cross-surface suite through amirotest
go run ./cmd/amirotest run --surface cross

# Run a specific journey
go run ./cmd/amirotest run --surface cross --feature servetui

# Run via standard go test (what CI would also use, with -race)
go test -race ./suites/cross/...
```
