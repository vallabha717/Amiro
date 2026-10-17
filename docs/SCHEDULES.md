# Schedules

Schedules run a saved prompt on a timer. Each schedule belongs to one user,
fires in its own timezone, and records every firing in run history you can
inspect. There are two modes: `notify` posts the result as a visible thread
message with no model call, and `execute` runs an agent turn with tools
forced off and the model pinned server side.

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
resolves to one unambiguous UTC instant.

Pausing a schedule stops all timer firings. Run now still works while paused
because it is an explicit action, and it appends to run history like any
other firing. Deleting a schedule removes it and keeps past runs readable
until retention trims them.

Scheduled runs have no tools and send no external notifications. There is no
email, no push, and no inbox access. The default prompt should describe a
self contained task such as "Write three focus lines for today", not
"Summarize inbox", which would imply mailbox tools the runner does not have.
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

Execute mode pins the model server side, forces tools off through the
`runtime::configure_tools` path with no CLI bypass, and runs under a turn
timeout with cancel. Cron evaluation and next run computation are bounded
per request, schedules per owner are capped, and run history plus stored
output are bounded.

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

Schedule shape:

```json
{
  "id": "uuid",
  "name": "Morning focus lines",
  "prompt": "Write three focus lines for today",
  "mode": "notify",
  "timezone": "Asia/Kolkata",
  "schedule": {"kind": "cron", "expression": "0 9 * * MON"},
  "model": "pinned-model-id",
  "enabled": true,
  "nextRunAt": "2030-05-06T03:30:00.000Z",
  "lastRunAt": null,
  "lastStatus": null,
  "threadId": "uuid",
  "createdAt": "...",
  "updatedAt": "..."
}
```

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
5. DST gap wall time is 400. Fold wall time resolves to one UTC instant.
6. Naive 09:00 plus Asia/Kolkata previews and persists as 03:30Z.
7. Genuine stop, due instant passes with no process alive, boot: the overdue
   once fires exactly once, and a second restart never replays it.
8. A run stuck in running across a restart is marked interrupted and never
   completes as success.
9. Eight concurrent run now calls never fan out into parallel executions.
10. A second backend on the same home is rejected on mutation while the
    holder keeps working.

Run: `cd backend && cargo test --test schedules_acceptance`.
The main harness supports a real runtime with a local stub via
`AMIRO_SCHEDULE_TEST_RUNTIME=1`. The coordinator owns the execute mode
success end to end. Native acceptance here stays on notify mode for the
persist, timer, and restart path.
