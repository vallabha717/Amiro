# Phase 6 — Decommission agents

**Depends on:** 1, 2, 3, 5 · **Blocks:** — · **Size:** M

**Surfaces touched:** backend · web · desktop · terminal

This phase will remove the agent feature entirely — routes, handler,
repository, table, the `agent` mention type on all three surfaces, the TUI's
`ListAgents`, the remaining UI components, and the tests that cover them.
It is the only phase in this plan that deletes product code, and it runs
last because skills must be able to do the job before the thing they replace
is taken away.

**Decided:** full decommission, with **no migration** of existing agents
into skills. Anything currently saved as an agent is dropped when this lands.
That was a deliberate choice, recorded in
[`../README.md`](../README.md)'s decisions section, and it is the reason this
phase's first deliverable is telling the user before the data goes.

## What already exists

- Backend: `internal/api/agent/` (`handler.go`, `route.go`, `ai.go`,
  `id.go`), the agent routes in `internal/httpserver/router.go`,
  `Handlers.Agent`, `internal/agent`, the agents table and its migration,
  and `resolveAgent` + `agentInstructionsDTO` in
  `internal/api/chat/mentions.go` (line 44 onward) which merges an agent's
  pre-bound mentions into a turn.
- Prompt: `prompts.AgentPromptInfo` and the `# Core Instructions` /
  `<core_capabilities>` block in `BuildUserSystemPrompt`
  (`prompts.go:80`) — the only consumer of an agent's system prompt.
- TUI: `client.ListAgents`, `editor.AgentMention`, the agent branch of
  `loadMentionables` (`page/mentions.go:31`), `AgentID` on `client.Mention`.
- Web: the `agent` member of `ChatMentionSchema` (`src/types/chat.ts:82`
  region), the agent-specific chip rendering in `prompt-input.tsx`
  (lines 424–437), `useMutateAgents`, `use-agents.ts`, `canCreateAgent`
  in `lib/auth/client-permissions`, and whatever `components/agent/`
  survived Phase 5.
- Tests: `tests/suites/backend/agent/`, `tests/ui/specs/agents/`,
  `AgentsPage`/`AgentDetailPage` in `tests/ui/pages/index.ts`, and agent
  references in the TUI and cross suites.
- `tests/suites/meta/route_coverage_test.go` and its `waivers.yaml`
  (currently `waivers: []`) — removing routes must leave it green with no
  new waiver.

## Deliverables

### 1. A stated, visible removal

- A release note in `README.md` and `docs/skills/README.md` saying agents
  are gone, skills replace them, and saved agents are not migrated.
- The migration below is irreversible in practice; the phase's progress
  record must state how many agent rows existed on the developer's machine
  when it ran, because "we dropped a table" with no number is not a record.

### 2. Backend removal

| Item | Action |
|---|---|
| `internal/api/agent/` | deleted, including `ai.go`'s generate route (its replacement shipped in Phase 5) |
| Routes + `Handlers.Agent` | removed from `internal/httpserver/router.go`, `internal/appwiring`, `cmd/server`, `cmd/amiro` |
| `internal/agent` | deleted |
| `resolveAgent`, `agentInstructionsDTO`, `resolvedAgent` | deleted from `internal/api/chat/mentions.go`; the mention loop loses its `agent` branch |
| `prompts.AgentPromptInfo` + the `<core_capabilities>` block | deleted; `BuildUserSystemPrompt`'s third parameter goes with it, and every call site (`temporary.go:43`, `eval_agent.go:88`) updated |
| Migration | `0024_drop_agent.{up,down}.sql` × **sqlite and postgres** — four files, one version. The down migration recreates the table empty; it cannot restore rows, and the file says so in a comment |
| Bookmarks / archive rows referencing an agent | cleaned up in the same migration, or the phase explains why they are inert |

### 3. Client removal

- **Web:** the `agent` member of `ChatMentionSchema`, the agent chip branch
  in `prompt-input.tsx`, `use-agents.ts`, `useMutateAgents`, `canCreateAgent`,
  the `(chat)/agent` and `(chat)/agents` routes, everything left in
  `components/agent/`, and the agent keys in **all seven** locale files.
- **TUI:** `ListAgents`, `editor.AgentMention`, the agent branch of
  `loadMentionables`, `AgentID` on `client.Mention`.
- **Shared wire type:** `mentionDTO.AgentID` in Go. After this, `mentions`
  carries `mcpTool`, `mcpServer`, `defaultTool`, `workflow` and `skill`.

### 4. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/agent/` | **deleted.** Its route-coverage obligation disappears with the routes |
| backend | `tests/suites/backend/migration/` | The new migration applies and rolls back on sqlite; postgres remains the documented, unexercised gap · a chat request carrying a legacy `{"type":"agent"}` mention is rejected with a clear error rather than panicking — the one compatibility case that matters, since a stale client can send it |
| web | `tests/ui/specs/agents/` | **deleted**, with the deletion named in the progress record |
| terminal | `tests/suites/tui/skills/` (extended) | `@` completion still works for MCP servers, tools and workflows with the agent branch gone |
| cross | `tests/suites/cross/skills/` (extended) | A turn using a skill mention behaves identically on both surfaces after removal |
| meta | `tests/suites/meta/` | `route_coverage_test.go` passes with **no new waiver**, and `waivers.yaml` is still `waivers: []`. A guard asserting the string `"agent"` no longer appears as a mention type in the Go, TS or TUI union — the invariant this phase creates, and the one a later feature could silently undo |

**Deliberately not covered:** postgres migration execution — no postgres
server exists in this environment, the same documented gap as every prior
migration (see `docs/testing/progress/README.md`). The SQL ships for both
dialects and only sqlite is exercised.

### 5. Docs

`README.md`'s feature list, `docs/skills/README.md`, `tests/README.md`,
`.agents/skills/ui/SKILL.md` and `.agents/skills/backend/SKILL.md` wherever
they reference agents as a live concept, and any doc under `docs/` that
describes `@agent` mentions.

## Exit criteria

1. `cd backend-go && grep -rn "api/agent\|AgentPromptInfo\|resolveAgent" internal cmd` returns nothing.
2. `amirotest run --surface backend` passes with `suites/backend/agent/`
   removed and **no new entry** in `suites/meta/waivers.yaml`.
3. A test asserts the `0024` migration applies and rolls back on sqlite, and
   that `SELECT` on the agents table fails afterwards.
4. A test asserts a chat request carrying `{"type":"agent","agentId":"x"}`
   returns a validation error and does not panic.
5. A spec asserts `/agents` and `/agent` return the app's not-found handling
   rather than a blank page, and that no sidebar entry links to them.
6. A TUI test asserts `@` completion still offers MCP servers, tools and
   workflows.
7. `go test ./suites/meta/... -v` passes, including the new
   no-agent-mention-type guard, proven non-vacuous.
8. `pnpm check` is clean; `go build ./...` and `go build -tags embedui ./...`
   both succeed.
9. `amirotest run` is green overall with every skip reasoned, and the total
   test count in the progress record accounts for **every** deleted test —
   a drop with no explanation is indistinguishable from a regression.

## Risks

- **Deleted tests hide regressions.** Removing `suites/backend/agent/` and
  `tests/ui/specs/agents/` drops the pass count, which can mask an unrelated
  failure in the same run. Mitigation: exit criterion 9 requires the
  arithmetic in the progress record — tests before, tests deleted, tests
  after.
- **`BuildUserSystemPrompt`'s signature change touches every caller**,
  including `openai_realtime.go` and `eval_agent.go`. Mitigation: the
  compiler finds them all; the risk is a behavioural change in the speech
  path, so the existing speech tests must stay green and the record says so.
- **A stale desktop client** could still send an `agent` mention after the
  backend stops accepting one. Mitigation: exit criterion 4 makes the
  rejection explicit and tested rather than a panic.
- **Data loss is intentional here and irreversible.** Mitigation: the
  release note ships in the same phase, and the down migration's own comment
  states that it restores the schema, not the rows.

## Open questions

None. The no-migration decision is recorded; if it is revisited, that is a
new phase, not a change to this one.
