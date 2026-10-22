# 03 — Channels

Delivery outside Amiro follows Vellum's architecture: **Channels** own the
transport, **Contacts** own the recipient, and notifications own neither.

## Channel set

| Channel | Adapter | Bot (set up in Channels) | Recipient (from Contacts) |
|---|---|---|---|
| local (vellum-equivalent) | `adapters/local.rs` | none | connected SSE clients |
| telegram | `adapters/telegram.rs` | vault `telegram/bot_token` | guardian's Telegram record: `externalChatId`, else the user id in `address` |
| slack | `adapters/slack.rs` | vault `slack_channel/bot_token` | guardian's Slack DM (`D…`), or their user id (`U…`/`W…`), which opens a DM |
| discord | `adapters/discord.rs` | vault `discord_channel/bot_token` | guardian's Discord user id (DM opened by the bot) |

`notify/destinations.rs` is the port of Vellum's `destination-resolver.ts`.
A channel is deliverable only when its bot is connected **and** the guardian
contact has a verified record of that type. Slack never delivers into a
shared `C…`/`G…` channel, as in Vellum. Only the guardian (the owner)
receives external notifications; anyone else's stay in the app.

No platform/APNs adapter (non-goal). No inbound handling: adapters only
send; replying happens in Amiro.

## Setup, in the owner's words

1. **Channels → Telegram** (or Slack, Discord): paste the bot token. It is
   checked with the provider (`getMe`, `auth.test`, `users/@me`) before it
   is saved, and the bot's name is the one the provider reports. A rejected
   token is refused and nothing is stored.
2. **Contacts → You → Linked accounts**: add your own account on that app.
3. **Verify me**: Amiro sends a six-digit code to that account with the
   bot. Typing it back marks the record verified (`verifiedVia: "code"`).
   Codes last ten minutes and allow five tries. A client can never set a
   record verified directly: new records are always unverified, and PATCH
   only revokes, blocks or resets.
4. **Admin → Notifications → Outside Amiro** shows each channel's state and
   links to the page that fixes what is missing.

Tokens live in the credential vault only, never in JSON stores, logs or
responses. Contacts are owner-only.

## What goes outside the app

`decision::external_channels` applies Vellum's routing:

- a model decision goes to the channels the model chose, among the ready ones;
- otherwise (fallback, pass-through) the inbox only, except a test
  notification, a high or critical signal that needs action, or an urgent
  one the agent sent itself, which go to every ready channel;
- chat replies never leave the app; a decision not to notify reaches nothing.

## Conversation pairing

One external thread per source per destination, like Vellum:
`notification-threads.json` maps `(user, channel, endpoint, sourceContextId)`
to the Slack `thread_ts` or Discord DM channel. A changed address starts a
fresh thread.

## Failure semantics

Per-channel delivery rows record `sent/failed` with error text. One channel
failing never blocks the others; the local channel is attempted even when all
externals fail. Retries are manual (resend in the Bell detail).
