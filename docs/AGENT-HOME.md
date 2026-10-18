# Agent home and Workspace

The agent's workspace (`~/.amiro/workspace`, the folder chats run in unless a
project is picked) is also its home. A few files at its top level shape who
the agent is and what it knows about right now; they are loaded into every
turn. The model follows Vellum's workspace files, adapted to Amiro.

## The files

| File | Owner | Loaded every turn | Purpose |
| --- | --- | --- | --- |
| `IDENTITY.md` | Personality page | yes | Name, handle, tagline and personality in plain language. Regenerated on every Personality save; read-only in the Workspace. |
| `SOUL.md` | the agent | yes | How it works: core truths, boundaries, where to put things, and **"Working with <you>"** — rules it writes the moment you correct how it works. |
| `USER.md` | you and the agent | yes | A one-page profile of you. Lasting facts only. |
| `NOW.md` | the agent | yes | Present-tense scratchpad: focus, open threads, what's coming up. Overwritten as things change. |
| `BOOTSTRAP.md` | the agent | yes, while it exists | First-conversation plan. Seeded only on a fresh install; the agent deletes it when the first chat winds down. |
| `HEARTBEAT.md` | you and the agent | no (heartbeat runs only) | The checklist the background heartbeat runs. |
| `journal/` | the agent | no | Dated, append-only entries (`journal/YYYY-MM-DD.md`). |
| `notes/`, `apps/`, `attachments/` | the agent | no | Created on first use: saved notes, apps worth reopening, and copies of files you send in chat. |

Templates live in `agent-home/` in the repo. Lines starting with `_ ` are
notes for the agent: the runtime strips them from the prompt, and the
Workspace shows them as a "Notes for your agent" callout.

## How it works

- **Seeding** (`backend/src/agent_home.rs`): at startup, after owner setup and
  on each heartbeat, missing files are written from the templates with your
  name, email and timezone filled in. Existing files are never overwritten.
  `BOOTSTRAP.md` is written only on a genuinely fresh install, once.
  `IDENTITY.md` is generated from the saved identity if it is missing.
- **Loading** (`runtime/crates/amiro-base/src/agent_home.rs`): the backend
  sets `AMIRO_AGENT_HOME` for the runtime; every turn the runtime re-reads
  IDENTITY, SOUL, USER, NOW and BOOTSTRAP and adds them to the dynamic part of
  the system prompt (after the cacheable prefix). Edits show up on the next
  turn. Per-file cap 16k chars, block cap 40k.
- **Heartbeat** (`backend/src/heartbeat.rs`): every few hours (default 4h,
  quiet 22:00–08:00 in your timezone) a background turn with tools runs the
  `HEARTBEAT.md` checklist in the workspace. If the agent answers exactly
  `HEARTBEAT_OK` nothing is shown; otherwise its note lands in a "Heartbeat"
  thread marked unread. It never runs while another turn is in flight.
  Settings: `GET /api/agent-home`, `PUT /api/agent-home/heartbeat`,
  `POST /api/agent-home/heartbeat/run`.
- **Attachments**: files sent in chat are also copied to
  `attachments/<date>-<name>` and the turn is told where.

## Workspace page

`/agent/workspace` (`src/components/workspace-browser/`) is a two-pane file
browser over the workspace: tree with search, sort and hidden files on the
left; viewer with formatted/source views, edit (Ctrl/Cmd+S), download, new
file/folder, rename and delete on the right. The **Agent home** bar above it
opens each home file directly and holds the heartbeat controls (on/off,
interval, last and next run, run now, open its notes). Backend:
`backend/src/routes/agent_workspace.rs` (`/api/workspace/*`), realpath-
contained, dotfiles hidden and never writable, `users/` internal.

The composer's folder picker shows **Workspace** by default; choosing a
folder points the agent at a project, and × returns to the Workspace. The
agent home loads either way.

## Verification (2026-10-18)

Isolated stack with a scripted model: fresh install seeded every file with
the owner's details and BOOTSTRAP; the model's prompt carried IDENTITY, SOUL,
USER, NOW and BOOTSTRAP with no note lines or placeholders; an edit to NOW.md
appeared on the very next turn; a Personality save rewrote IDENTITY.md (name
and a moved slider) without touching NOW.md; a chat attachment was saved to
`attachments/`; one heartbeat answered `HEARTBEAT_OK` silently and the next
created the unread Heartbeat thread; the Workspace bar, heartbeat panel and
Workspace picker rendered with no browser errors. Backend 193 lib tests +
integration suites, runtime agent-home and prompt tests, and 788 frontend
tests pass.
