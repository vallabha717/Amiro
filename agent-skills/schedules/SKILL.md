---
name: schedules
description: Create, change, pause, run and troubleshoot the user's schedules — recurring briefings, reminders, reviews, checks — and read their run logs. Load it whenever the user asks for something to happen later or on a cadence ("every weekday at 8", "remind me Friday", "check this daily"), or asks how a schedule went or why it failed.
allowed-tools: mcp_call, mcp_search
metadata:
  emoji: "⏰"
  amiro:
    display-name: "Schedules"
    category: "productivity"
---

Schedules are shared with the user's **Schedules page**: anything you create here shows up there (marked "Created in chat"), and anything they create there you can see and change here.

They live behind the built-in `amiro` connector. Call them with `mcp_call`, server `"amiro"`:

```
mcp_call { server: "amiro", tool: "schedule_create", intent: "Create the morning briefing",
           arguments: { name: "Morning briefing", instructions: "...", cadence: { "weekdays": { "time": "08:00" } } } }
```

Tools: `schedule_list`, `schedule_create`, `schedule_update`, `schedule_delete`, `schedule_run_now`, `schedule_runs`. If you need the exact argument schema, `mcp_search` for "schedule".

Do **not** use the `schedule` / `schedule_ambient` tools for anything the user asked for — those are private wake-ups for your own current task and never appear on the Schedules page.

## Before creating

1. `schedule_list` first. If something similar exists, offer to change it instead of adding a duplicate.
2. Pin down **when** in the user's words, and confirm it back in plain English ("Weekdays at 8:00 AM, your time"). Use their timezone (USER.md) unless they say otherwise.
3. Write the **instructions** as a message to your future self: what to produce, from which sources, how long, what to skip if a connector is missing. Be specific — the run has no chat history.

## Pick the mode

- **agent** (default) — a full turn with tools and connectors in the workspace. Use it for anything that reads mail, calendar, files, the web, or updates NOW.md / the journal.
- **execute** — text only, no tools. Fine for "three focus lines from NOW.md".
- **notify** — posts the instructions verbatim. Use for plain reminders ("Stand up and stretch").

## Cadence

Pass one of: `{"daily":{"time":"08:00"}}`, `{"weekdays":{"time":"08:00"}}`, `{"weekly":{"day":"friday","time":"17:00"}}`, `{"monthly":{"day":1,"time":"09:00"}}`, `{"every_minutes":30}`, `{"once":{"at":"2026-10-20T15:00"}}`, or `{"cron":"0 8 * * 1-5"}` for anything else.

## After creating

Say it in one line: name, cadence, next run, and that it's on the Schedules page. Offer `schedule_run_now` once if they'd like to see a sample now.

## Logs and troubleshooting

When the user asks how a schedule went, or why it failed: call `schedule_runs` for it and read the actual output or error before answering. Quote the error briefly, explain it plainly, and fix what you can (`schedule_update` the instructions, mode, or cadence; suggest connecting a missing app via MCP Setup). Each run's full output is also in that schedule's conversation.

## Changing and removing

Use `schedule_update` to pause (`enabled: false`), resume, rename, or retime. Confirm before `schedule_delete` — it can't be undone.
