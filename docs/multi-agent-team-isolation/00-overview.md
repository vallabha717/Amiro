# 00 — Overview

## Goal

Make the line between team agents real. Today (Stage 1, see
[../multi-agent-team/02-design.md](../multi-agent-team/02-design.md#isolation))
every team agent has its own folder and persona, but the runtime's shell and
file tools run as the Amiro user on the host, so an agent told to read
`../<other>/notes.md` can. Stage 2 moves a team agent's shell and file work
into **its own container**, started by a **supervisor** that is the only
process holding the Docker socket, and lets the owner decide per agent which
of those tools it gets at all.

After Stage 2:

1. A team agent's `shell` and `files` tools run inside a container that sees
   only `~/.amiro/agents/<id>` (mounted at `/home/agent`), as a non-root user
   with no Linux capabilities, under memory/CPU/process limits.
2. Nothing a team agent asks for falls back to the host. If its container is
   not available, the tool call fails with a message that says so.
3. Every tool is **off** until the owner turns it on for that agent.
4. The backend reaches each agent's container with a credential derived for
   that agent only: `HMAC-SHA256(master, "amiro-agent:" + id)`.
5. The owner can optionally cut a container's network and run it under gVisor.

## Surfaces in scope

| Surface | In scope | How |
| --- | --- | --- |
| backend | yes | tool policy API, supervisor client, tool routing in the turn worker |
| supervisor (new) | yes | `amiro-sandboxd` binary + container image under `packaging/sandbox/` |
| web | yes | the agent page's **Computer** tab (tool switches, status, self-check) |
| desktop (Tauri) | indirectly | the same static UI; no Tauri-specific code |
| terminal (TUI) | no | see non-goals |
| runtime | no product patch | uses the existing `configure_tools` custom-tool path |

## Principles

- **Fail closed.** A team agent session is configured with *no* built-in
  runtime tools and *no* MCP tools. The only tools it has are the backend's
  container-backed ones the owner switched on. Any path that starts a turn in
  a team agent's folder gets that configuration, not only the channel.
- **The supervisor is narrow.** Lifecycle (ensure, stop, status) and a small
  set of agent-scoped actions (exec, read, write, list). It never accepts an
  image, mount, command line for `docker run`, or capability from a caller.
- **One master secret, many derived credentials.** The master and the
  supervisor token live in one `0600` file on the host; neither is ever sent
  to a container, a model, a log or the chat.
- **Honest UI.** The agent page says what is actually true for *that* agent:
  "no tools", "tools run in its own container", or "its container is not
  available". The Stage 1 sentence stays for the main agent's folder.

## Non-goals

- **The main agent.** It keeps running on the host with the runtime's own
  tools; Amiro is meant to run inside a VM (see `docs/SECURITY-MODEL.md`).
  Containerising it is a different product decision.
- **Per-agent memory, schedules, connectors, models.** Tracked by the Stage 1
  follow-ups; this initiative only isolates tool execution.
- **Terminal UI.** The TUI talks to the runtime directly and has no team
  concept yet.
- **Remote sandboxes (E2B, Daytona).** Docker on the same VM only.
- **A shared team computer** (rakazo's model). Every agent gets its own.
- **Live screen / takeover.** The browser phase is headless.
