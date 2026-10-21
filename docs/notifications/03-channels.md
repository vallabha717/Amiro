# 03 — Channels

## Channel set

| Channel | Adapter | Destination | Binding stored in |
|---|---|---|---|
| local (vellum-equivalent) | `adapters/local.rs` | connected SSE clients | sessions (existing) |
| telegram | `adapters/telegram.rs` | bot → user chat | `notification-channels.json` |
| slack | `adapters/slack.rs` | bot DM / channel | `notification-channels.json` |
| discord | `adapters/discord.rs` | bot DM | `notification-channels.json` |

No platform/APNs adapter (non-goal). No inbound handling: adapters only
send; replying happens in Amiro, not in Telegram/Slack/Discord.

## Secrets and setup

Bot tokens (Telegram BotFather token, Slack bot token, Discord bot token)
live in the credential vault (`credentials.rs`, `AMIRO_CRED_*`), never in
the JSON store, logs, or responses. A `notification channel connect` flow per
channel collects the token through the secure secret card and a chat id
through normal UI, then verifies with a `chat.getMe`-style call before
saving the binding. Status surfaces show metadata only (bound chat name,
updatedAt).

## Conversation pairing

External messages pair like Vellum: one thread per notification source per
channel. The adapter keeps `(channel, sourceContextId) → external thread id`
in `notification-channels.json` (Telegram: chat id + thread; Slack: channel
+ thread_ts; Discord: channel id). Follow-ups reuse the thread; a missing
thread is recreated and the binding updated. Approval cards render as
channel-native buttons where supported, else as text with a deep link back
to Amiro.

## Failure semantics

Per-channel delivery rows record `pending/sent/failed/skipped` with error
text. One channel failing never blocks the others; the local channel is
attempted even when all externals fail. Retries are manual (resend action in
the Bell), never automatic loops.
