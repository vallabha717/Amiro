# Setup chat

First-run onboarding and **Team → New agent** share one setup flow, written as
a conversation. The agent streams one line per step and the user answers with
a card under it. This page records what it does and why it is built this way.

## The flow

| # | Step | Card | Saves to | Skippable |
| --- | --- | --- | --- | --- |
| — | Greet | "Let's go" | — | — |
| 1 | Look | Colour and shape (onboarding). Team mode adds name, role, instructions and brain (copy Amiro's API-key providers or start empty), and creates the agent here. | `PUT /api/agent/identity` / `POST /api/agents` | no |
| 2 | Default prompt | Tabs for `IDENTITY.md` and `SOUL.md` | — (reads `GET /api/agent/prompt`) | no |
| 3 | Personality | Presets and the five dials of the Personality page | `PUT /api/agent/personality` | yes |
| 4 | AI provider | The whole runtime catalog, grouped by mechanism, with search | — | yes |
| 4b | Connect | `LoginPanel` (the `/login` command's panel) for the chosen provider: API key, OAuth, device code, CLI or local endpoint | the provider routes | yes |
| 5 | Web search | The search catalog; keyless engines save at once | `POST /api/search/providers` + activate | yes |
| 5b | Search key | Password field | same | yes |
| 6 | Connectors | Composio key and app catalog (Amiro only), and "Add server" (the Connectors page dialog) | the connector routes | yes |
| 7 | Speaking voice | The TTS catalog; keyless voices save at once | `PUT /api/voice/settings` | yes |
| 7b | Voice key | Password field (and base URL when required), with "use it to listen too" when the provider also does STT | same | yes |
| 8 | Listening | The STT catalog, and whether live voice can run | same | yes |
| 8b | Listen key | Password field | same | yes |
| — | Done | What was set up and what is left for later; "Good to know" for onboarding | `POST /api/onboarding/complete` (onboarding) | — |

The script is `src/lib/onboarding/setup-flow.ts` (pure, unit tested). The chat
is `src/components/setup-chat/`: `setup-chat.tsx` runs the turns,
`streaming-text.tsx` types each line, and `cards/` holds one card per step.

The page is three columns on one seamless, accent-tinted surface, with no
dividing lines (`story-panel.tsx`):

- **Left, `AgentPanel`:** the agent itself, with the open chapter's icons
  orbiting it, its name, and the journey: each chapter as done (with what was
  chosen, e.g. "Teal · Starfish", "DuckDuckGo"), current, later or upcoming.
  It does not scroll.
- **Centre:** the chat, the only part that scrolls, fading at its edges.
- **Right, `StepPanel`:** the open step told as a chapter: The look, The soul,
  The character, The brain ("Choose a brain for your agent to think with"),
  The eyes, Superpowers ("Give your agent the superpowers it needs"), A voice
  of its own, Ears to hear you. A headline, a short explanation and three
  points. A follow-up turn (connect the provider) keeps its parent's chapter.

Below 1280px the left column folds into a small header; below 1024px the
right one becomes a one-line chapter strip. With reduced motion the orbit and
transitions stand still.

## Decisions

**The name stays Amiro during onboarding.** The default agent is the product's
main agent; onboarding picks only its look. It can still be renamed later on
the Agent page. A team agent is named in its look step.

**Scripted lines, streamed.** No model is connected during first-run setup, so
the agent's lines are written in the app (English and Hindi) and typed out by
`StreamingText`. It honours reduced motion, and the full line is the element's
accessible name so screen readers hear it once. The UI never claims the lines
come from a model.

**Cards reuse the real settings components and routes.** The provider connect
step is `LoginPanel`, the add-server dialog is the Connectors page's
`ConnectorDialog`, Composio is `ComposioAppsSection`, and the personality
presets are exported from the Personality page. A setting made in the chat is
the same setting the pages show; nothing is stored twice.

**Secrets never become chat.** Every key is a `type="password"` field whose
value lives only in the card's state, goes straight to the backend vault, and
is cleared once saved. Replies in the chat say "Key saved", never the key.

**Team mode acts in the new agent's scope.** The agent is created at the look
step, then `setAgentScope(id)` makes every later request carry
`X-Amiro-Agent`, so its prompt, personality, provider, search and connectors
are its own (see [../multi-agent-team/03-per-agent-config.md](../multi-agent-team/03-per-agent-config.md)).
The scope is cleared when the chat finishes or unmounts. Two exceptions,
stated in the chat: Composio is configured for Amiro only, so a team agent's
connectors step offers remote MCP servers; and voice settings are shared by the
whole instance.

**The default prompt is read from disk, not rebuilt.** `GET /api/agent/prompt`
returns `IDENTITY.md` and `SOUL.md` from the agent's home with the `_ ` note
lines stripped, which is what the runtime puts in the prompt. For a fresh
owner it writes the files first (`ensure_owner_identity_file` + seed).

**Speaking and listening are separate steps, and live voice is spelled out.**
Read-aloud uses the TTS engine and dictation the STT engine, so each gets its
own step. Live voice (a hands-free conversation) is a different path: it runs
only on ElevenLabs (`backend/src/routes/live_voice.rs`, Scribe STT and
streaming TTS) with an ElevenLabs key saved for either direction. The browser's
own voices cover read-aloud and dictation, not live voice. Both voice cards and
the summary say whether live voice is ready, and ElevenLabs carries a "Live
voice" badge. Keys are saved per direction, so the speaking key step offers to
use the same provider and key for listening.

**The connect step shows only the chosen provider.** `LoginPanel` takes
`lockProvider`, which hides its search box and provider picker; the chat has
already chosen, and "Pick another" goes back to the full list.

**Engines that need more than a key stay in Admin.** SearXNG needs a server
address and custom HTTP search needs the full editor, so the chat leaves them
to **Admin → Search**.

## Tests

- Unit: `src/lib/onboarding/setup-flow.test.ts` (order, follow-ups, skips,
  progress) and `src/components/setup-chat/setup-chat.test.tsx` (streaming
  states, secret field, summary).
- Backend: `agent_prompt_shows_identity_and_soul_without_notes` in
  `backend/tests/agents.rs` (auth, owner only, notes stripped, team scope).
- E2E: journey 1 (`01-onboarding.spec.ts`) walks every step for Amiro; journey
  12 (`12-team.spec.ts`) creates Scout through the chat and checks its prompt,
  personality and search are its own.

## Later

- Composio per team agent, then offer it in team mode.
- Fresh README screenshots and GIF of the chat (`scripts/capture-readme-media.mjs`).
