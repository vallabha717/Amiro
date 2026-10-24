# Changelog

All notable changes to Amiro are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release status

The repository has no release tags yet, so nothing below has been released.
`package.json` and `src-tauri/tauri.conf.json` both currently declare version
`1.26.0`, and that version is still in development. When the first release is
tagged, the `Unreleased` heading will be renamed to that version with its date,
and subsequent work will accumulate under a fresh `Unreleased` section.

## [Unreleased]

### Added

- The TV screen (Monitor button in the chat header) streams the agent's real
  desktop from its sandbox container: Chromium, Files (Thunar) and a terminal
  in a Plank dock, all clickable. Frames go over one raw RFB tunnel
  (noVNC WebSocket → backend → supervisor `desktop/connect` upgrade → the
  container's VNC server) instead of base64 polling. Without a running sandbox
  the TV says so and offers Reconnect; the drawn stand-in desktop is gone.
  Agent containers now allow 1024 processes by default (was 256), since the
  desktop alone runs ~300 threads.
- The TV names the exact folder or address on screen: Files windows title
  themselves with the full path, the terminal with its working folder, and the
  TV header shows the window in front (full screen lists every window) from
  `GET /api/desktop/state`. Browser tabs are read from Chromium's DevTools on
  the container's loopback.
- Agents know their desktop: `desktop_open` / `desktop_state` (main agent, on
  the `amiro` server) and `agent_desktop_open` / `agent_desktop_state` (team
  agents with Shell on) open a URL, a folder in Files or a terminal in a
  folder, and report every window with its exact path or URL. Each call shows
  a live TV card in the chat with Open TV and Full screen.
- Amiro's desktop container mounts Amiro's real workspace
  (`AMIRO_SANDBOX_MAIN_WORKSPACE`, default `<AMIRO_HOME>/workspace`), so the
  TV shows the files Amiro works on. The terminal prompt reads like a shell on
  the owner's computer (`amiro@amiro-os:/home/you/.amiro/workspace$`), Files
  has a "<agent>'s workspace" bookmark, and the TV and chat card name each
  window as "<agent>'s Files/Terminal" with the folder's real path (both paths
  on hover).
- Admin → Debug's terminal and the terminal on the TV are one shared shell (a
  tmux session in the agent's container): what is typed in one shows in the
  other. Amiro's Debug terminal uses it whenever the sandbox is up and falls
  back to the host PTY otherwise.
- Fixed the agent desktop's D-Bus: the container's uid now has a name (via
  nss_wrapper), so Files settings and Chromium's bus calls work. The agent
  image adds CJK and emoji fonts.
- Connect phones and other desktop apps with a device code, the way the GitHub
  CLI signs in: the device enters the Amiro's address once and shows a short
  code, and the owner approves it at `/device` from any signed-in browser or in
  Settings → Devices. Each device gets its own sign-in, listed under Paired
  devices and removable at any time.
  - Optional phone access over Wi-Fi for the desktop app (a second listener,
    port 8790 by default, `AMIRO_REMOTE_PORT`) that only answers approved
    devices and never accepts a password sign-in.
  - The desktop app can connect to an Amiro on a server instead of its own and
    switch back to this computer without signing in again.
  - Web app manifest so a phone can add Amiro to its home screen.
  - English and Hindi strings, backend tests in `backend/tests/devices.rs` and
    the recorded `devices` E2E journey. See `docs/DEVICES.md`.

- Native Channels & Contacts integration ported from Vellum:
  - Channels readiness endpoints, multi-channel admission policies (trust floors: `no_one`, `guardian_only`, `trusted_contacts`, `any_contact`, `strangers`), conversation-tier Slack permissions, and secure vault storage for Slack, Telegram, Discord, and Phone (Twilio) credentials.
  - Contacts graph CRUD, search, channel linking, account verification and revocation, contact merging with donor cleanup, and A2A invite links.
  - Agent MCP tools for contact discovery and channel policy management (`contact_search`, `contact_create`, `contact_merge`, `channel_readiness_get`, `channel_policy_set`).
  - Modular UI architecture: `PageShell`, `ChannelAdapterList`, `ChannelPanel`, `SlackConnectionCard`, `ConnectedChannelHeader`, `ChannelTrustFloorSection`, `ContactsList`, `ContactDetailView`, `ContactChannelsSection`, and `ContactPermissionsSection`.
  - Full bilingual i18n support in English (`messages/en.json`) and Hindi (`messages/hi.json`).
  - Playwright E2E journey test in `07-agent-hub.spec.ts` and Rust integration tests in `backend/tests/channels_contacts.rs`.

- Native Rust backend, `backend/` (crate `amiro-backend`, axum). It owns
  application auth, the UI routes, thread to session mapping, and the runtime
  bridge lifecycle, and it serves the built frontend export itself.
- Vendored Amiro-owned Rust runtime under `runtime/`, built as
  `amiro-runtime`, together with its SDK crates. It is a source fork of an
  MIT-licensed upstream project pinned to an immutable commit, with provenance
  recorded in `THIRD-PARTY-NOTICES.md` and `docs/RUST-RUNTIME.md`.
- `bin/amiro`, a runtime CLI that delegates to the owned runtime build and
  reports which engine it is talking to rather than implying it bundles an
  engine it does not.
- Native schedules: scheduled runs stored and executed by the backend, with a
  Schedules entry in the app navigation.
- Full provider catalog for the admin add-provider flow, models resolved from
  connected providers, and a web folder picker for choosing a workspace.
- Search provider support covering all available search options, custom search
  providers, and endpoint and base URL rendering on the search provider card.
- Agent customization: customizable agent surfaces, a personality studio, and
  capability-aware Superpowers wired into the actual chat instructions.
- Sidebar and agent color synchronization, including coordinated theme palettes
  for light and dark modes.
- Character art for the agent avatar, including the OpenDots plush sprites in
  `public/agent/opendots/`, with attribution in `THIRD-PARTY-NOTICES.md`.
- Std-only Rust contract test harness in `tests/rust/` (`amiro-testkit`),
  replacing the retired Go test harness.
- Native build and acceptance entrypoints, including `scripts/build-native.sh`
  and the verification scripts driven by `pnpm verify:native-ui`,
  `pnpm verify:schedules-ui`, and `scripts/verify-agent-color-sync.mjs`.
- Chat file viewer. A file path in a reply (inline code, a link, or a path the
  agent's tools touched) is now a button that opens the file in the Files tab,
  using the same viewer as the Workspace page. It renders PDF (pdf.js), Word
  (`docx-preview`), PowerPoint (`@aiden0z/pptx-renderer`), Excel
  (`@js-preview/excel`), CSV, images, video and audio, with a text fallback if a
  renderer cannot draw a file and a download prompt for types with no reader.
  The Artifacts list opens files with the same viewer, and its "In this chat"
  section lists every file the conversation names so Back shows them all.
- Folded work rows. A finished run of thinking and tool calls collapses into one
  animated row such as "Thought, ran 4 commands, searched the web" that opens on
  click. A "Worked for" dock above the composer shows live progress and fades
  after the answer.

### Changed

- The launchers were first retargeted from the removed Go backend to a Node
  compatibility adapter, and then to the native Rust backend. The native backend
  is now the only thing that serves the product.
- `adapter/` was rebranded and is now an explicitly retired compatibility
  harness. It is not started by the backend, the Tauri shell, or any script, and
  it is kept in the tree only for contract tests and historical reference.
- The sidebar now presents the Agent rather than a list of skills.
- The agent workspace view is typed and the avatar controls are visible, so the
  customizer is navigable without guessing.
- The agent customizer scrolls, with a sticky footer and full theme labels.
- Removed the Amiro UI for permissions and tools the runtime does not have, so
  the interface no longer offers controls that cannot do anything.
- Documentation now records the interpretations that features had to assume,
  and the architecture note on rebuilding Amiro on the owned runtime.
- `tests/README.md` and several documents under `docs/` predate the native
  backend and the adapter retirement. They describe the Go era, or the adapter
  era, and are retained as design history.
- The chat follows streaming output to the bottom until the user scrolls up, and
  keeps the last line clear of the composer and dock. Spacing between a prompt,
  tool rows and the reply is tighter.
- The Tools filter menu is non-modal and applies as soon as a box is ticked. It
  now shows only the ticked categories (none ticked shows everything). The saved
  setting `hiddenToolCategories` is replaced by `onlyToolCategories`.

### Fixed

- Password changes now take effect without a stale write-back, and the admin
  add-provider menu lists every provider instead of a subset.
- Thread ownership fails closed, and thread and session ownership is recorded as
  acceptance evidence.
- Schedules honour saved models, and two schedule defects were fixed: a lifetime
  borrow error and ambiguous wall-clock time handling.
- The usage view no longer throws on an undefined period, and it is wired to
  real runtime usage data rather than placeholder numbers.
- The agent customizer opens on a same-route `?customize=1` navigation, the name
  field `maxLength` matches the server limit of 32, and persona is delivered on
  user turns without replacing the runtime's own context.
- The cobalt aura swatch saves, the agent routes are registered, and the hub no
  longer claims memory counts are still loading when they are not.
- Avatars stay visible, motion is calmer, and keyboard access to agent surfaces
  was improved. Sidebar color choices now persist to the agent identity.
- The adapter, while it was still in use, re-sent a message the daemon refused
  because the session was busy, kept follow-up turns working when the bridge
  withheld session tools, and stopped the injection defenses from discarding
  user-selected skill instructions.
- Reloaded and old chats show thinking as a reasoning block, not raw markup in
  the answer, and no longer show the runtime's internal "[auto]" bookkeeping
  messages. An empty chat request no longer starts a runtime turn.

### Security

- Hardened the agent routes: per-user identity, read-only native memory, an
  admin-gated workspace view, and strict validation of agent input.
- Strict image, category, legacy record, symlink, and workspace read-only
  hardening for agent surfaces.

### Removed

- Retired and removed the Go backend. There is no Go anywhere in the repository.
  Launchers, scripts, and tests were retargeted, and the Go test harness was
  replaced by Rust contract checks.
- Removed the user-authored Workflow feature completely.
- Removed the chat Workflow View, including its toggle.
- Removed manual agent runs, which native schedules replace.

## Prior development

The nine commits before the current work built the base application. Recorded
here so the history is not lost, without inventing release boundaries:

- Initial Amiro desktop application: Tauri shell, Next.js frontend, chat, and
  the first sign-in flow with its animated tree.
- Agent tooling, provider configuration, the admin UI, and a theme variant fix.
- Skill discovery, activation, authoring API, and TUI palettes.
- Sandboxed shell execution.
- The test system, the TUI, and dashboard serving.
- Coding agent parity work and the decommissioning of an earlier agent to skills
  mapping.
- An architecture note on rebuilding Amiro on the owned runtime.
