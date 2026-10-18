# Amiro Agent

The Agent section replaces the Skills sidebar entry. The sidebar heading uses the signed-in user's saved agent name. It no longer lists individual skills or offers a create-skill action: the section is the agent, its square habitat, and the four quick-jump pills (Personality, Superpowers, Memory, Workspace). Selecting a skill happens in the Superpowers surface and the composer's mention picker, not the sidebar. The habitat contains a decorative roaming avatar, playful cube, hover greeting and an explicit pause control. It is not a live activity indicator. Reduced-motion preferences stop decorative movement.

The Agent uses four OpenDots plush characters, vendored locally from CopilotKit/OpenDots with its MIT licence and attribution retained. Character tint and Agent interface accents follow the active sidebar theme, including light/dark changes. See `THIRD-PARTY-NOTICES.md` for provenance.

## Included

- **Agent hub** at `/agent`: central clickable avatar, editable display name, Personality, Superpowers, Memory and Workspace.
- **Customize**: four OpenDots plush characters, the existing sidebar theme choices, optional local image upload, name and tagline. Click the central avatar or the sidebar square. Saving a theme here changes the sidebar theme too. Changing the sidebar theme updates Agent colors immediately. Uploaded portraits retain their original colors.
- **Personality**: five bipolar style sliders and presets. The writing sample is illustrative, not a model-generated response or an audio preview. Sliders do not change permissions or grant autonomy.
- **Superpowers**: existing runtime, project and supported discovered skills, plus user-authored instruction sets. The old `/skills` URL remains compatible. "Add to message" attaches instruction text, not tool permissions. The server resolves selected names from the authenticated user's catalog. Unsupported or disabled skills are rejected, not silently substituted.
- **Memory**: admin-only, read-only inspection of the runtime's existing global and project memory graphs. The default is a searchable 24-entry list with Show more, detail on selection, and an optional map. There is no second memory engine. Category/tag visual links are presentation relationships, not newly written native memory associations.
- **Workspace**: an admin-only, read-only file browser with Runtime, Persona and Project roots. Technical root and file metadata are disclosed on demand. Credential files, session logs and arbitrary engine-state content are not exposed. Paths are allowlisted and checked after symlink resolution. Workspace is not a combined memory or skill management screen.

See [settings-ui.md](settings-ui.md) for the simplified surfaces, their actions and current production-browser verification.

Native schedules are delivered (see `docs/SCHEDULES.md`, `/schedules`). Manual background runs were removed. Contacts, Channels and Library are not part of this Agent implementation.

## Runtime behavior

Identity and personality settings are stored per authenticated user under `$AMIRO_HOME/store/agent-identity/`. User-authored skills are stored per user under `$AMIRO_HOME/store/skills/`. Ownerless legacy skill records are not automatically exposed to another user.

Chat retains the runtime's assembled system prompt and native memory context. Persona and selected skill instructions are delivered in `system_reminder` on the **same** `send_message` frame as each actual user message, including follow-ups and folder-rotated sessions. The adapter does not issue an empty auxiliary model turn and does not replace `systemPrompt`. The reminder is not persisted as visible user text in runtime history.

Follow-up turns depend on two bridge behaviours that were found by running the deployed preview rather than by reading code, and both are handled explicitly. The bridge negotiates capabilities per connection and withholds `session_tools` for several seconds after a turn connection closes, so `withIsolated` opens its connection only once the capability is advertised again (bounded ~9s schedule), while `withSession` reads such as history and rename deliberately do not wait. The daemon also refuses a message with `Session is busy` while it is still finishing the previous turn; that refusal arrives before `message_accepted`, so the adapter re-sends the same message (bounded 150/400/900/1800ms) instead of failing the turn. Neither retry can duplicate a message, and both are covered by adapter unit tests plus the live browser suites.

Up to eight selected skills are accepted. Each instruction body is bounded to 12 KB with an explicit truncation marker, and the combined reminder is bounded to 48 KB. Oversized combined selections are rejected with an explanation. A skill does not enable MCP servers or broaden the daemon's tool allowlist.

The tool-result continuation branch does not send a new persona reminder. Normal owner chat tools are now enabled by default, with `AMIRO_TOOL_PROFILE=none` as the opt-out. Skills supply instructions, not new permissions. The runtime executes with the owner's permissions, so a VM or sandbox must provide isolation. Earlier trusted-operator environment gating described by legacy adapter checks is no longer the native policy.

Runtime memory mutations through the Agent HTTP surface are intentionally unsupported (`501`), protecting the runtime's native serialization and its own writes. Use the runtime's own memory facilities to manage that data. Shared machine memory and workspace inspection require an administrator.

## Design provenance

The current plush character assets come from `CopilotKit/OpenDots`, with its MIT copyright and permission notice retained in `THIRD-PARTY-NOTICES.md`. The dot-lattice renderer has been replaced in the visible Agent avatar. Legacy saved body identifiers remain compatible, while the picker presents four distinct characters. The characters' existing faces are part of their artwork, so there is no separate eye-style control. The Agent interface combines these characters with an Amiro sidebar habitat and bento navigation. Brand display headings retain Fraunces, while Agent controls use Geist sans.

The sidebar theme and agent color stay synchronized in both directions. The customizer offers the named themes, and saving persists the selection to the agent identity and updates the sidebar. Selecting a theme in the sidebar user menu also commits the color choice to agent identity (`updateAgentIdentity`) before applying the style, so the choice survives reload. Midnight renders the mascot in black plush with preserved shading, glossy eyes, and highlights. Saved legacy trait colors remain compatible with the server API. Native runtime memory and personality instruction delivery are unchanged.

Decorative motion reads `prefers-reduced-motion` through `usePrefersReducedMotion`, which stays subscribed to the media query. framer-motion's own hook samples the query once at mount, so a user who turns the setting on while the page is open would otherwise keep seeing the habitat roam and blink.

## Validation commands

```sh
pnpm check-types
pnpm test
pnpm build
cargo test --manifest-path backend/Cargo.toml --test agent_native
node scripts/verify-settings-clarity.mjs
node scripts/verify-settings-workflows.mjs
# The following adapter checks are historical compatibility checks, not native deployment.
node --test adapter/test/*.test.mjs
node adapter/tests/agent-safety.mjs
node adapter/tests/integration.mjs
node scripts/verify-agent-color-sync.mjs
# Start/restart the adapter first and wait for GET /health to return 200.
AMIRO_TEST_URL=http://127.0.0.1:8788 node adapter/test/agent-browser.mjs
AMIRO_TEST_URL=http://127.0.0.1:8788 node adapter/test/opendots-theme-sync.mjs
AMIRO_TEST_URL=http://127.0.0.1:8788 node adapter/test/browser-smoke.mjs
```

The Agent acceptance script's two real model turns are route-pinned and configurable with `AMIRO_TEST_MODEL="provider:model"`; the default is `antigravity:gemini-3.8-flash-tiered` because the OpenCode Go key hit its usage limit while this was verified. A model the adapter cannot resolve aborts the turn instead of silently swapping providers.

Historical adapter-stage observations: 344 frontend unit tests and the listed adapter suites passed at that stage. These counts and adapter routes are not a current native release guarantee. On 2026-10-18, 646 frontend tests and typecheck passed, the production export built successfully, and the new settings acceptance scripts passed desktop/mobile routes plus real native credential, file, memory and skill boundaries.

The browser acceptance test temporarily changes the owner's Agent identity, creates a disposable skill and chat, and restores its state in `finally`. It checks persistence, real model delivery of the saved name and selected skill instructions, navigation, read-only native memory, workspace loading, mobile width, color themes, reduced motion and browser errors. Screenshots are written to `$AMIRO_SCRATCH_DIR` (the pre-rename `JCODE_SCRATCH_DIR` is still read) or the default scratch directory, not committed.

## Boundaries

The Agent copy is currently English. Existing application translations remain unchanged. Workspace browsing is not a general-purpose filesystem editor or a Vellum Library implementation. Amiro uses a shared owner/provider runtime and does not isolate untrusted tenants. Normal owner turns expose tools by default; schedule execution keeps tools disabled. Browser microphone and transport requirements depend on deployment, not on this guide's earlier adapter preview.
