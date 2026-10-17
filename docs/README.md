# Amiro Documentation Index

This directory contains the architecture, implementation guides, and specifications
for the Amiro project.

Amiro is an open-source AI desktop application combining:
- A **Tauri 2 (Rust)** desktop shell (`src-tauri/`)
- A **statically-exported Next.js** frontend (`src/`)
- A **native Rust backend** (`backend/`, binary `amiro-backend`, axum)
- A **vendored Rust runtime** workspace (`runtime/`, binary `amiro-runtime`)

The legacy Go backend was completely removed. The Node adapter in `adapter/` is a
retired compatibility harness kept only for contract tests.

## Living Documentation

| Document | Description |
|---|---|
| [AMIRO-RUNTIME.md](AMIRO-RUNTIME.md) | **Primary source of truth.** Architecture, native backend and runtime bridges, authentication, provider and model catalogs, tools policy, folder browsing, security restrictions, and local execution. |
| [RUST-RUNTIME.md](RUST-RUNTIME.md) | Details on the vendored `runtime/` workspace: building, crate breakdown, rebrand mappings, fork policy gates (telemetry and auto-update default-deny). |
| [SCHEDULES.md](SCHEDULES.md) | Native scheduler documentation: once, cron, and interval timing, DST spring-forward and fall-back timezone validation, singleton OS advisory locking, and per-session saved model binding. |
| [AGENT.md](AGENT.md) | Amiro Agent documentation: `/agent` hub, OpenDots plush mascots, sidebar habitat, customizer, two-way theme color synchronization, read-only memory, and allowlisted workspace. |
| [_agent-visual-brief.md](_agent-visual-brief.md) | Visual design research, character references, and the decision record implementing OpenDots plush mascots. |
| [_adapter-contract.md](_adapter-contract.md) | Specification for the retired Node compatibility harness (`adapter/`), used for running contract tests. |

## Feature and System Guides

- **Skills:** [docs/skills/](skills/README.md)
  - [00: Overview](skills/00-overview.md): Scope, principles, and non-goals.
  - [01: Discovery & Precedence](skills/01-discovery-and-precedence.md): Scan roots, ordering, deduplication, and bounds.
  - [02: Activation](skills/02-activation.md): Three-tier disclosure, activation tool, and prompt integration.
  - [03: Authoring & Safety](skills/03-authoring-and-safety.md): Authoring API, validation rules, AI drafting, and security.
  - [04: The Surfaces](skills/04-surfaces.md): Integration across web composer palette, Agent Superpowers, and desktop.
  - [Reference: Agent Skills Standard](skills/reference/agent-skills-standard.md): Specification reference for `SKILL.md`.

- **Testing:** [docs/testing/](testing/README.md)
  - [00: Overview](testing/00-overview.md): Testing philosophy and active test surfaces.
  - [01: Architecture](testing/01-architecture.md): Test harness structure and execution lifecycle.
  - [Reference: `tests/` Tree](testing/reference/tests-tree.md): Layout of the current `tests/` and `backend/tests/` suites.

- **Runtime Engine (vendored `runtime/`):**
  - [runtime/README.md](../runtime/README.md): Runtime overview and capabilities.
  - [runtime/PROVENANCE.md](../runtime/PROVENANCE.md): Upstream provenance, vendored commit, and MIT license record.
  - [runtime/OAUTH.md](../runtime/OAUTH.md): Authentication notes for OAuth and API-key providers.
  - [runtime/TELEMETRY.md](../runtime/TELEMETRY.md): Telemetry architecture and fork policy opt-in notice.
  - [runtime/CONTRIBUTING.md](../runtime/CONTRIBUTING.md): Runtime contribution and environment notes.

## Historical Design Records

These documents record earlier phases and design proposals, preserved for historical reference:
- [amiro-on-jcode.md](amiro-on-jcode.md): Earlier architecture proposal for rebuilding Amiro on top of a runtime daemon.
- [docs/tui/](tui/): Historical records from the earlier Go backend and Bubble Tea TUI implementation.
