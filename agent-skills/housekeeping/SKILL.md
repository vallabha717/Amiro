---
name: housekeeping
description: Clean up old chats, schedule run logs and log files, now or every day. Load it whenever the user asks to delete, clear, purge or tidy old or inactive chats, conversations, threads, run history or logs ("delete chats older than 2 days", "clean up logs every night", "remove conversations nobody touched this week").
allowed-tools: mcp_call
metadata:
  emoji: "🧹"
  amiro:
    display-name: "Housekeeping"
    category: "system"
---

Amiro has a built-in **Cleanup** task for this (Schedules page → Activity → System tasks → Cleanup). It runs daily without the model, so it costs nothing and takes a second. **Never** write a script, read Amiro's files or source, or create an agent schedule for this: the tools below do it safely, and editing `threads.json` or other store files directly corrupts them.

All tools are on the built-in `amiro` server: `mcp_call { server: "amiro", tool: "<name>", intent: "...", arguments: {...} }`.

| Tool | Use |
| --- | --- |
| `housekeeping_status` | Is it on, its age, time and scope, last run, next run |
| `housekeeping_configure` | Set it up or change it: `enabled`, `older_than_days` or `older_than_hours`, `time` ("HH:MM", owner's timezone), `chats`, `archived`, `schedule_runs`, `log_files` |
| `housekeeping_run` | Clean now. `dry_run` defaults to **true** (a preview); other fields override the saved settings for this run only |

What each scope covers:
- `chats`: chats nobody has written in for the age, including heartbeat and schedule-run chats. Agent channels and chats with a reply still running are always kept.
- `archived`: archived chats too. Off by default.
- `schedule_runs`: the run history on the Schedules page. Schedules themselves are never deleted.
- `log_files`: old `.log` files from Amiro, its runtime and `workspace/data/logs`.

## "Do it every day" (the usual request)

1. Read the age, time and scope from their words. Defaults: 2 days, 03:00, chats + run logs + log files, archived off. Ask only if something they said is ambiguous.
2. `housekeeping_configure` with `enabled: true` and those values. One call.
3. Reply in one or two lines with the summary it returns, and that it is on the Schedules page under Activity → System tasks. Offer a preview of what the next run would delete.

## "Delete them now"

1. `housekeeping_run` with the age and scope (dry run). Tell the user the counts and a few chat titles.
2. Only after they confirm, `housekeeping_run` again with the same fields and `dry_run: false`. Report what was deleted.

If they asked for both, configure first, then offer the preview and run now.
