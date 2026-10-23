# Schedules

Schedules run a saved prompt or script on a timer. Each schedule belongs to one
user, fires in its own timezone, and records every firing in run history you can
inspect. There are four modes: `notify` posts the result as a visible thread
message with no model call, `execute` runs a model turn with tools forced off
and the model pinned server side, `agent` runs a full agent turn with tools on,
and `script` runs a shell command directly in the agent workspace without an
LLM call. In `execute` and `agent` modes, every run's conversation records the
schedule prompt as the `user` message followed by the `assistant` response and
links the live runtime session so tool steps, reasoning, and follow-up turns
work identically to Vellum. Recurring schedules also support
`reuseConversation: true` to continue the previous run's conversation and
`quiet: true` to suppress automatic completion notifications on clean runs.

## User guide

Create a schedule from the Schedules page: give it a name, write the prompt,
pick `notify` or `execute`, choose once, cron, or interval timing, and set
the timezone the wall time belongs to. Use Preview before saving. A once
preview returns exactly ONE time. A cron or interval preview returns exactly
5 upcoming runs in ascending order, so you can confirm the cadence.

The browser sends the wall time you typed plus the selected timezone, and
the backend owns the conversion to UTC. For example 09:00 in Asia/Kolkata is
stored as 03:30Z. A wall time that never exists, such as 02:30 on the spring
forward day in America/New_York, is rejected with a 400 error instead of
being silently shifted. A wall time that happens twice on the fall back day
is ambiguous and is also rejected with 400. Pass an explicit offset such as
2029-11-04T01:30:00-04:00 to pick one instant.

Pausing a schedule stops all timer firings. Run now still works while paused
because it is an explicit action, and it appends to run history like any
other firing. Running a once schedule manually consumes it, so the timer
can never fire it a second time. Deleting a schedule while a run is in
flight is rejected with 409. A successful delete removes the schedule row
with 204 and keeps the run history file, so past firings stay on disk even
though GET runs for the deleted id answers 404.

`execute` runs have no tools and send no external notifications. There is no
email, no push, and no inbox access. The default prompt should describe a
self contained task such as "Write three focus lines for today", not
"Summarize inbox", which would imply mailbox tools the runner does not have.
`agent` mode is the opposite: each firing starts a fresh runtime session with
the same tool exposure chats get and the agent workspace as working directory,
so the agent-home files (IDENTITY, SOUL, USER, NOW) load and the agent can use
Connectors/MCP and file tools. It shares the pinned model, 15 minute timeout,
cancel, run history, result thread, and 8,000/2,000 character retention with
`execute`. If any runtime session is busy (a live chat), the firing is not run:
the run is recorded with status `skipped` and a reason, and the next run stays
scheduled. Write agent prompts as self contained tasks; the agent acts with the
owner's connectors, so keep them specific.

Failures are visible in the schedule detail run history with the error text,
and the next firing still happens on schedule.

## Daemon behavior

One backend process holds the schedule lock through an OS advisory file
lock (`std::fs::File::try_lock` semantics) acquired after the listener
binds, so a process that cannot serve never ticks. A second process sharing
the same home sees the lock as held and must reject schedule mutations
instead of double executing. The lock covers the timer tick claim and
run now. Preview is read only and needs no lock.

On startup the holder recovers: a still pending overdue once fires exactly
once, a previously running run is marked interrupted with no replay of side
effects, and recurring schedules resolve forward with no replay storms.
`AppState.store` is an in process mutex only and is not the cross process
safety mechanism. The OS advisory lock is.

Execute and agent modes pin the model server side, (execute) forces tools off through the
`runtime::configure_tools` path with no CLI bypass, and runs under a turn
timeout with cancel. The saved model is applied to each runtime session, not
inherited from the daemon default. Results retain up to 8,000 characters in
the conversation and 2,000 characters in run previews. Delivery or missing
owner failures cannot be reported as successful. Cron evaluation and next
run computation are bounded per request, schedules per owner are capped,
and run history is bounded.

## Contract v1 (base `/api/schedules`, auth required, user scoped camelCase)

| Method | Path | Request | Success |
| ------ | ---- | ------- | ------- |
| POST | `/api/schedules` | `{name,prompt,mode,timezone,schedule,model?,enabled?}` | 201 `{schedule}` |
| GET | `/api/schedules` | none | 200 `{schedules}` |
| GET | `/api/schedules/:id` | none | 200 `{schedule}` |
| PATCH | `/api/schedules/:id` | partial fields | 200 `{schedule}` |
| DELETE | `/api/schedules/:id` | none | 204 |
| POST | `/api/schedules/:id/run` | none | 200 `{schedule,run}` |
| GET | `/api/schedules/:id/runs` | none | 200 `{runs}` |
| POST | `/api/schedules/preview` | `{schedule,timezone}` | 200 `{nextRuns}` |
| GET | `/api/schedules/system` | none | 200 `{tasks}` |

Schedule shape:

```json
{
  "id": "uuid",
  "name": "Morning focus lines",
  "prompt": "Write three focus lines for today",
  "mode": "notify",
  "timezone": "Asia/Kolkata",
  "schedule": {"kind": "cron", "expression": "0 9 * * MON"},
  "model": null,
  "enabled": true,
  "nextRunAt": "2030-05-06T03:30:00.000Z",
  "lastRunAt": null,
  "lastStatus": null,
  "threadId": "uuid",
  "cadenceDescription": "Mondays at 9:00 AM",
  "createdAt": "...",
  "updatedAt": "..."
}
```

`mode` is `notify`, `execute`, or `agent`; `model` is pinned for the last two.
`cadenceDescription` is computed by the server and never stored: cron becomes
plain English ("Every day at 9:00 AM", "Weekdays at 8:00 AM", "Every hour",
"On the 1st of every month at 9:00 AM") with a "Cron: <expr>" fallback,
interval becomes "Every N minutes/hours", and once becomes "Once on Oct 20,
2026 at 9:00 AM" in the schedule's timezone.

`GET /api/schedules/system` lists built in tasks as read only rows:
`{tasks:[{id,name,description,enabled,cadence,nextRunAt,lastRunAt,lastStatus,
threadId?,editable}]}` for `heartbeat` (editable, toggled through
`PUT /api/agent-home/heartbeat`; `lastStatus` is quiet, message, error,
skipped, or null) and `memory` (Memory upkeep, not editable).

`schedule.kind` is `once` (`at`), `cron` (`expression`, 5 field), or
`interval` (`minutes`). Malformed zone, cron, `at`, kind, mode, or empty
prompt is 400 with an actionable message. Cross owner access hides existence
with 404 on detail, runs, run now, patch, and delete. Lists are owner scoped.
Missing auth is 401. Unknown ids are 404 on every per schedule route.

## Reference: what Vellum does

Vellum's assistant runs a 15 second tick loop (`scheduler.ts`,
`TICK_INTERVAL_MS = 15_000`) over a claim based store
(`claimDueSchedules(now)`), supports cron via `croner` and RRULE sets
(RFC 5545, `DTSTART` required, exclusion precedence) via `rrulestr`, keeps
per schedule timezones (`schedule-timezone.ts`), retries with exponential
backoff plus jitter capped at 30 minutes, and on crash marks stale in flight
rows `error` then follows the normal retry or exhaust path
(`schedule-recovery.ts`). The web UI groups schedules into recurring,
upcoming one time, and past one time (`groupSchedules`).

Amiro v1 scopes to once, cron, and interval with per schedule zones, which
covers the same user stories without the RRULE surface.

## Verification plan

`backend/tests/schedules_acceptance.rs` runs the real native binary with
fresh temp homes and never touches `native_acceptance.rs`:

1. CRUD, pause, run now, history, delete are persisted.
2. Owner isolation: member sees an empty list, every per id route is 404,
   anon is 401.
3. Malformed time and spec bodies are 400, unknown ids are 404, bad preview
   persists nothing.
4. Once preview returns exactly one time. Cron and interval previews return exactly 5 ascending runs with correct spacing.
5. DST gap wall time is 400 on create and preview. Fold wall time is 400
   on create and preview. An explicit offset is accepted and converts.
6. Naive 09:00 plus Asia/Kolkata previews and persists as 03:30Z.
7. Genuine stop, due instant passes with no process alive, boot: the overdue
   once fires exactly once, and a second restart never replays it.
8. A seeded running row in schedule-runs.json is marked interrupted with
   finishedAt on reboot, with no replay row appended.
9. Eight concurrent run now calls never overlap: at most one running row,
   no fabricated extra completed runs.
10. Delete while a run is in flight is 409. After the run closes, delete
    is 204, the schedule row is gone, and the run history file keeps the row.
11. A second backend on the same home is rejected on mutation while the
    holder keeps working.

Verified on October 17, 2026: the complete native test suite passed, including
all 13 schedule acceptance tests and all 4 durability tests. Frontend type
checking passed, and all 388 frontend tests passed. The browser harness
passed 24 checks with the real owned runtime and an isolated local provider.
Provider request evidence confirmed a saved model different from the daemon
default was actually used, with zero tools exposed. No paid provider request
was needed. Desktop and mobile screenshots were also inspected.

Run: `cd backend && cargo test --test schedules_acceptance`.
Run browser verification after building the UI and native binary:
`AMIRO_SCHEDULE_TEST_RUNTIME=1 pnpm verify:schedules-ui`.
It uses disposable accounts and storage, the real owned runtime, and a local
stub provider. Native acceptance stays on notify mode for the persistence,
timer, and restart paths.

## Chat and the Schedules page are one system

The backend publishes its schedules to the agent as a built-in MCP server,
`amiro` (`backend/src/agent_mcp.rs`, `POST /agent-mcp`, local only, its own
token in `~/.amiro/protected/agent-mcp.token`, never written to `mcp.json`).
The agent reaches it through `mcp_call` with tools `schedule_list`,
`schedule_create`, `schedule_update`, `schedule_delete`, `schedule_run_now`
and `schedule_runs`, all going through the same code as the HTTP routes.

- A schedule the agent creates is tagged `createdBy: "agent"` and shows
  "Created in chat" on the page. With no model given it runs on the model
  you last chatted with (`store/last-chat-model.json`), unless
  `AMIRO_DEFAULT_MODEL` is set.
- The built-in **Schedules** skill (`agent-skills/schedules`) loads for
  scheduling asks ("every weekday at 8", "remind me Friday", "how did my
  briefing go?") and keeps the agent off the runtime's private `schedule`
  wake-up tool, which never appears on the page.

## Logs

- **Schedules page:** "Recent runs" lists the latest runs across schedules;
  each schedule's detail panel shows its run history with full output or
  error and a link to the run's conversation.
- **Chat:** ask "how did my briefing go?" and the agent reads the run log via
  `schedule_runs`.
- **Each schedule's conversation** holds every result in full.
- **System tasks:** the Heartbeat row shows its last result and opens its
  notes thread.
