# Chat UX and Swarm

This guide covers the chat experience work from 2026-10-18: the right-hand
session panel, the tool-call filter, inline images, smoother streaming, todo
deltas, and the swarm surfaces (the strip above the composer and side-by-side
agent panes). It also lists the backend routes that feed them.

The work is uncommitted at the time of writing (see
[session-2026-10-18.md](session-2026-10-18.md)). Behaviour is described from the
code, not from a live run.

## Session panel

Source: `src/components/workspace/session-panel.tsx`, summarised by
`src/lib/chat-ux/session-summary.ts`.

The panel sits to the right of the chat. It toggles from the chat toolbar
(`src/components/workspace/chat-toolbar.tsx`, "Show session panel"). Each card
collapses, and the collapsed set persists. The panel is hidden while an artifact
view is open.

Almost everything is derived from the thread's transcript (`summarizeSession`),
so a reopened thread shows the same panel as a live one.

| Card | Shows | Source |
| --- | --- | --- |
| Agents | Swarm members with activity dots, and agents this transcript spawned | `useSwarm` and the `swarm` tool calls in the transcript |
| Tasks | Latest todo list, up to 12 items, with a live flag | The todo tool output in the transcript (`todosFromToolPart`) |
| Context | Context window, occupancy, provider and model | `GET /api/session/context`, refreshed when a turn ends, falling back to the `context` value in the last finish metadata |
| Connectors | Connector names used in this transcript, with call and failure counts | Transcript tool names, plus `/api/composio/connections` when Composio is configured |
| Outputs | Files the agent edited (path, verb, added and removed lines) and images it produced | Transcript tool parts and assistant images |

**Context figures.** The numbers come from the runtime, not from the model name.
`backend/src/runtime.rs` (`context_snapshot`) sends the runtime's `Info` command
and reads `context_window` from the provider's model metadata. Occupancy is the
last provider call's `input_tokens`. For Anthropic-style providers, cache reads
and writes are added. Other providers already include cached tokens in
`input_tokens`. The chat stream also copies the same snapshot into the finish
metadata (`backend/src/chat.rs`, `metadata["context"]`).

## Tool-call filter

Source: `src/components/workspace/tool-filter-menu.tsx`,
`src/lib/chat-ux/tool-categories.ts`.

Tool calls are bucketed into seven categories. The runtime's step kinds map onto
them, and connector tools are matched by name pattern (`mcp__`, `composio`,
Composio action slugs, and common app prefixes such as `gmail` and `slack`).

| Category | Covers |
| --- | --- |
| Terminal | Shell commands, git, background jobs |
| Files | Reads, searches and edits |
| Web | Search, fetch, browser, HTTP |
| Connectors | Gmail, Calendar, MCP and Composio tools |
| Agents | Swarm, subagents, delegated tasks |
| Planning | Todos, plans, memory |
| Other | Everything else |

The filter menu hides any category's rows from the work log. The header badge
shows how many categories are hidden. "Answers only" hides every tool call and
the work log. Prose and images remain. A tool call that needs the user's
confirmation stays visible, so nothing the user must act on disappears.

The choice persists in local storage under `amiro-chat-ux-v1`. See
[Persisted state](#persisted-state).

## Inline images

Sources: `src/lib/chat-ux/inline-images.ts`, `src/components/workspace/inline-images.tsx`,
`src/components/markdown.tsx`.

**Tool output.** `extractInlineImages` walks a tool result rather than matching
one schema. It recognises MCP image content, AI SDK media parts, `{url}` file
objects, image URLs and markdown images inside strings, and data URLs printed
after other output. It stops after 12 images or 6 levels of nesting. Images show
as a strip in the work log, and clicking one opens a lightbox (arrow keys step
through the images).

**Replies.** A model can print an image in its reply in two ways:

- A bare `data:image/...;base64,` line in prose is rewritten to image syntax
  (`linkifyDataImages`). Fenced code is left alone, and so is a block that is
  still streaming, so a half-written data URL does not flash a broken image.
- Markdown images render through `MarkdownImage` when the source is safe.

**Safety rules.** `isSafeImageSrc` admits only `http(s)` URLs and raster data
URLs (png, jpeg, gif, webp, avif). **SVG is blocked** in both places, because an
SVG data URL can carry script. The markdown renderer's URL transform keeps
data URLs only for image sources, so links and everything else still use the
library default.

Images from tool output are also listed in the session panel's Outputs card.

## Smooth streaming and reasoning

**Smooth text.** `src/hooks/use-smooth-text.ts` paces streamed text. Chunks
arrive about every 100 ms, so the hook reveals characters per animation frame.
A backlog drains in about 250 ms while streaming and about 150 ms after the stream
ends. The reveal never goes below about 120 characters per second, and it prefers
to stop on a word boundary within 6 characters. Surrogate pairs are never split.
Finished messages do no work, and reduced-motion users see the full text
immediately. Used for text parts in `src/components/message-parts.tsx`.

**Reasoning.** While the model thinks, the reasoning block shows a plain unboxed
"Thinking" label with a passing shine effect and streams light-colored reasoning
text inside a bounded-height scroll window (`max-h-36`) with no left border line.
Once thinking completes, the block automatically minimizes under the plain
"Thinking" label; clicking it toggles the reasoning window open or closed.

## Todo deltas

Source: `src/components/workspace/todo-views.tsx`, `src/lib/chat-ux/todos.ts`.

Each todo write shows what changed beneath the tool call. The glyphs match the
jcode TUI, so both surfaces read the same:

| Glyph | Meaning |
| --- | --- |
| `○` | Pending |
| `▶` | In progress |
| `✓` | Completed |
| `✗` | Cancelled |
| `⊳` | Blocked (amber) |
| `+` / `−` | Item added or removed |

A trivial change, such as one status flip, shows as one line. A substantive
change (the first write, an add, a removal, or several status changes) shows a
header and up to 6 item lines, then a "+N more" line for the rest.

## Swarm

A swarm is a coordinator session plus the sessions that report to it. The
runtime records each member's `parent_session_id`, `agent_label` and
`swarm_status`. The web UI reads those through the swarm routes below.

### Strip above the composer

Source: `src/components/workspace/swarm-strip.tsx`. It appears only when the
thread has members. It shows each member with an activity dot. Activity
collapses the runtime's lifecycle strings into working, waiting, done, failed
and idle (`swarmActivity`).

| Key | Action |
| --- | --- |
| Alt+N | Focus the strip and peek at the selected member (press again to leave) |
| Alt+Up or Alt+Left | Select the previous member (cycles) |
| Alt+Down or Alt+Right | Select the next member (cycles) |
| Alt+O | Open the selected member as a pane beside the chat |
| Esc | Leave the strip and return to the composer |

Keys are matched by physical key code (`e.code`), because Alt plus a letter
produces special characters on some Linux and Windows layouts. The strip only
claims the arrow and Alt+O keys while it is focused, so typing in the composer
is unaffected.

### Agent panes

Source: `src/components/workspace/agent-pane.tsx`, `src/components/workspace/agent-switcher.tsx`,
`src/app/store/chat-ux-store.ts`.

- Any number of agents can open beside the main chat. The chat keeps its place
  and each pane is a resizable column. With panes open, the chat column is sized
  to at least 34% of the row, and each pane has a minimum of 18%.
- The open panes persist per thread (`agentPanesByThread`), so a reload restores
  them.
- A pane reads its agent's transcript without creating a thread
  (`/api/swarm/transcript`). It polls every 2 s while the agent works and every
  10 s otherwise.
- Sending from a pane binds the agent to its own thread on the first send
  (`/api/swarm/open`), then streams like any chat.
- "Open as full chat" in the pane header navigates to the agent's thread. That
  thread shows a banner ("You're chatting directly with ...") with a
  **Back to coordinator** button. The banner notes that the coordinator is not
  told about direct messages.

Voice companions open panes the same way. See [LIVE-VOICE.md](LIVE-VOICE.md).

### Polling

`useSwarm` (`src/lib/backend/swarm-api.ts`) polls `/api/swarm/members` every 2.5 s
while anything is working or the strip is active, and every 15 s otherwise. The
runtime has no push channel for swarm state yet, so polling is the only update
path.

## Backend routes

Source: `backend/src/swarm.rs` (routes merged in `backend/src/main.rs`),
`backend/src/runtime.rs` (`list_sessions`, `context_snapshot`).

All routes require the owner's session and only read threads that belong to the
caller.

| Method and path | Purpose |
| --- | --- |
| `GET /api/swarm/members?thread=` | `{coordinator, members}`. Each member has `sessionId`, `parentSessionId`, `label`, `title`, `status`, `swarmStatus`, `userConnected`, `lastActiveAtMs`, `workingDir` and `threadId` (if a thread is already bound). A member thread shows the swarm of its coordinator. |
| `GET /api/swarm/transcript?thread=&session=` | `{sessionId, messages}` for the coordinator or a known member. Does not create a thread. Returns 404 for a session outside the caller's swarm. |
| `POST /api/swarm/open` `{sessionId, fromThreadId}` | Returns `{threadId}`, the thread bound to that member. The first call creates a thread entry with `swarmRootSessionId` and `swarmParentThreadId`. Returns 404 for a non-member. |
| `GET /api/session/context?thread=` | `{contextWindow, contextTokens, provider, model}` from the runtime. Nulls when the thread has no session yet. |

**Remembered members.** The runtime deletes a swarm's persisted snapshot once
the swarm has no state left (`remove_persisted_swarm_state_for` in
`runtime/crates/amiro-app-core/src/server.rs`). Without help, a finished swarm
would vanish from the panel, and its member threads would lose the way back to
the coordinator. So `swarm.rs` records each member it sees live under
`swarmMembers` on the coordinator's thread entry. On read, the live list and the
remembered list are merged. A remembered member is shown only if the runtime
still has its session.

## Persisted state

`src/app/store/chat-ux-store.ts` keeps presentation preferences out of the main
app store, so panel layout can change without a store migration. It persists to
local storage under `amiro-chat-ux-v1` with: `panelOpen`, `collapsedSections`,
`hiddenToolCategories`, `hideAllTools` and `agentPanesByThread`.

`targetAgentByThread` is defined in the store (the agent the composer would
address), but no component reads or writes it yet. Sending from a pane is the
only way to address a member today.

## Tests

| Command | Covers |
| --- | --- |
| `pnpm vitest run src/lib/chat-ux/chat-ux.test.ts` | Tool categories and connector naming, todo diffs, inline image extraction, data-URL linkifying and safe image sources |
| `pnpm vitest run src/components/markdown-images.test.tsx` | Bare data-URL paragraphs become images, streaming blocks stay raw, SVG data URLs are refused |
| `pnpm vitest run src/hooks/use-smooth-text.test.ts` | Reveal pacing, catch-up windows, word snapping, never overshooting, surrogate pairs |

Observed on 2026-10-18: `src/lib/chat-ux/chat-ux.test.ts` (12 tests),
`src/components/markdown-images.test.tsx` (3 tests) and
`src/hooks/use-smooth-text.test.ts` (9 tests) all passed. The Rust unit test
`descendants_walk_the_report_tree` in `backend/src/swarm.rs` covers the swarm
tree walk.

## Limitations

- Swarm state is polled, not pushed. Updates arrive within 2.5 to 15 s.
- Only the coordinator's own swarm is readable. The routes reject sessions
  outside it.
- Remembered members are only as complete as what the page saw live. A member
  that started and finished between polls may be missing.
- The Context card reflects the last finished call. A turn in flight shows the
  previous call's figures.
- The Connectors card lists only what the transcript used, plus Composio
  connections when Composio is configured.
- Images are capped at 12 per tool result and at 4,000,000 base64 characters
  per embedded data URL.
