# Progress

What has actually been built, as opposed to what is planned. The
[phases](../phases/README.md) hold the intent; this folder holds the
record — dated, with real numbers, and honest about what diverged.

**Last updated:** 2026-10-21

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 00 | Agent computer | ✅ Built and verified (uncommitted) | [phase-00-agent-computer.md](phase-00-agent-computer.md) |
| 01 | Egress restriction and gVisor | ⬜ Not started — **unblocked** | — |
| 02 | Lifecycle and activity | ⬜ Not started — **unblocked** | — |
| 03 | Browser in the container | ⬜ Not started — blocked on 01 | — |

## What works today

- Team agents get no runtime host tools at all. Shell and Files are per-agent
  switches (off by default), set through `PATCH /api/agents/{id}/computer`;
  the Computer view is built but not mounted in the Team UI (owner's decision).
- Team agents running on their own runtime also get their own remote (URL)
  connectors' MCP tools.
- `bash scripts/sandbox.sh up` starts `amiro-sandboxd`; switched-on tools then
  run in `amiro-agent-<id>` containers (non-root, no capabilities, read-only
  root, limits, only `/home/agent` mounted).
- `POST /api/agents/{id}/computer/check` measures that from inside the container.

## What does **not** exist yet

Phases 01–03. No per-agent egress, no gVisor detection, no start/stop or
activity UI, no browser.

## Next up

Phase 01 or 02 (both unblocked). Carry forward: snap-packaged Docker forces
`no-new-privileges` off (see the Phase 00 record), and the runtime's 120 s SDK
tool timeout caps shell commands at 110 s.

## How to update this folder

When a phase ships, add `phase-NN-<slug>.md` and
`verification-log-phase-NN.md` here recording:

1. **What shipped** — files created and modified.
2. **What diverged from the plan, and why.**
3. **How it was verified** — commands and their real output.
4. **Exit criteria**, checked off against the phase doc's own list.
5. **Follow-ups surfaced** — things that belong to a later phase.

Then update the status table above, and mark the phase doc itself.
