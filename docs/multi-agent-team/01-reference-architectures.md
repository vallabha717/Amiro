# 01 — Reference architectures: rakazo and OpenDots

Both projects were read at their `main` branches (October 2026), cloned next
to Amiro under `~/Projects/Personal/`. This file records what they do so the
choices in [02-design.md](02-design.md) can be checked against them later.

## rakazo (`elie222/rakazo`)

**Creating a bot** (`apps/api/src/router.ts` `bots.create`,
`packages/db/src/repos.ts` `createBot`): a Postgres row with name, title,
description, instructions, colour, model/provider/thinking level,
`computerMode` (`team` default or `dedicated`) and `disabledBuiltinTools`.
An intro run is enqueued right away so the bot greets the user in its
thread. Around 70 built-in tools are on by default (shell, files, desktop,
page browser, web, memory, schedules, tickets, secrets, spawn/delegate, MCP).
`packages/core/src/action-approval.ts` decides which need approval — shell,
files and browser do not; secret-backed HTTP, deletion, media generation and
cloud agents do.

**Where the agent runs**: the agent loop (Pi) runs in the API/worker
process. Only computer tools cross into a machine through `SandboxProvider`
(Docker, E2B, Daytona, Boat, CreateOS, Railway, or `none`).

**Isolation**: a workspace's bots share one Team Computer by default; each
bot starts in `bots/<id>/` with its own X display and Chrome profile, but the
docs state plainly that these folders *are not security boundaries*. A bot
can be given a Private (dedicated) computer. Docker computers run non-root
with `CapDrop: ALL`, `no-new-privileges`, 2 GB / 2 CPU / 2048 pids, only the
home mounted, and no Docker socket (only the supervisor has it). Egress is
open unless `SANDBOX_COMPUTER_EGRESS=restricted` plus host firewall rules.

**Secrets**: AES-256-GCM in Postgres; the model has no read tool. HTTP
credentials are injected by the backend and bound to an origin; website
logins are typed only on the saved HTTPS origin. "Command variables" are
deliberately exported to the shell and documented as readable by the bot.

**Persistence**: the workspace home is checkpointed to `DATA_DIR` at run end
and before suspend; system packages outside it are lost on replacement.

**UI**: a Teams/Slack-like list of bots; each bot has a thread; groups and
sections organise bots.

## OpenDots (`CopilotKit/OpenDots`)

**Creating a Dot** (`src/server/workspace.ts` `createDot`): name,
instructions, a home Space plus allowed Spaces, and switches —
`researchAllowed`, `memoryAllowed`, `appsAllowed` (Composio, off by default,
optional toolkit allow-list), learning/skills. Tools assembled per turn in
`src/server/dot-agent.ts`: page tools for permitted Spaces, research, memory,
MCP connections (read-only tools run, others pause for an **Approve & run**
card), Composio apps, and computer tools.

**Isolation** (`docs/COMPUTERS.md`): one container per Dot via OpenBot's
supervisor, separate named volumes for files and browser profile. Computer
permissions `enabled/browser/files/shell` are **all off by default** and
checked server-side on every action. Each Dot's computer token is
`HMAC(master, "opendots-computer:" + dotId)`, so one Dot's credential cannot
reach another's computer. The supervisor alone holds the Docker socket, has
`cap_drop: ALL` and `no-new-privileges`, and listens on loopback. The docs
admit the limits: shared kernel (gVisor optional), no egress policy, shell
can read the Dot's own browser profile. Nothing falls back to the host.

## What Amiro takes

| Concern | Taken from | In Amiro |
| --- | --- | --- |
| Product shape: team list, a permanent thread per agent, persistent agents | rakazo | Team view + channel thread ([02-design.md](02-design.md)) |
| Agent loop on the server, tools reach out | both | Already true: `amiro-runtime` is one process the backend bridges to |
| One workspace per agent, nothing shared by default | OpenDots | `~/.amiro/agents/<id>/`, outside the main workspace |
| Capabilities start off for new agents | OpenDots | Stage 2 (per-agent tool policy) — Stage 1 records the intent |
| Container per agent, per-agent derived credential, socket only in supervisor | OpenDots | Stage 2 design in [02-design.md](02-design.md#isolation) |
| Provider abstraction + workspace checkpoints | rakazo | Later, only if remote sandboxes are wanted |
| Honest docs about what is and is not a boundary | both | Stage 1 states that a folder is not a security boundary |
