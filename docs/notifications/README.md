# Notifications — Vellum parity

> Status: planned, not started. `phases/` is intent; `progress/` will be reality.

## Read in this order

| # | Document | What it settles |
|---|---|---|
| 00 | [Overview](00-overview.md) | Goals, surfaces, principles, non-goals |
| 01 | [Architecture](01-architecture.md) | Pipeline, modules, stores, SSE, Vellum divergences |
| 02 | [Decision engine](02-decision-engine.md) | LLM routing via the runtime bridge, fallback, budgets |
| 03 | [Channels](03-channels.md) | Local + Telegram/Slack/Discord adapters, pairing, secrets |
| 04 | [Bell UI](04-ui.md) | Inbox redesign, states, i18n, a11y, test ids |
| 05 | [Migration](05-migration.md) | Existing data, compat shims, rollout |
| — | [Phases](phases/README.md) | Dependency graph, phase table, per-phase rules |
| — | [Progress](progress/README.md) | Build record (empty until `implement` runs) |

## Phases

| Phase | Title | Size | Blocks |
|---|---|---|---|
| 00 | [Pipeline core](phases/phase-00-pipeline-core.md) | M | 01, 02, 03 |
| 01 | [LLM decision engine](phases/phase-01-decision-engine.md) | L | 03 |
| 02 | [Local delivery](phases/phase-02-local-delivery.md) | M | 04 |
| 03 | [External adapters](phases/phase-03-external-adapters.md) | L | 04 |
| 04 | [Bell inbox UI](phases/phase-04-bell-ui.md) | L | 05 |
| 05 | [Rollout](phases/phase-05-rollout.md) | S | — |

## Decisions already made

- **External channels in scope now.** Telegram, Slack, and Discord delivery
  adapters ship in this initiative (Phase 03), not later. Tokens live in the
  credential vault; chat bindings in the JSON store. (Owner answer, 2026-10-21.)
- **LLM routing like Vellum.** The decision engine calls a model through the
  runtime bridge and renders per-channel copy; deterministic rules are the
  fallback, not the engine. (Owner answer, 2026-10-21.)
- **Full Bell redo in scope.** The Bell becomes a Vellum-style inbox in this
  initiative (Phase 04), not a later follow-up. (Owner answer, 2026-10-21.)
- **Urgency keeps `normal`.** Vellum uses `medium`; Amiro persists `normal`.
  The API accepts `medium` as an alias mapped to `normal` (see
  [05-migration](05-migration.md)). Renaming stored data is rejected.
- **JSON store, not SQLite.** Vellum's audit trail is SQLite; Amiro persists
  JSON under `AMIRO_HOME/store` per backend standards. Three new files:
  `notification-events.json`, `notification-decisions.json`,
  `notification-deliveries.json`.
- **No mobile push.** Amiro ships no mobile apps, so there is no APNs/platform
  adapter. `remotePushDispatched` is accepted on inbound payloads and ignored.
- **No From-me chats, no preference learning.** Vellum's assistant-initiated
  threads and preference extractor are non-goals (see 00-overview).
