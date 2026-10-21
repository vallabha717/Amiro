# Multi-agent Team

Amiro grows from one agent to a team. After onboarding the owner lands on
**Team**, a full-page app of its own: every agent in a list, and clicking one
opens its fixed **Team thread** beside the list, like a direct message in
Teams. **Open <name>** (e.g. **Open Nova**) goes to that agent's **space**: the full Amiro app,
unchanged, acting as that agent — its chats, Personality, models, connectors,
keys and schedules. Amiro (the onboarded agent) is just the default; new
agents are created in Team and configured in their own space.

| Read in order | What it settles |
| --- | --- |
| [01-reference-architectures.md](01-reference-architectures.md) | What rakazo and OpenDots do, and what Amiro takes from each |
| [02-design.md](02-design.md) | Data model, storage layout, API, runtime patch, UI, isolation |
| [03-per-agent-config.md](03-per-agent-config.md) | One runtime per agent; agent spaces; per-agent providers, connectors, keys, schedules |
| [implementation-plan.md](implementation-plan.md) | Phases, deliverables, exit criteria |
| [progress.md](progress.md) | What was actually built and verified (the record, not the plan) |

## Goals

1. Onboarding still creates exactly one agent; when it finishes, the owner
   lands on the Team view with that agent's channel open.
2. Each agent has **one channel thread** that always exists, cannot be
   deleted, and streams answers like any other Amiro chat.
3. A **New agent** wizard creates further agents (name, look, role,
   instructions, model). A new agent gets its own workspace and appears in
   the Team list immediately.
4. Each agent has a page where the owner personalises it further and sees
   its channel pinned above its other chats and its workspace files.
5. The main Amiro UI stays as it is; the first agent *is* the existing main
   agent.

## Decisions already made

| Decision | Why |
| --- | --- |
| The onboarded agent is the existing main agent (`id: "main"`), not a new record | No migration for existing installs; its persona, memory, schedules and `~/.amiro/workspace` keep working unchanged |
| Additional agents live in `~/.amiro/agents/<id>/` — **outside** the main workspace | The main agent's working folder must not contain other agents' folders, otherwise it can wander into them by relative path |
| One runtime process for all agents; persona selected per session from the session's working folder | Running one runtime per agent multiplies memory and provider logins; the prompt builder already knows the session's folder, so a small patch is enough |
| The runtime only switches persona when the folder is inside `AMIRO_AGENTS_ROOT` | A user project folder that happens to contain an `IDENTITY.md` must never hijack the persona |
| The channel is a normal thread entry with `agentId` + `channel: true` | Reuses the whole chat pipeline (`/api/chat`, `/api/thread/{id}`, streaming, titles, replay) instead of building a second one |
| The backend, not the client, decides an agent thread's working folder | A client-supplied `workingDir` could point an agent at another agent's folder |
| Main sidebar lists only main-agent threads; other agents' threads appear on their own page | The main UI stays uncluttered as the team grows |
| Stage 1 isolation = separate folder + persona; **not** a security boundary, and the UI/docs say so | Honest product rule. Container-per-agent (OpenDots model) is Stage 2 — see [02-design.md](02-design.md#isolation) |
| Memory, schedules, heartbeat and connectors stay shared in Stage 1 | Splitting them touches the runtime memory store and the scheduler; recorded as follow-ups |
| Team is its own full-page app (`src/app/(team)/`), not inside the main sidebar layout | Owner's call (2026-10-21): Team is a separate place; the main app is reached with **Open <name>** (e.g. **Open Nova**) |
| An agent's configuration happens in its **space** — the existing Amiro pages scoped to it — not on a new agent page | Owner's call: no second set of settings pages; Amiro's pages already cover models, connectors, keys, schedules, personality |
| Each agent has its own runtime process (providers, connectors, memory, sessions) and key vault | See [03-per-agent-config.md](03-per-agent-config.md) |
