# 02 — Design

## Concepts

| Term | Meaning |
| --- | --- |
| **Agent** | A persona with its own workspace folder. The first one is the existing main agent (`id: "main"`). |
| **Channel** | One permanent thread per agent and user. It is the conversation shown in the Team view and pinned at the top of the agent page. It cannot be deleted. |
| **Agent thread** | Any other chat with a non-main agent, started from its page. |
| **Team view** | `/team`: the list of agents plus the selected agent's channel. |

## Storage layout

```
~/.amiro/                         (AMIRO_HOME, state.home)
├── workspace/                    main agent: home + working folder (unchanged)
├── agents/                       AMIRO_AGENTS_ROOT — one folder per extra agent
│   └── <agentId>/                that agent's home + working folder
│       ├── IDENTITY.md           generated from the agent record (overwritten on edit)
│       ├── SOUL.md USER.md NOW.md HEARTBEAT.md   seeded once, then the agent's own
│       └── journal/
├── agents-archive/<agentId>-<ts>/  a deleted agent's folder, kept, never read
├── store/agents.json             the registry (below)
└── threads.json                  thread entries gain `agentId` and `channel`
```

`store/agents.json`:

```json
{
  "agents": [
    {
      "id": "a1b2c3…", "name": "Scout", "role": "Research assistant",
      "instructions": "Find sources, cite them.",
      "traits": {"bodyShape": "sprout", "eyeStyle": "curious", "color": "teal"},
      "createdAt": "…", "updatedAt": "…"
    }
  ],
  "channels": { "<agentId or main>": { "<userId>": "<threadId>" } }
}
```

The main agent is **not** stored in `agents`; its name, look and tagline come
from the existing identity (`agent.rs` `get_agent_identity`) so the
Personality page stays the single place to edit it. Only its channel mapping
lives here.

Agent ids are server-generated (`uuid` simple form, 32 hex chars) and
validated with `^[a-f0-9]{32}$` before any path is built, so an id can never
traverse out of `agents/`.

## API (`backend/src/routes/agents.rs`)

All routes need a session (`AuthUser`). Creating, editing and deleting need
the owner (admin) role, like the Personality page.

| Method & path | Who | Does |
| --- | --- | --- |
| `GET /api/agents` | any user | Main agent first, then others by creation time. Each includes `channelThreadId` for the caller (created on first read). |
| `POST /api/agents` | owner | `{name, role?, instructions?, traits?}` → 201 + agent. Creates the folder, seeds home files, writes `IDENTITY.md`, creates the caller's channel. |
| `GET /api/agents/{id}` | any user | One agent (404 if unknown). `main` works. |
| `PATCH /api/agents/{id}` | owner | Same fields as POST; rewrites `IDENTITY.md`. `main` → 409, edit it on the Personality page. |
| `DELETE /api/agents/{id}` | owner | Archives the runtime sessions of its threads, removes its thread entries and registry record, moves its folder to `agents-archive/`. `main` → 409. |
| `GET /api/agents/{id}/threads` | any user | The caller's threads with that agent, channel first. |
| `GET /api/agents/{id}/files` | any user | Read-only listing of the agent's folder (max depth 4, 500 entries, hidden and secret names skipped). |

Agent JSON (camelCase, as the UI reads it):

```json
{"id":"main","name":"Amiro","role":"…","instructions":"","traits":{…},
 "accentHex":"#E9642F","isMain":true,"channelThreadId":"…",
 "workspaceDir":"/home/…/.amiro/workspace","createdAt":"…","updatedAt":"…"}
```

## Chat routing (`backend/src/chat.rs`, `backend/src/threads.rs`)

- `POST /api/chat` accepts an optional `agentId`.
- The **existing thread entry wins**: if it already has an `agentId`, that
  agent's folder is the working folder and any client `workingDir` is
  ignored (an agent cannot be pointed at another agent's folder).
- A brand-new thread with `agentId` = a known non-main agent gets that
  agent's folder and stores `agentId` on the entry. Unknown id → 404.
  `agentId: "main"` or none → today's behaviour.
- `GET /api/thread` (the main sidebar) hides threads whose `agentId` is a
  non-main agent. Each item gains `agentId` and `channel`.
- `DELETE /api/thread/{id}` on a channel → 409 "the channel can't be
  deleted". `DELETE /api/thread` (clear all) skips channels.

## Runtime patch (persona per session)

`runtime/crates/amiro-base/src/agent_home.rs`:
`load_agent_home_files(working_dir: Option<&Path>)`. When
`$AMIRO_AGENTS_ROOT` is set and the session's working folder is inside it,
the agent home is `<root>/<first path component>`; otherwise it is
`$AMIRO_AGENT_HOME` exactly as before. The backend sets `AMIRO_AGENTS_ROOT`
in `runtime_env`. Recorded in `docs/runtime-customizations.json`.

Why a root and not "any folder with IDENTITY.md": a user's project folder
chosen in the composer must never be able to replace the persona.

## UI

| Route | Component | Purpose |
| --- | --- | --- |
| `/team?agent=<id>` | `src/components/team/team-view.tsx` | Agent list (left) + channel (right). Defaults to the main agent. |
| `/team/new` | `src/components/team/new-agent-wizard.tsx` | Steps: look & name → role & instructions → create. Lands on the new agent's channel. |
| `/team/agent?id=<id>` | `src/components/team/agent-page.tsx` | Tabs: Chats (channel pinned first, then other chats), Profile (edit), Workspace (read-only file list + isolation note). Main agent's Profile links to `/agent/personality`. |
| `/team/chat?agent=<id>&thread=<tid>` | `src/components/team/agent-chat-page.tsx` | A non-channel chat with a team agent; no `thread` starts a new one. Main-agent chats keep using `/?thread=`. |

Static export rule: ids are query parameters, never route segments.

The channel reuses `ChatBot` with two new optional props: `agentId` (sent in
the request body) and `threadPath` (the URL `ChatBot` writes with
`replaceState`, so it stays on `/team?agent=…` instead of jumping to `/`).

The sidebar menu gains a **Team** entry. Onboarding's final step and the
"already onboarded" redirect go to `/team`.

Theme: only existing tokens (`bg-background`, `border`, `text-muted-foreground`,
`bg-sidebar-accent`, `shadow-panel`, rounded-2xl panels) and the plush
`AgentCharacterAvatar` with `AVATAR_COLORS`, so every theme and dark mode
work without new CSS.

All strings live under the `Team` namespace in `messages/en.json` and
`messages/hi.json`.

## Isolation

**Stage 1 (this initiative).** Separate folder and persona per agent. The
runtime's shell and file tools still run as the Amiro user on the VM, so a
folder is **not** a security boundary: an agent told to read
`../<other>/notes.md` can. The agent page says this in one line. This matches
rakazo's shared Team Computer, which documents the same limit.

**Stage 2 (follow-up initiative).** OpenDots model:

1. A supervisor process (the only holder of the Docker socket, `cap_drop
   ALL`, `no-new-privileges`, loopback only).
2. One container per agent: non-root, `CapDrop: ALL`, memory/CPU/pids
   limits, only `~/.amiro/agents/<id>` mounted at `/home/agent`.
3. A per-agent credential `HMAC(master, "amiro-agent:" + id)`.
4. Per-agent tool policy (`shell`, `files`, `browser`) default **off**,
   enforced in the backend through the runtime's `configure_tools`.
5. Optional egress restriction and gVisor (`runsc`).

Stage 2 changes the runtime's tool execution path and is planned separately.

## Not in Stage 1

- Per-agent memory, schedules, heartbeat, connectors and model defaults
  (shared with the main agent for now).
- Agents talking to each other (rakazo `message_bot`); Amiro's swarm members
  remain the way to delegate inside one conversation.
- Mobile-specific layout beyond the responsive stack.
