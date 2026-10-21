# Phase 03 — External adapters

> **Shipped 2026-10-21 with gaps (3/4 MET).** See [progress/phase-03-external-adapters.md](../progress/phase-03-external-adapters.md)
> for what was built, what diverged, and the verification log.

**Depends on:** 00 (01 for rendered copy; works on fallback copy without it)
· **Blocks:** 04 · **Size:** L

**Surfaces touched:** backend, web (channel connect UI)

This phase will deliver notifications to Telegram, Slack, and Discord
through vault-backed bot tokens, with per-user channel bindings and
per-source thread pairing.

## What already exists

Phase 00's `ChannelAdapter` trait + local adapter; vault
(`backend/src/credentials.rs`); Phase 01's per-channel copy (or fallback
copy when the model path is down). No messaging-channel code exists today
— this is greenfield behind a new API surface.

## Deliverables

### 1. Adapters

- `notify/adapters/telegram.rs` (Bot API `sendMessage`), `slack.rs`
  (`conversations.open` + `chat.postMessage`), `discord.rs` (DM channel +
  message create): direct HTTPS, timeouts, error text into the delivery row.
- `notify/adapters/pairing.rs`: `(channel, sourceContextId) → thread`
  bindings in `store/notification-channels.json`.
- Routes: list/bind/unbind channel, verify-on-bind (a `getMe`-style call),
  resend-to-channel for a delivery. Metadata only in responses.

### 2. Connect UI + agent tool

- Channel connect cards (token via secure secret card, chat id via normal
  input) in the notifications settings area; `notify_channel_*` agent
  tools calling the same functions as the routes.

### 3. Test coverage

| Surface | Location | Covers |
|---|---|---|
| backend | `backend/tests/notify_channels.rs` | bind/verify/unbind with stub HTTP; 401/400; token never appears in any response body |
| backend | pairing unit tests | thread reuse, missing-thread recreation |
| e2e | notifications journey steps | connect with dummy token → binding row; send test → failed/skipped row recorded, no exception (live send guarded by `need()`) |

**Deliberately not covered:** live delivery to real Telegram/Slack/Discord
(no bot tokens in CI); inbound replies (non-goal).

## Exit criteria

1. `cargo test --manifest-path backend/Cargo.toml` passes with stub HTTP.
2. A test asserts a vault-stored token appears in no response, log, or
   persisted JSON (grep the temp home).
3. `pnpm check-types && pnpm lint && pnpm test` passes for the connect UI.
4. E2E connect flow passes with fixtures; live-send step skips with reason
   when unconfigured.

## Risks

- **Token handling.** Mitigation: vault-only storage, metadata-only
  responses, and the no-secret-in-response test above.
- **Channel API drift.** Mitigation: thin per-adapter send functions with
  stubbed tests, so drift shows as a bounded adapter fix.
