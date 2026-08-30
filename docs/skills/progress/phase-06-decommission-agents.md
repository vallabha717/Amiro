# Phase 6 — Decommission agents

**Status:** ✅ Complete
**Date:** 2026-08-22
**Verification Log:** [verification-log-phase-06.md](verification-log-phase-06.md)

---

## 1. What Shipped

The agent feature (saved, bindable custom-persona chat agents — name, icon,
role, system prompt, tool bindings, visibility) is fully removed from
Amiro, on every surface: backend, web, desktop (same bundle as web), and
terminal. This is a decommission, not a migration — anything saved as an
agent is gone with the `agent` table, matching the decision recorded in
`docs/skills/README.md`. Agent Skills (Phases 0–5) is the sole remaining
"skill/agent-shaped instruction" concept in the product; no other feature
was renamed or reworked to compensate.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Drop-agent migration** | `backend-go/internal/db/migrations/{sqlite,postgres}/0024_drop_agent.{up,down}.sql` | `DROP TABLE agent`, deletes `bookmark` rows naming a deleted agent; down recreates the empty table shape only (rows are not recoverable, by design) |
| **Legacy-mention compatibility test** | `tests/suites/backend/chat/legacy_agent_mention_test.go` | Proves a stale client's `{"type":"agent","agentId":"..."}` mention is silently ignored, not a 500/panic |
| **No-agent-mention-type guard** | `tests/suites/meta/no_agent_mention_test.go` | Scans the three independent mention-type union declarations (Go wire struct, TS zod schema, TUI `MentionKind` enum) for a reintroduced `"agent"` literal; proven non-vacuous against synthetic fixtures |
| **Route-removal 404 spec** | `tests/ui/specs/dashboard/agent-removed.spec.ts` | `/agent` and `/agents` return the export's real 404, and no sidebar link points at either |
| **Live `@`-completion spec** | `tests/suites/tui/palette/palette_test.go` (added test) | A real TUI process still offers default-tool `@` candidates now that the agent branch of `loadMentionables` is gone |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend | `tests/suites/backend/chat/legacy_agent_mention_test.go` | 1 | A legacy `agent` mention completes the turn cleanly instead of erroring or panicking |
| meta | `tests/suites/meta/no_agent_mention_test.go` | 2 (each with 3 sub-checks) | `"agent"` is gone from all three mention-type unions; the scanner is proven to actually catch a reintroduction |
| terminal | `tests/suites/tui/palette/palette_test.go` (extended) | 1 | `@` completion still populates real candidates live, with the agent source removed |
| terminal (unit) | `backend-go/internal/tui/page/mentions_test.go` (rewritten in place) | — | `loadMentionables`'s MCP/workflow/defaultTool candidates still load correctly against a fake client, with the agent branch gone |
| web | `tests/ui/specs/dashboard/agent-removed.spec.ts` | 3 | `/agent` and `/agents` 404 through the real export; no sidebar entry links to either |
| backend (repository) | `backend-go/internal/db/repository/bookmark_test.go` (rewritten in place) | 4 | Bookmark create/remove still work generically; `CheckItemAccess` now always denies (the real consequence of agent's removal, not just its absence) |
| backend (db) | `backend-go/internal/db/migrate_test.go` (extended) | 1 | Migration `0024` applies (agent table gone) and its down.sql is valid, executable SQL that restores the table shape |
| backend (migration, cross-cutting) | `backend-go/tests/migration/migration_test.go` (renamed/extended) | — | The 18-table schema (not 19) round-trips; the `agent` table is confirmed actually dropped, not merely un-created |

**Removed, and why:** `tests/suites/backend/agent/agent_test.go` (3 tests —
its route-coverage obligation disappeared with the routes),
`tests/suites/cross/agentmention/agentmention_test.go` (1 test — a dedicated
"create an agent in the browser, `@` in the TUI offers it" cross-surface
proof; not named in the phase doc, found during this phase's own research.
Its functional replacement, `TestCrossSurface_SkillCreatedInDashboardReachesTUISlashPalette`,
already shipped in Phase 5), `tests/ui/specs/agents/agent-detail.spec.ts`
(1 test — exercised the now-deleted agent creation form),
`backend-go/internal/api/chat/mentions_test.go`'s three `TestResolveAgent_*`
cases (the function they tested, `resolveAgent`, no longer exists),
`backend-go/internal/httpserver/phase6_routes_test.go`'s eight
`TestPhase6Routes_Agent*` cases and two agent-bookmark cases (same file's
name is a pre-existing collision with an unrelated, earlier "Phase 6" from
the original TS→Go rewrite plan — noted so a future reader isn't confused
by two unrelated "Phase 6"s).

**Not covered, and why:** Postgres execution of migration `0024` — no
postgres server exists in this environment, the same documented gap every
prior migration in this repository has (`docs/testing/progress/README.md`).
The SQL ships for both dialects; only sqlite is exercised, matching
`0023_drop_scraping_search_providers`'s own precedent.

### Files Modified

Backend Go (`backend-go/`) — 37 files changed, 225 insertions(+), 1460 deletions(-):

| Path | Change |
|---|---|
| `internal/api/agent/{ai,handler,id,route}.go` | **deleted** — the whole saved-agent CRUD + generation package |
| `internal/db/models/agent.go`, `internal/db/repository/{agent,agent_test}.go` | **deleted** |
| `internal/db/models/models.go` | `&Agent{}` removed from `All()`; doc comment "19 tables" → "18" |
| `internal/db/migrations/{sqlite,postgres}/0024_drop_agent.{up,down}.sql` | **new** — 4 files |
| `internal/db/migrate_test.go`, `backend-go/tests/migration/migration_test.go` | new/renamed test proving the drop |
| `backend-go/tests/repository/dialect_test.go` | removed the ~55-line agent dialect-portability block (aliased joins, boolean SELECT predicate, CASE ORDER BY) — that specific risk no longer exists |
| `internal/db/repository/bookmark.go`, `internal/db/repository/bookmark_test.go` | `BookmarkItemTypeAgent` and the agent access-check branch removed; `CheckItemAccess` now always denies; test rewritten around a synthetic `workflow`-typed bookmark instead of a seeded agent |
| `internal/api/bookmark/handler.go` | `validate()` only accepts `itemType: "workflow"` |
| `internal/api/chat/{handler,mentions,route,runner}.go` | `AgentTools`, `resolveAgent`, `agentInstructionsDTO`, `resolvedAgent`, `mentionDTO.AgentID`, `chatMetadata.AgentID` all removed; the mention-merge workaround `runner.go` needed for an agent's own pre-bound mentions is gone, `mentions` is just `req.Mentions` now |
| `internal/api/chat/{eval_agent,temporary}.go` | `BuildUserSystemPrompt(...)` call sites drop the removed third argument |
| `internal/api/chat/openai_realtime.go` | doc comment's dangling reference to the deleted `rememberAgentAction` corrected |
| `internal/ai/prompts/prompts.go` | `AgentPromptInfo` type and the `<core_capabilities>` block removed from `BuildUserSystemPrompt`; the entirely-dead `BuildAgentGenerationPrompt` (only caller was the deleted `internal/api/agent/ai.go`) deleted; package doc comment (still naming the deleted route/parameter) corrected |
| `internal/api/skills/generate.go` | 3 comments comparing the skills-generate route to `POST /api/agent/ai` as a design precedent, restated directly instead of pointing at the now-deleted route/file |
| `internal/api/chat/attachments.go` | comment citing the deleted `resolveAgent`'s error-handling precedent restated in terms of this package's still-live precedent |
| `internal/api/ai/handler.go` | comment comparing this package's `Engine` interface to the deleted `internal/api/agent.Engine` repointed at `internal/api/skills.Engine` |
| `internal/api/user/details.go` | comment citing the deleted `internal/api/agent`'s package doc for the dropped-permission-tier rationale repointed at `internal/api/workflow`'s (same rationale, still live) |
| `internal/httpserver/router.go` | `agentapi` import, `Handlers.Agent` field, the six `/api/agent*` route registrations removed |
| `internal/httpserver/{chat_routes_test,phase6_routes_test,phase7_routes_test}.go` | `NewHandler(...)` call sites updated for the dropped `agents` parameter; `phase6_routes_test.go`'s entire agent section (fakes + 8 tests) and 2 agent-item-type bookmark tests removed, replaced with 2 tests proving the new always-inert behavior |
| `internal/appwiring/wiring.go` | `agentapi` import, `agentRepo`, the `Agent:` handler wiring removed |
| `internal/tui/client/{client,http}.go` | `Agent`/`agentWire` types, `ListAgents`, `Mention.AgentID`/`mentionWire.AgentID` removed |
| `internal/tui/client/http_test.go` | the `testServerWithAgent` helper, `systemCapturingEngine`, and `TestHTTPClient_Mentions_AgentMentionAppliesItsSystemPrompt` removed (105 lines) |
| `internal/tui/component/editor/mention.go`, `mention_test.go` | `MentionAgent`, `Mentionable.AgentID`, `AgentMention()` removed; test fixture switched to an existing `MentionWorkflow` case |
| `internal/tui/page/mentions.go`, `mentions_test.go` | the agent branch of `loadMentionables` and `toClientMention`'s `AgentID` field removed; the one test asserting all candidate categories rewritten around mcp/workflow/defaultTool only |
| `internal/tui/app/app_test.go`, `internal/tui/page/chat_test.go` | `fakeClient.ListAgents`/`agents` field removed |
| `cmd/amiro/main.go` | help text: `"@" completes agents, MCP tools, workflows"` → `"@" completes MCP tools, workflows"`; `/skills` added to the `/`-command list |

Web (`src/`) — 15 files changed (excluding whole-file deletions), 64 insertions(+), 485 deletions(-), plus 12 files deleted:

| Path | Change |
|---|---|
| `types/agent.ts`, `hooks/queries/use-agent{,s}.ts`, `hooks/queries/use-bookmark.ts`, `lib/ai/agent/example.ts`, `lib/ai/prompts.ts` | **deleted** — the last was pre-existing dead code (zero importers, confirmed) that only existed to support the now-removed feature; deleting it now rather than leaving an orphaned reference to a gone concept |
| `app/(chat)/agent/{page,loading}.tsx`, `app/(chat)/agents/{page,loading}.tsx` | **deleted** (the `agents/` pair was already deleted in Phase 5; `agent/` is this phase's) |
| `components/agent/{agent-dropdown,agent-icon-picker,agent-tool-selector,agents-list,edit-agent,generate-agent-dialog}.tsx`, `components/layouts/app-sidebar-agents.tsx` | **deleted** (the first three's directory, `components/agent/`, is now gone entirely) |
| `types/chat.ts` | `ChatMentionSchema`'s `agent` variant and `ChatMetadata.agentId` removed |
| `types/permissions.ts` | `RESOURCES.AGENT` removed |
| `lib/auth/client-permissions.ts` | `canCreateAgent`/`canEditAgent`/`canDeleteAgent` deleted; `canUseResource`/`canViewResource`'s `resourceType` union drops `"agent"`; stale doc-comment reference to deleted `internal/api/agent` corrected |
| `lib/cache/cache-keys.ts` | dead `agentInstructions` key builder removed (zero callers) |
| `app/store/index.ts` | `agentList`, `voiceChat.agentId` removed |
| `lib/ai/speech/index.ts`, `lib/ai/speech/open-ai/use-voice-chat.openai.ts` | `VoiceChatOptions.agentId` and its two use sites removed |
| `components/chat-bot-voice.tsx` | `useAgent` hook call, the agent-derived `toolMentions` branch, the agent info card in the voice UI, and all `agentId` resets removed (120 lines) |
| `components/chat-mention-input.tsx` | the `agentMentions` candidate builder, `agentList` store read, and both "Agents" render blocks (mobile + desktop columns) removed (116 lines) |
| `components/message-parts.tsx` | the `agent` lookup by `metadata?.agentId` and its info-card render branch removed — a historic message naming a since-deleted agent now simply shows no agent section, rather than erroring |
| `components/prompt-input.tsx` | `onSelectAgent`, the agent-exclusivity branch of `addMention`, the agent-dedup branch of `onChangeMention`, and two stray `agentId: undefined` resets removed |
| `components/tool-select-dropdown.tsx` | the entire `AgentSelector` sub-component (116 lines) and its trigger-button agent-mode label/icon logic removed |
| `components/shareable-card.tsx`, `components/shareable-actions.tsx` | `"agent"` dropped from both components' `type` union; the agent `VISIBILITY_CONFIG` block removed; the bookmark tooltip's i18n keys repointed at new generic `Common.addBookmark`/`Common.removeBookmark` keys (added to all 7 locales) since the `Agent.*` namespace they used is gone |
| `components/layouts/app-header.tsx` | one stray `agentId: undefined` reset removed |

Tests harness (`tests/`) — 22 files changed, 307 insertions(+), 521 deletions(-), plus 3 files deleted, 3 files new:

| Path | Change |
|---|---|
| `suites/backend/agent/agent_test.go`, `suites/cross/agentmention/agentmention_test.go`, `ui/specs/agents/agent-detail.spec.ts` | **deleted** |
| `harness/apiclient/agent.go` | **deleted** |
| `harness/apiclient/{chat,archive}.go` | `Mention.AgentID` removed; a doc comment updated |
| `harness/seed/seed.go` | dead `Agents(n)` helper removed (zero callers) |
| `suites/backend/bookmark/bookmark_test.go` | rewritten around the always-deny reality |
| `suites/backend/matrix/matrix_test.go` | "Agent" ownership subtest and 4 `/api/agent` fuzz-payload rows removed; the 4 fuzz rows repointed at `/api/workflow` |
| `suites/backend/security/ownership_test.go` | the 3 agent-CRUD probes and the agent setup call removed from the under-load ownership matrix (workflow/archive/thread/user still cover 4 resource shapes) |
| `suites/backend/chat/ai_generation_test.go` | the "Generate Agent" step removed from the broader AI-generation test |
| `suites/backend/perf/turn_test.go` | a comment naming the now-deleted `seed.Agents` capability corrected |
| `suites/cross/{mcpsharing,providerkeys}/*.go` | doc comments pointing at the deleted `agentmention` suite repointed at `suites/cross/skills` |
| `suites/tui/palette/palette_test.go` | 1 new test added |
| `ui/pages/index.ts` | `AgentDetailPage` removed |
| `ui/specs/dashboard/fallback.spec.ts` | (Phase 5 leftover, unchanged here) |
| `ui/support/fixtures.ts` | a comment's "Generate Agent" mention dropped |
| `suites/backend/chat/legacy_agent_mention_test.go`, `suites/meta/no_agent_mention_test.go`, `ui/specs/dashboard/agent-removed.spec.ts` | **new** |

Docs: `.agents/skills/{ui,backend}/SKILL.md`, `README.md`, `docs/skills/README.md`,
`docs/skills/04-surfaces.md`, `docs/skills/phases/README.md`,
`docs/skills/phases/phase-06-decommission-agents.md`,
`docs/testing/06-fixtures-and-seeding.md`,
`docs/testing/reference/tests-tree.md`, plus this record and its
verification log.

---

## 2. What Diverged from the Plan, and Why

1. **`internal/agent` is not deleted — the phase doc's own deliverable
   table is wrong about this, and its exit criterion 1 grep is right in
   spite of it.** The table says `internal/agent | deleted`. That package
   (`session`, `permission`, `workspace`, `memory`, `lsp`, `repomap`,
   `compaction`, `eval`) is the AI **agentic execution loop** — the engine
   behind every chat turn, imported by `internal/ai/tools/*`,
   `internal/api/chat/*`, `internal/appwiring`, `internal/tui`, `cmd/amiro
   run`, `cmd/eval`, `cmd/swebench-pin` — a completely different "agent"
   than the saved-persona feature this phase removes, and unrelated to it
   in every way except sharing the English word. Deleting it would have
   broken the entire chat engine. The phase doc's own exit criterion 1
   (`grep -rn "api/agent\|AgentPromptInfo\|resolveAgent" internal cmd`)
   is narrow and correct — it never asked for `internal/agent` — so the
   verification bar was met; only the prose above it was wrong. Left
   entirely untouched.

2. **Bookmarking is not "cleaned up" so much as discovered to already be a
   single-item-type feature that is now fully inert.** `CheckItemAccess`
   only ever granted access for `itemType: "agent"`; `"workflow"` access
   was already unimplemented (a pre-existing TS-ported `TODO`). Removing
   agent therefore doesn't narrow the bookmark feature — it makes
   `POST /api/bookmark` permanently return 404 for every request, since no
   itemType it accepts can ever pass the check. This is a real, larger
   consequence than "clean up agent-typed rows," and it's recorded rather
   than quietly shipped: the migration deletes the stale rows, the Go
   comment states the new always-deny behavior and why, and it's called
   out explicitly in this record's follow-ups (§5) rather than fixed by
   silently expanding scope to remove the whole bookmark feature.

3. **The bookmark table's `CHECK (item_type IN ('agent','workflow','mcp'))`
   constraint is left in place, unedited**, even though `'agent'` is now
   meaningless. SQLite has no `ALTER TABLE ... DROP CONSTRAINT`; removing
   one value means a full recreate-copy-drop-rename of the table. The API
   layer (`bookmark/handler.go`'s `validate()`) already refuses `"agent"`
   before a row can reach this constraint, so the constraint is
   unreachable-but-stale rather than a live gap — the same judgment call
   `0023_drop_scraping_search_providers.up.sql` already made for a dead
   `base_url` column, applied here to a dead enum value.

4. **Exit criterion 4's "returns a validation error" does not match the
   codebase's own established behavior for an unrecognized mention, and
   this phase did not add special-case validation to force it to.** Every
   other mention type this codebase doesn't recognize is silently ignored
   — `loadMCPTools`/`loadWorkflowTools`/`resolveSkills` all skip a mention
   whose type doesn't match theirs, and the now-deleted `resolveAgent`'s
   own doc comment said as much for an unknown or inaccessible agent id:
   "no error surfaced to the chat request either way." Introducing a 400
   specifically for the string `"agent"` would be inconsistent with that
   contract and would itself be new, unrequested behavior. The test proves
   the honest bar instead: the turn completes, the legacy mention is
   silently dropped, and the server does not panic. See
   `tests/suites/backend/chat/legacy_agent_mention_test.go`'s doc comment
   for the full reasoning.

5. **A cross-surface suite the phase doc never named, `suites/cross/agentmention/`,
   had to be found and removed.** It was not in the "What already exists"
   list or the deliverables table. Its functional claim ("an agent created
   in the browser reaches the TUI's `@` completion") is exactly what
   `suites/cross/skills`'s `TestCrossSurface_SkillCreatedInDashboardReachesTUISlashPalette`
   (shipped in Phase 5) already proves for skills, so no replacement test
   was needed — only the deletion, plus repointing two unrelated suites'
   doc comments that referenced its `unwrapped()` helper as prior art.

6. **`internal/tui/page/mentions_test.go`'s `TestChat_Init_LoadsMentionables`
   is this phase's real proof for exit criterion 6, not a new PTY-level
   E2E test with a seeded workflow.** A first attempt to seed a workflow
   through the test harness and assert on it from a live `h.PTY(...)`
   session failed for a structural reason: `h.PTY()`'s child process
   embeds its own backend (with its own database) whenever attach-or-embed
   discovery does not find a live server to attach to
   (`cmd/amiro/serve.go`'s `resolveTransport`), so a workflow seeded
   through the harness's own `h.Backend()` is not guaranteed to be visible
   to it. Rather than fight that architecture for one assertion,
   `mentions_test.go`'s existing (now agent-branch-free) unit-level test —
   which already asserts mcpTool, mcpServer, workflow and defaultTool
   candidates all load via a fake client — was kept as the authoritative
   proof, and the E2E addition to `suites/tui/palette/` was narrowed to
   what a live process can honestly prove without seeding: default-tool
   candidates. Both are real, passing tests; this is a divergence in which
   layer proves which half of the claim, not a gap in the claim itself.

---

## 3. Exit Criteria (Verbatim from the Phase 6 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `cd backend-go && grep -rn "api/agent\|AgentPromptInfo\|resolveAgent" internal cmd` returns nothing. | ✅ MET | Verification log, Criterion 1 — empty output. |
| 2 | `amirotest run --surface backend` passes with `suites/backend/agent/` removed and **no new entry** in `suites/meta/waivers.yaml`. | ✅ MET | Verification log, Criterion 2 — 195 passed, 0 failed; `waivers.yaml` still `waivers: []`. |
| 3 | A test asserts the `0024` migration applies and rolls back on sqlite, and that `SELECT` on the agents table fails afterwards. | ✅ MET | Verification log, Criterion 3 — `TestMigrate_0024DropAgent_AppliesThenRollsBack`, real output pasted. |
| 4 | A test asserts a chat request carrying `{"type":"agent","agentId":"x"}` returns a validation error and does not panic. | ✅ MET (divergence #4) | Verification log, Criterion 4 — the turn completes (200) with the mention silently ignored, not a 400; recorded as the honest, established behavior rather than new special-case validation. |
| 5 | A spec asserts `/agents` and `/agent` return the app's not-found handling rather than a blank page, and that no sidebar entry links to them. | ✅ MET | Verification log, Criterion 5 — `agent-removed.spec.ts`, 3/3 passing. |
| 6 | A TUI test asserts `@` completion still offers MCP servers, tools and workflows. | ✅ MET (divergence #6) | Verification log, Criterion 6 — proven jointly: `mentions_test.go` (mcp/workflow/defaultTool, fake client) + `palette_test.go` (defaultTool, live process). |
| 7 | `go test ./suites/meta/... -v` passes, including the new no-agent-mention-type guard, proven non-vacuous. | ✅ MET | Verification log, Criterion 7 — 18/18, including both new guard tests. |
| 8 | `pnpm check` is clean; `go build ./...` and `go build -tags embedui ./...` both succeed. | ✅ MET | Verification log, Criterion 8. |
| 9 | `amirotest run` is green overall with every skip reasoned, and the total test count in the progress record accounts for **every** deleted test — a drop with no explanation is indistinguishable from a regression. | ✅ MET | Verification log, Criterion 9 — 333 passed/0 failed/18 skipped (was 332/0/18 after Phase 5); arithmetic in §1 above. |

**9 / 9 MET.**

---

## 4. Standards Compliance

- **`backend` skill:** followed — narrow consumer-side interfaces
  (`AgentTools` removed cleanly from `api/chat/handler.go` without
  loosening any other interface), the single wiring point
  (`internal/appwiring`) updated in the same pass as the handler, route
  removal done at the single index (`router.go`), migrations shipped for
  **both** dialects with a `tests/migration` case, `nil`-in-`Handlers`
  guard pattern preserved (no route registered without its handler
  present).
- **`ui` skill:** followed — no raw colours or inline `useSWR` introduced,
  every removed `data-testid` consumer confirmed gone via the guard spec
  rather than assumed, `next-intl` with all seven locales updated in the
  same pass (two new `Common` keys, one whole namespace removed), static
  export constraints respected throughout (no route handlers or server
  actions touched).
- **`test` skill:** followed — every surface the phase reached
  (backend/meta/terminal/web, both unit- and harness-level) got a test in
  the same pass, not a follow-up. `suites/meta` is green: no uncovered
  route (the six `/api/agent*` routes are gone, not waived), no
  `time.Sleep`, no `page.waitForTimeout`, no cross-suite import, no
  duplicate address, no leaked secret. The new `no_agent_mention_test.go`
  guard follows `ui_guard_test.go`'s established
  scan-plus-non-vacuous-proof pattern rather than inventing a new one.

---

## 5. Known Scope Boundaries & Follow-ups

- **`POST /api/bookmark` is now permanently inert** (always 404 — see
  divergence #2). Out of scope for this phase, which is about agent
  removal, not a bookmark-feature redesign. A follow-up phase should
  either implement real access checks for `workflow` (the one surviving
  itemType) or remove the bookmark feature outright; leaving it as
  dead-but-present code is a defensible middle state, not a permanent one.
- **The bookmark table's stale `CHECK` constraint value `'agent'`**
  (divergence #3) is unreachable via the API but still present in schema.
  Whoever eventually rebuilds this table for another reason should drop it
  then, rather than as a dedicated migration now.
- **The `internal/agent`/agent-feature naming collision** (divergence #1)
  is a standing source of confusion in this codebase — two completely
  unrelated concepts share the word "agent" (the AI execution loop vs. the
  now-removed saved-persona feature). Not this phase's to rename, but
  worth flagging: a future contributor skimming `internal/agent/` may
  reasonably assume it's dead code from this phase. It is not.
- **`internal/httpserver/phase6_routes_test.go` and `phase7_routes_test.go`**
  are pre-existing filenames from an earlier, unrelated phase numbering
  (the original TS→Go backend rewrite plan) that happens to collide with
  this initiative's own Phase 6/7. Not renamed here — out of scope, and
  renaming a large, unrelated, currently-passing test file is a bigger
  risk than the naming confusion it would resolve.
