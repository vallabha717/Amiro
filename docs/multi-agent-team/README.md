# Multi-agent Team

Amiro grows from one agent to a small team. After onboarding the owner lands
on a **Team** view: a list of agents on the left and, on the right, a
permanent conversation — the agent's **channel** — that works like a direct
message in Teams or Slack. Every agent has its own persona and its own
workspace folder. The main Amiro UI (chats, connectors, schedules, the
agent's Personality page) is unchanged and one click away.

| Read in order | What it settles |
| --- | --- |
| [01-reference-architectures.md](01-reference-architectures.md) | What rakazo and OpenDots do, and what Amiro takes from each |
| [02-design.md](02-design.md) | Data model, storage layout, API, runtime patch, UI, isolation |
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
| `/team` lives inside the existing `(chat)` layout | Keeps the icon rail/sidebar (Option B navigation) so the main UI is always one click away |
