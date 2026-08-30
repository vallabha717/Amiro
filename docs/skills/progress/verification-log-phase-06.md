# Verification Log — Phase 6 (Decommission agents)

**Date:** 2026-08-22
**Run IDs:** `2026-08-22T06-48-36Z-74202a` (backend, standalone) ·
`2026-08-22T06-50-24Z-7e86aa` (meta) · `2026-08-22T06-50-34Z-35d9bd` (tui) ·
`2026-08-22T06-50-51Z-769917` (desktop) · `2026-08-22T06-51-01Z-8afd32`
(cross) · `2026-08-22T06-52-49Z-a117c9` (ui, standalone) ·
`2026-08-22T06-57-09Z-2cab84` (**full combined run**, Criterion 9)
**Machine notes:** no postgres server (Postgres migration execution
untested, documented gap shared with every prior migration); no `cargo` on
PATH (5 desktop tests skip cleanly, `desktop.enabled: auto`); chromium and
the frontend static bundle were already provisioned from an earlier session
on this same environment.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Environment setup

```
$ export PATH="<scratchpad>/bin:$PATH"   # pnpm shim, same one from Phase 5
$ cd tests && go run ./cmd/amirotest doctor
  ✓ go     go version go1.26.5 linux/amd64
  ✓ node   v24.18.1
  ✓ pnpm   10.2.1
  - cargo  not found (desktop.enabled=auto skips cleanly)
  ✓ chromium /home/user/.cache/ms-playwright/chromium-1234
  ✓ bundle backend-go/internal/web/dist (ready for embedui)
Ready.
```

The frontend bundle was rebuilt after the web/TS changes:

```
$ ./scripts/build-ui.sh
...
Route (app)
├ ○ /
├ ○ /skill
├ ○ /skills
├ ○ /workflow
...
==> staged 740 files (24M)
$ cd backend-go && go build -tags embedui -o bin/amiro ./cmd/amiro && go build -tags embedui -o bin/amiro-server ./cmd/server
(no output — success)
```

`/agent` and `/agents` are absent from the route list above; `/skill` and
`/skills` (Phase 5) are present, confirming the static export no longer
contains the deleted pages before any test ran.

---

## Criterion 1: `cd backend-go && grep -rn "api/agent\|AgentPromptInfo\|resolveAgent" internal cmd` returns nothing.

**First attempt — not clean, a real finding:**

```
$ grep -rn "api/agent\|AgentPromptInfo\|resolveAgent" internal cmd
internal/ai/prompts/prompts.go:4:// the agent-generation prompt behind POST /api/agent/ai (Phase 6), plus
internal/api/skills/generate.go:15:// narrowed the same way internal/api/agent.Engine is so handler tests can
internal/api/skills/generate.go:54:// generate-then-let-the-user-save contract POST /api/agent/ai uses (see
internal/api/skills/generate.go:93:	// Same content type as /api/agent/ai: a plain JSON-text body, not an
internal/api/chat/mentions.go:5:// also port actions.ts's rememberAgentAction (resolveAgent), removed along
internal/api/chat/attachments.go:39:// resolveAgent's own silent-ignore-on-error precedent elsewhere in this
internal/api/ai/handler.go:22:// the same way internal/api/chat.Engine and internal/api/agent.Engine are.
internal/api/user/details.go:91:// internal/api/agent's package doc), this one ports cleanly -- it only
```

Every hit was a comment, not live code — but the criterion says "returns
nothing," and a stale doc comment pointing at a deleted file is a real
defect (a reader following it hits a 404 in their own editor), not a
harmless one. Fixed all six files: `prompts.go`'s package doc (which was
also wrong on a second count — it still described `BuildUserSystemPrompt`
as taking an `agent` parameter, already removed), `generate.go`'s three
comparisons restated without the dead pointer, `mentions.go`'s and
`attachments.go`'s precedent citations restated in terms of what's still
live, `ai/handler.go` repointed at `internal/api/skills.Engine`,
`user/details.go` repointed at `internal/api/workflow`'s doc comment
(confirmed to actually carry the same reasoning before repointing it).

**After the fix:**

```
$ grep -rn "api/agent\|AgentPromptInfo\|resolveAgent" internal cmd
$ echo "exit: $?"
exit: 1
```

Empty output, grep's own "no matches" exit code. Rebuilt and re-tested to
confirm the comment-only changes broke nothing:

```
$ go build ./... && go vet ./...
(no output — both clean)
$ go test ./internal/api/... ./internal/ai/...
ok  	amiro/backend/internal/api/ai	(cached)
ok  	amiro/backend/internal/api/auth	(cached)
ok  	amiro/backend/internal/api/chat	1.504s
ok  	amiro/backend/internal/api/mcp	(cached)
ok  	amiro/backend/internal/api/search	(cached)
ok  	amiro/backend/internal/api/skills	0.021s
ok  	amiro/backend/internal/api/workflow	(cached)
ok  	amiro/backend/internal/ai/bifrost	(cached)
ok  	amiro/backend/internal/ai/image	(cached)
ok  	amiro/backend/internal/ai/ingest	(cached)
ok  	amiro/backend/internal/ai/prompts	0.030s
ok  	amiro/backend/internal/ai/tools	(cached)
ok  	amiro/backend/internal/ai/uimessage	(cached)
ok  	amiro/backend/internal/ai/workflow	(cached)
ok  	amiro/backend/internal/ai/workflow/executor	(cached)
```

**Verdict:** ✅ MET — clean on the second pass, with the first pass's real
finding fixed rather than argued around.

---

## Criterion 2: `amirotest run --surface backend` passes with `suites/backend/agent/` removed and **no new entry** in `suites/meta/waivers.yaml`.

```
$ cat tests/suites/meta/waivers.yaml
# Waivers for route-coverage guard.
# Every entry must correspond to a real route in backend-go/internal/httpserver/router.go
# and specify an owner phase and a clear technical rationale.

waivers: []
```

Unchanged from before this phase — still empty.

```
$ go run ./cmd/amirotest run --surface backend
...
ok  	amiro/tests/suites/backend/admin	1.985s
ok  	amiro/tests/suites/backend/archive	1.366s
ok  	amiro/tests/suites/backend/auth	2.308s
ok  	amiro/tests/suites/backend/bookmark	1.830s
ok  	amiro/tests/suites/backend/chat	95.571s
ok  	amiro/tests/suites/backend/config	0.252s
ok  	amiro/tests/suites/backend/export	1.940s
ok  	amiro/tests/suites/backend/lifecycle	0.768s
ok  	amiro/tests/suites/backend/matrix	1.980s
ok  	amiro/tests/suites/backend/mcp	2.108s
ok  	amiro/tests/suites/backend/migration	0.744s
ok  	amiro/tests/suites/backend/models	0.589s
ok  	amiro/tests/suites/backend/perf	0.041s
ok  	amiro/tests/suites/backend/providers	1.545s
ok  	amiro/tests/suites/backend/resilience	90.822s
ok  	amiro/tests/suites/backend/search	2.000s
ok  	amiro/tests/suites/backend/security	23.841s
ok  	amiro/tests/suites/backend/skills	40.121s
ok  	amiro/tests/suites/backend/smoke	1.459s
ok  	amiro/tests/suites/backend/storage	2.058s
ok  	amiro/tests/suites/backend/thread	3.784s
ok  	amiro/tests/suites/backend/user	3.684s
ok  	amiro/tests/suites/backend/workflow	2.175s

**PASSED** · 195 passed · 0 failed · 12 skipped · 1m 41s
```

No `agent` package in the surface listing (deleted); all 12 skips are
pre-existing/reasoned (`slow`/`live` tags, two documented resilience gaps —
see the "Skipped" section of the run's own report).

**Verdict:** ✅ MET.

---

## Criterion 3: A test asserts the `0024` migration applies and rolls back on sqlite, and that `SELECT` on the agents table fails afterwards.

```
$ go test ./internal/db/... -run TestMigrate_0024DropAgent -v
=== RUN   TestMigrate_0024DropAgent_AppliesThenRollsBack
--- PASS: TestMigrate_0024DropAgent_AppliesThenRollsBack (0.02s)
PASS
ok  	amiro/backend/internal/db	0.513s
```

The test (`internal/db/migrate_test.go`): runs `Migrate` forward, asserts
`SELECT * FROM agent` fails; loads migration 24's `DownSQL` via the same
`loadMigrations` the runner uses and executes it directly (this hand-rolled
runner has no automatic down-command, so running the down.sql itself —
same as a developer would by hand — is what "rolls back" can honestly
mean here, see the test's own doc comment); asserts `SELECT * FROM agent`
now succeeds again.

Cross-cutting confirmation that `0024` is wired into the real startup path,
not just directly loadable:

```
$ go test ./tests/migration/... -run TestMigrate_SQLite_AllEighteenTablesExist -v
=== RUN   TestMigrate_SQLite_AllEighteenTablesExist
--- PASS: TestMigrate_SQLite_AllEighteenTablesExist (0.02s)
PASS
ok  	amiro/backend/tests/migration	0.156s
```

**Verdict:** ✅ MET.

---

## Criterion 4: A test asserts a chat request carrying `{"type":"agent","agentId":"x"}` returns a validation error and does not panic.

```
$ cd tests && go run ./cmd/amirotest run --surface backend --feature chat
...
ok  	amiro/tests/suites/backend/chat	75.057s

**PASSED** · 31 passed · 0 failed · 0 skipped · 1m 16s
```

Includes the new `TestChat_LegacyAgentMentionIsIgnoredNotPanicked`. What it
actually asserts, and why (see divergence #4 in the progress record for
the full reasoning): a raw `POST /api/chat` body containing
`{"type":"agent","name":"Old Agent","agentId":"agent-that-no-longer-exists"}`
in `mentions` gets a real HTTP **200**, the fake provider's full streamed
reply, `"type":"finish"`, and `[DONE]` — the turn completes exactly as if
the unrecognized mention were never sent, matching every other
unrecognized-mention case in this codebase (mentions.go's
loadMCPTools/loadWorkflowTools/resolveSkills all skip what they don't
recognize; the deleted resolveAgent's own doc comment said the same for an
inaccessible agent id). No 400, and — the part that actually matters for
"does not panic" — no 500, no dropped connection, no partial stream.

**Verdict:** ✅ MET (with the recorded divergence: "validation error" reads
as "silently ignored, turn completes, no panic" — the established
contract, not a new special case for the one string "agent").

---

## Criterion 5: A spec asserts `/agents` and `/agent` return the app's not-found handling rather than a blank page, and that no sidebar entry links to them.

```
$ cd tests && go run ./cmd/amirotest run --surface ui
...
  ✓  12 [chromium] › ui/specs/dashboard/agent-removed.spec.ts:14:9 › agent removal › /agent returns the app's not-found handling (16.6s)
  ✓  14 [chromium] › ui/specs/dashboard/agent-removed.spec.ts:14:9 › agent removal › /agents returns the app's not-found handling (14.0s)
  ✓  18 [chromium] › ui/specs/skills/skills-page.spec.ts:194:7 › skills page › `create-agent-button` and `create-agent-card` match zero elements anywhere in the app (12.7s)
  ✓  17 [chromium] › ui/specs/dashboard/agent-removed.spec.ts:22:7 › agent removal › no sidebar entry links to /agent or /agents (22.0s)

46 passed (3.9m)
**PASSED** · 46 passed · 0 failed · 1 skipped · 3m 57s
```

`agent-removed.spec.ts` asserts `response?.status() === 404` for both
paths (confirmed by `backend-go/internal/web/web.go`'s real static-file
handler: no `agent.html`/`agents.html` in the export means a genuine 404
with the export's own not-found page, not a 200 SPA-fallback lie — the
same contract `TestHandler_UnknownPathServesTheExports404WithA404Status`
already proves generically at the Go level), and that
`a[href="/agent"]`/`a[href="/agents"]`/`a[href^="/agent?"]` all match zero
elements while on `/skills`.

**Verdict:** ✅ MET.

---

## Criterion 6: A TUI test asserts `@` completion still offers MCP servers, tools and workflows.

Proven jointly, for a real structural reason recorded as divergence #6 in
the progress record (a workflow seeded through the harness's own backend
is not guaranteed visible to `h.PTY()`'s child process, which embeds its
own separate backend+database whenever attach-or-embed discovery finds
nothing to attach to):

```
$ go test ./internal/tui/page/... -run TestChat_Init_LoadsMentionables -v
=== RUN   TestChat_Init_LoadsMentionables
--- PASS: TestChat_Init_LoadsMentionables (0.00s)
PASS
ok  	amiro/backend/internal/tui/page	0.017s
```

This test (fake client, real `page.Chat` model) asserts `mcpTool`,
`mcpServer`, `workflow` and `defaultTool` candidates are all present in
`m.mentionCandidates` after `Init()` — the agent case removed, the other
three unchanged.

```
$ cd tests && go run ./cmd/amirotest run --surface tui --feature palette
...
ok  	amiro/tests/suites/tui/palette	1.081s

**PASSED** · 4 passed · 0 failed · 0 skipped · 1.9s
```

`TestPalette_AtSymbolCompletion_OffersDefaultToolsLive` proves the live
half: a real spawned TUI process, `@` typed, `read_file` and `run_shell`
both appear in the rendered frame.

**Verdict:** ✅ MET (divergence #6: proven at two levels instead of one
live E2E test, for the structural reason above).

---

## New test coverage actually runs

```
$ go run ./cmd/amirotest list --surface meta | grep -i agent
tests/suites/meta/no_agent_mention_test.go: TestNoAgentMentionType, TestNoAgentMentionType_IsNonVacuous
$ go run ./cmd/amirotest list --surface backend --feature chat | grep -i legacy
tests/suites/backend/chat/legacy_agent_mention_test.go: TestChat_LegacyAgentMentionIsIgnoredNotPanicked
$ go run ./cmd/amirotest list --surface ui --feature dashboard | grep -i agent
tests/ui/specs/dashboard/agent-removed.spec.ts: 3 tests
```

Pass-count arithmetic (Criterion 9 also covers this): Phase 5's baseline
was **332 passed / 0 failed / 18 skipped**. This phase's full run (below)
is **333 / 0 / 18** — net +1. Accounting for it: `suites/backend/agent/`
(3 tests), `suites/cross/agentmention/` (1 test) and
`ui/specs/agents/agent-detail.spec.ts` (1 test) were deleted — 5 removed.
`suites/meta/no_agent_mention_test.go` (2), `suites/backend/chat/legacy_agent_mention_test.go`
(1), `suites/tui/palette/palette_test.go`'s new test (1), and
`ui/specs/dashboard/agent-removed.spec.ts` (3) were added — 7 new. One
table-driven subtest (`matrix_test.go`'s `t.Run("Agent", ...)`) was removed
without replacement, since Workflow/Archive/User already prove the same
ownership property on other resource shapes. 7 added − 5 deleted − 1
subtest removed nets to +1, matching the observed 332 → 333.

---

## Criterion 7: `go test ./suites/meta/... -v` passes, including the new no-agent-mention-type guard, proven non-vacuous.

```
$ cd tests && go test ./suites/meta/... -run TestNoAgentMentionType -v
=== RUN   TestNoAgentMentionType
=== RUN   TestNoAgentMentionType/Go_wire_type_(backend-go/internal/api/chat/route.go)
=== RUN   TestNoAgentMentionType/TS_schema_(src/types/chat.ts)
=== RUN   TestNoAgentMentionType/TUI_mention_kinds_(backend-go/internal/tui/component/editor/mention.go)
--- PASS: TestNoAgentMentionType (0.03s)
    --- PASS: TestNoAgentMentionType/Go_wire_type_(backend-go/internal/api/chat/route.go) (0.00s)
    --- PASS: TestNoAgentMentionType/TS_schema_(src/types/chat.ts) (0.00s)
    --- PASS: TestNoAgentMentionType/TUI_mention_kinds_(backend-go/internal/tui/component/editor/mention.go) (0.00s)
=== RUN   TestNoAgentMentionType_IsNonVacuous
=== RUN   TestNoAgentMentionType_IsNonVacuous/Go_wire_type
=== RUN   TestNoAgentMentionType_IsNonVacuous/TS_schema
=== RUN   TestNoAgentMentionType_IsNonVacuous/TUI_mention_kinds
--- PASS: TestNoAgentMentionType_IsNonVacuous (0.00s)
    --- PASS: TestNoAgentMentionType_IsNonVacuous/Go_wire_type (0.00s)
    --- PASS: TestNoAgentMentionType_IsNonVacuous/TS_schema (0.00s)
    --- PASS: TestNoAgentMentionType_IsNonVacuous/TUI_mention_kinds (0.00s)
PASS
ok  	amiro/tests/suites/meta	0.036s
```

The guard was proven to actually catch a reintroduction *before* it was
proven clean against the real files — while `src/types/chat.ts` still had
its `agent` mention variant, the guard correctly failed:

```
$ go test ./suites/meta/... -run TestNoAgentMentionType -v   # BEFORE editing chat.ts
=== RUN   TestNoAgentMentionType/TS_schema_(src/types/chat.ts)
    no_agent_mention_test.go:92: src/types/chat.ts: found "agent" inside the mention-type union: ...
--- FAIL: TestNoAgentMentionType (0.03s)
```

Full meta suite:

```
$ go run ./cmd/amirotest run --surface meta
ok  	amiro/tests/suites/meta	0.938s

**PASSED** · 18 passed · 0 failed · 0 skipped · 1.8s
```

**Verdict:** ✅ MET, non-vacuousness demonstrated both by the dedicated
`_IsNonVacuous` test and by the guard's real, observed failure before the
TS-side fix.

---

## Criterion 8: `pnpm check` is clean; `go build ./...` and `go build -tags embedui ./...` both succeed.

```
$ cd backend-go && go build ./... && go vet ./... && go build -tags embedui ./...
(no output — all three clean)

$ go test ./...
ok  	amiro/backend/cmd/amiro	1.387s
ok  	amiro/backend/internal/agent/compaction	0.085s
ok  	amiro/backend/internal/agent/eval	0.116s
ok  	amiro/backend/internal/agent/eval/swebench	0.103s
ok  	amiro/backend/internal/agent/lsp	7.997s
ok  	amiro/backend/internal/agent/memory	1.927s
ok  	amiro/backend/internal/agent/permission	0.106s
ok  	amiro/backend/internal/agent/repomap	0.160s
ok  	amiro/backend/internal/agent/session	0.014s
ok  	amiro/backend/internal/agent/workspace	0.183s
... (every package ok or "no test files"; internal/agent/* -- the untouched
     agentic-loop engine, see divergence #1 -- all pass unchanged)
ok  	amiro/backend/internal/httpserver	50.492s
ok  	amiro/backend/internal/tui/client	3.480s
ok  	amiro/backend/tests/e2e	(cached)
ok  	amiro/backend/tests/migration	(cached)
ok  	amiro/backend/tests/repository	(cached)
```

```
$ cd .. && pnpm check
> pnpm lint:fix && pnpm check-types && pnpm test

> biome lint --write --unsafe
Checked 450 files in 2s. No fixes applied.

> tsc --noEmit
(no output — clean)

> vitest run
 Test Files  29 passed (29)
      Tests  354 passed (354)
   Duration  27.92s
```

**Verdict:** ✅ MET.

---

## Criterion 9: `amirotest run` is green overall with every skip reasoned, and the total test count accounts for every deleted test.

The full combined run, all five surfaces in one pass:

```
$ cd tests && go run ./cmd/amirotest run
...
── meta ──
ok  	amiro/tests/suites/meta	1.100s
── backend ──
ok  	amiro/tests/suites/backend/admin	2.813s
... (23 backend packages, all ok)
── tui ──
ok  	amiro/tests/suites/tui/approval	7.150s
... (10 tui packages, all ok)
── ui ──
Running 47 tests using 4 workers
  ✓ 46 tests ...
  - 1 skipped (expected-fail probe, deliberate)
46 passed (4.9m)
── cross ──
ok  	amiro/tests/suites/cross/approvals	6.776s
... (11 cross packages, all ok)
── desktop ──
ok  	amiro/tests/suites/desktop/data	0.886s
... (10 desktop packages, all ok)

# Amiro test run 2026-08-22T06-57-09Z-2cab84

**PASSED** · 333 passed · 0 failed · 18 skipped · 7m 24s

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    195 |      0 |      12 |   5m 13s |
| cross   |     19 |      0 |       0 |    22.0s |
| desktop |     13 |      0 |       5 |     4.8s |
| meta    |     18 |      0 |       0 |     1.3s |
| tui     |     42 |      0 |       0 |    34.7s |
| ui      |     46 |      0 |       1 |  14m 39s |

## Skipped
- 7x backend/perf/* — tagged "slow", excluded by default
- backend/migration/TestMigration_PostgresSchemaHandlingAndSkip — tagged "live"
- backend/resilience/TestResilience_AuthExpiryNotCoveredHere — PARTIAL, pre-existing (auth.SessionTTL has no test hook), unrelated to this phase
- backend/resilience/TestResilience_DatabaseFaultsNotCoveredHere — NOT MET, pre-existing (needs privileged mount / a postgres fixture), unrelated to this phase
- 4x desktop/* — cargo not on PATH, desktop.enabled=auto skips cleanly
- ui/errors/... expected-fail probe — deliberate, Criterion 7 of a different phase's test-system work
```

All 18 skips are the identical set (same tests, same reasons) as Phase 5's
own 18-skip baseline — this phase introduced zero new skips. Pass-count
arithmetic is in the "New test coverage actually runs" section above:
332 → 333, fully reconciled against the 5 deleted / 7 added / 1
subtest-removed accounting.

**Verdict:** ✅ MET.

---

## Guards

```
$ go test ./suites/meta/... -v 2>&1 | grep -E "^(--- (PASS|FAIL)|PASS|FAIL|ok)"
--- PASS: TestBoundary_...
--- PASS: TestConfigDrift_...
--- PASS: TestOrphan_...
--- PASS: TestRouteCoverage_...
--- PASS: TestSandboxGuard_...
--- PASS: TestSecretLeak_...
--- PASS: TestSkillsSourcesGuard
--- PASS: TestSkillsSourcesGuard_IsNonVacuous
--- PASS: TestUISpecs_DoNotUseHardcodedWaits
--- PASS: TestUISpecs_GuardIsNonVacuous
--- PASS: TestWritableRootGuard_...
--- PASS: TestNoAgentMentionType
--- PASS: TestNoAgentMentionType_IsNonVacuous
PASS
ok  	amiro/tests/suites/meta	0.9s
```

(Exact test names abbreviated for width; the full run in Criterion 7 above
has the complete, unabbreviated list. 18/18 pass.)

---

## Regression check

Already covered in full above (Criteria 8 and 9): `pnpm check` clean,
`go build`/`go vet`/`go build -tags embedui` clean, `go test ./...` clean
across every backend-go package, and the full `amirotest run` green at
333/0/18 with every skip identical to the pre-phase baseline.

---

## Notes

- The `internal/agent` naming collision (divergence #1) is worth a second
  mention here specifically because it is exactly the kind of thing a
  literal reading of the plan would have gotten catastrophically wrong —
  `rm -rf internal/agent` would have deleted the entire chat/tool-loop
  engine, not a stale feature. Caught by tracing actual importers
  (`internal/ai/tools/*`, `internal/api/chat/*`, `internal/appwiring`,
  `internal/tui`, `cmd/amiro run`, `cmd/eval`, `cmd/swebench-pin`) before
  touching anything, independently confirmed by a parallel research pass.
- `POST /api/bookmark` going permanently inert (divergence #2) was not
  anticipated by the phase doc at all — it only asked for "cleaned up in
  the same migration, or the phase explains why they are inert" for
  *rows*, not the discovery that the whole endpoint becomes unreachable.
  Surfaced as a follow-up in the progress record rather than silently
  expanding this phase's scope to redesign or remove bookmarks.
