---
name: contacts-and-notifications
description: Keep the user's contacts, decide who may reach the agent on each channel, and send the user notifications in Amiro or on Telegram, Slack or Discord. Load it whenever the user asks to add, find or merge a contact, to let someone message the agent, to be notified or pinged about something, or why a notification did not arrive.
allowed-tools: mcp_call
metadata:
  emoji: "📇"
  amiro:
    display-name: "Contacts & Notifications"
    category: "messaging"
---

These tools are on the built-in `amiro` server: `mcp_call { server: "amiro", tool: "<name>", intent: "...", arguments: {...} }`.

## Contacts

- `contact_search` before adding anyone: by name, address or channel.
- `contact_create` with a name, and a channel address (email, Telegram, Slack, Discord, phone) and notes when known.
- `contact_merge` when two contacts are the same person: keeps one and folds the other's channels and notes into it. Say which one you kept.

A contact's address is verified on the Contacts page with a code. You cannot verify it for them.

## Who may reach the agent

`channel_readiness_get` shows each channel's connection health. `channel_policy_set` sets who the agent answers on a channel, from most to least strict: `no_one`, `guardian_only` (only the user), `trusted_contacts`, `any_contact`, `strangers`. Confirm before loosening it, and say plainly who can now reach the agent.

## Notifying the user

- `notify_send` with a short title and body. It goes to the Bell, desktop banners, web push and any verified outside channel. Use `urgency` honestly: `high` or `critical` only when it truly can't wait.
- Notify when something the user asked to hear about happens. Don't notify to report your own progress in a chat they are reading.
- Not arriving outside Amiro? `notify_channel_list` says what each channel is missing: the bot connected on the Channels page, or the user's own address added and verified on their contact card. `notify_channel_resend` sends a recorded notification again once that is fixed.
