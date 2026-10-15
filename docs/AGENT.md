# Amiro Agent

The Agent section replaces the Skills sidebar entry. The sidebar heading uses the signed-in user's saved agent name. It no longer lists individual skills or offers a create-skill action: the section is the agent, its square habitat, and the four quick-jump pills (Personality, Superpowers, Memory, Workspace). Selecting a skill happens in the Superpowers surface and the composer's mention picker, not the sidebar. The habitat contains a decorative roaming avatar, playful cube, hover greeting and an explicit pause control. It is not a claim that a background job is running. Reduced-motion preferences stop decorative movement.

The character art is original to this repository: dot-lattice bodies and gaze marks composed in code, not the Vellum catalogue that earlier revisions ported. See `THIRD-PARTY-NOTICES.md` for the current attributions.

## Included

- **Agent hub** at `/agent`: central clickable avatar, editable display name, Personality, Superpowers, Memory and Workspace.
- **Customize**: six character forms, nine eye styles, eight colors, optional local image upload, name and tagline. Click the central avatar or the sidebar square. The sidebar uses the same saved appearance and name after a reload.
- **Personality**: five bipolar style sliders and presets. The writing sample is illustrative, not a model-generated response or an audio preview. Sliders do not change permissions or grant autonomy.
- **Superpowers**: existing Jcode, project and supported discovered skills, plus user-authored instruction sets. The old `/skills` URL remains compatible. "Add to message" attaches instruction text, not tool permissions. The server resolves selected names from the authenticated user's catalog. Unsupported or disabled skills are rejected, not silently substituted.
- **Memory**: an admin-only, read-only inspection of Jcode's existing native global and project memory graphs, with search and constellation/card/list views. There is no second memory engine. Category/tag visual links are presentation relationships, not newly written native memory associations.
- **Workspace**: an admin-only, allowlisted file browser for Jcode memory/skills, Amiro persona mirrors and repository documentation. Credential files, session logs and arbitrary Jcode-home content are not exposed. Paths are checked after symlink resolution.

Schedules are deferred. Contacts, Channels and Library are not part of this Agent implementation.

## Runtime behavior

Identity and personality settings are stored per authenticated user under `$AMIRO_HOME/store/agent-identity/`. User-authored skills are stored per user under `$AMIRO_HOME/store/skills/`. Ownerless legacy skill records are not automatically exposed to another user.

Chat retains Jcode's assembled system prompt and native memory context. Persona and selected skill instructions are delivered in `system_reminder` on the **same** `send_message` frame as each actual user message, including follow-ups and folder-rotated sessions. The adapter does not issue an empty auxiliary model turn and does not replace `systemPrompt`. The reminder is not persisted as visible user text in Jcode history.

Follow-up turns depend on two bridge behaviours that were found by running the deployed preview rather than by reading code, and both are handled explicitly. The bridge negotiates capabilities per connection and withholds `session_tools` for several seconds after a turn connection closes, so `withIsolated` opens its connection only once the capability is advertised again (bounded ~9s schedule), while `withSession` reads such as history and rename deliberately do not wait. The daemon also refuses a message with `Session is busy` while it is still finishing the previous turn; that refusal arrives before `message_accepted`, so the adapter re-sends the same message (bounded 150/400/900/1800ms) instead of failing the turn. Neither retry can duplicate a message, and both are covered by adapter unit tests plus the live browser suites.

Up to eight selected skills are accepted. Each instruction body is bounded to 12 KB with an explicit truncation marker, and the combined reminder is bounded to 48 KB. Oversized combined selections are rejected with an explanation. A skill does not enable MCP servers or broaden the daemon's tool allowlist.

The tool-result continuation branch does not send a new persona reminder. Tool execution remains disabled on the public preview unless a trusted operator explicitly enables it with both existing environment controls. Style preferences and instruction-only skills still work with tools disabled.

Jcode memory mutations through the Agent HTTP surface are intentionally unsupported (`501`), protecting its native serialization and daemon-owned writes. Use the native Jcode memory facilities to manage that data. Shared machine memory and workspace inspection require an administrator.

## Design provenance

The Agent character art is generated in code and original to this repository. See `THIRD-PARTY-NOTICES.md`. Each body is a radial field traced into a single silhouette path and reused to place a dot lattice; the dots are drawn in the character's own hue, the silhouette is a tint of it with a rim, and the face has a keep-out zone so gaze marks stay readable from 22px to 236px. Gaze styles are generated marks (dots, rings, stroked arcs). The Agent interface combines those characters with an Amiro sidebar habitat and bento navigation. Design work used the available frontend-design, better-colors and web-design-guidelines skills, reviewed Impeccable and Apple design-skill guidance, and used `docs/_agent-visual-brief.md` for reference study of the dot-matrix agent idiom and its licences. Brand display headings retain Fraunces, while Agent controls use Geist sans.

Decorative motion reads `prefers-reduced-motion` through `usePrefersReducedMotion`, which stays subscribed to the media query. framer-motion's own hook samples the query once at mount, so a user who turns the setting on while the page is open would otherwise keep seeing the habitat roam and blink.

## Validation commands

```sh
pnpm check-types
pnpm test
pnpm build
node --test adapter/test/*.test.mjs
node adapter/tests/agent-safety.mjs
node adapter/tests/integration.mjs
# Start/restart the adapter first and wait for GET /health to return 200.
AMIRO_TEST_URL=http://127.0.0.1:8788 node adapter/test/agent-browser.mjs
AMIRO_TEST_URL=http://127.0.0.1:8788 node adapter/test/browser-smoke.mjs
```

The Agent acceptance script's two real model turns are route-pinned and configurable with `AMIRO_TEST_MODEL="provider:model"`; the default is `antigravity:gemini-3.8-flash-tiered` because the OpenCode Go key hit its usage limit while this was verified. A model the adapter cannot resolve aborts the turn instead of silently swapping providers.

Observed on this tree: `pnpm check-types` clean, 332 unit tests passed, `adapter/test/*.test.mjs` 37 passed, adapter/tests/agent-safety.mjs all assertions passed, route-boundaries 125 registered routes observed, and both live browser suites passed against the deployed export.

The browser acceptance test temporarily changes the owner's Agent identity, creates a disposable skill and chat, and restores its state in `finally`. It checks persistence, real model delivery of the saved name and selected skill instructions, navigation, read-only native memory, workspace loading, mobile width, color themes, reduced motion and browser errors. Screenshots are written to `$JCODE_SCRATCH_DIR` or the default scratch directory, not committed.

## Boundaries

The new Agent copy is currently English. Existing application translations remain unchanged. Workspace browsing is not a general-purpose filesystem editor or a Vellum Library implementation. This preview continues to use its existing self-signed certificate, shared provider runtime and restricted tool profile.
