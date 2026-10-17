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
