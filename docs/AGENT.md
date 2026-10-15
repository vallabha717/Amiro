# Amiro Agent

The Agent section replaces the Skills sidebar entry. The sidebar heading uses the signed-in user's saved agent name. Its square habitat contains a decorative roaming avatar, playful cube, hover greeting and an explicit pause control. It is not a claim that a background job is running. Reduced-motion preferences stop decorative movement.

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

Up to eight selected skills are accepted. Each instruction body is bounded to 12 KB with an explicit truncation marker, and the combined reminder is bounded to 48 KB. Oversized combined selections are rejected with an explanation. A skill does not enable MCP servers or broaden the daemon's tool allowlist.

The tool-result continuation branch does not send a new persona reminder. Tool execution remains disabled on the public preview unless a trusted operator explicitly enables it with both existing environment controls. Style preferences and instruction-only skills still work with tools disabled.

Jcode memory mutations through the Agent HTTP surface are intentionally unsupported (`501`), protecting its native serialization and daemon-owned writes. Use the native Jcode memory facilities to manage that data. Shared machine memory and workspace inspection require an administrator.

## Design provenance

The Vellum avatar catalog is reused under MIT. See `THIRD-PARTY-NOTICES.md`. The Agent interface combines these characters with an Amiro sidebar habitat and bento navigation. Design work used the available frontend-design, better-colors and web-design-guidelines skills and reviewed Impeccable and Apple design-skill guidance. Brand display headings retain Fraunces, while Agent controls use Geist sans.

## Validation commands

```sh
pnpm check-types
pnpm test
pnpm build
node --test adapter/test/agent-context.test.mjs
node adapter/tests/agent-safety.mjs
node --test adapter/test/skills.test.mjs
# Start/restart the adapter first and wait for GET /health to return 200.
AMIRO_TEST_URL=http://127.0.0.1:8788 node adapter/test/agent-browser.mjs
```

The browser acceptance test temporarily changes the owner's Agent identity, creates a disposable skill and chat, and restores its state in `finally`. It checks persistence, real model delivery of the saved name and selected skill instructions, navigation, read-only native memory, workspace loading, mobile width, color themes, reduced motion and browser errors. Screenshots are written to `$JCODE_SCRATCH_DIR` or the default scratch directory, not committed.

## Boundaries

The new Agent copy is currently English. Existing application translations remain unchanged. Workspace browsing is not a general-purpose filesystem editor or a Vellum Library implementation. This preview continues to use its existing self-signed certificate, shared provider runtime and restricted tool profile.
