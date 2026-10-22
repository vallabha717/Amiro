# 00 — Overview

Rebuild Amiro notifications on Vellum's architecture and make the Bell feel
like Vellum's inbox. Today Amiro has a direct-emit backend (one item, one
copy, local surfaces only) and a clumsy Bell popover. Afterwards it will have
Vellum's pipeline — signal → decision → broadcast → channel adapters → audit —
with LLM routing, Telegram/Slack/Discord delivery, and a Bell inbox worth
opening.

## Goals

- Every notification enters as a **signal** with source channel, event name,
  attention hints, and dedupe key — never as pre-rendered copy.
- A **decision engine** picks channels and renders per-channel copy via a
  model call, with a deterministic fallback when the runtime is unreachable.
- A **broadcaster** fans out to channel adapters and writes a per-channel
  **audit trail** (events, decisions, deliveries).
- Local delivery stays instant: Bell feed, SSE, Tauri desktop banner, web
  push, in-app toast — with quiet hours, presence suppression, and acks.
- External delivery reaches Telegram, Slack, and Discord DMs/chats with
  conversation pairing (replies stay in one thread per source).
- The Bell becomes an inbox: filterable feed, detail view, read/dismiss,
  settings, deep links — in English and Hindi, light and dark.

## Surfaces in scope

- **Backend** (`backend/`): new `notify` domain, extended
  `routes/notifications.rs`, agent tool `notify_send`, vault-backed tokens.
- **Web UI** (`src/`): Bell inbox, notification settings, service worker,
  `lib/notifications/` runtime.
- **Desktop** (Tauri): existing `desktop_show_notification` bridge; no shell
  changes expected beyond payload fields.

## Principles

- Additive by default. Existing routes keep working; existing feed data keeps
  rendering. Breaking changes are listed in [05-migration](05-migration.md).
- Every phase is independently shippable and carries its own tests on every
  surface it touches (backend integration, Vitest, Playwright journey steps).
- No UI for capabilities that do not exist; disabled states explain why.
- Secrets never travel through chat, logs, or responses — vault only.

## Non-goals

- Mobile push / APNs / platform adapter (no mobile apps).
- Email channel (Vellum's draft-first mailbox workflow is out of scope).
- From-me / assistant-initiated threads.
- Notification-preference learning from conversation text.
- Voice announcements of notifications.
- Terminal UI surface (no TUI client for notifications).
