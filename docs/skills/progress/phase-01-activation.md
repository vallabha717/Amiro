# Phase 01 — Activation, Tier 1/2 Disclosure, and Sandbox Expansion

**Status:** ✅ Complete (8/8 criteria MET)
**Date:** 2026-08-20
**Verification Log:** [verification-log-phase-01.md](verification-log-phase-01.md)

---

## 1. What Shipped

Phase 1 delivers the full Agent Skills activation lifecycle, Tier 1 system prompt catalog disclosure, Tier 2 model tool invocation (`skill(name)`), mention-based explicit loading, thread-safe workspace read-only sandbox expansion, and context preservation during compaction.

### Core Capabilities Shipped

1. **Tier 1 Discovery Disclosure:**
   - `BuildSkillCatalogPrompt([]skills.Skill) string` and `BuildSkillCatalogPromptWithReport([]skills.Skill) (string, SkillCatalogReport)` in `internal/ai/prompts` build the `<available_skills>` system prompt XML block with name, description (capped at 1024 runes on clean UTF-8 rune boundaries), and location.
   - Skills with `disable-model-invocation: true` are excluded from the catalog prompt and the tool's parameter enum.
   - Omitted completely when 0 invocable skills exist or when the `skill` tool is not offered in the turn.
   - Merged into the turn's system prompt via `MergeSystemPrompt`.
   - Turn data events (`em.Data("skill-catalog-truncation", ...)`) report if description or catalog bounds trip.

2. **Tier 2 Dynamic Activation Tool (`skill(name)`):**
   - Registered as `tools.NameSkill = "skill"`, toolkit `skill`, risk class `RiskRead` (auto-approved under all permission modes, including `plan`, `interactive`, `edit`, and `auto`).
   - Parameters dynamically typed with an enum of all discovered invocable skill names.
   - Thread-safe `ActivationSet` tracks activations without data races.
   - Execution strips YAML frontmatter, formats into `<skill_content name="...">`, attaches skill directory path and relative-path guidance, and lists bundled resources (capped at 32 with a notice when exceeded).
   - Deduplicated per turn: invoking an already-active skill returns a clear `"Skill <name> is already active in this turn."` message.
   - Emits turn data event `em.Data("skill-activation", ...)` on execution.

3. **Explicit User & Agent Mentions:**
   - `{type: "skill", name: "<skill-name>"}` supported across `mentionDTO`, `client.Mention`, and `ChatMentionSchema` (`src/types/chat.ts`).
   - Mention resolution injects `<skill_content>` into the system prompt before the first model call and emits `em.Data("skill-activation", ...)` event.
   - Explicit mentions intentionally bypass `disable-model-invocation: true` (a manual selection is an explicit human instruction to use that skill).
   - Unknown skill mentions return a visible error rather than failing silently.

4. **Thread-Safe Workspace Sandbox Expansion (Read-Only Roots):**
   - `Workspace` enhanced with mutex protection (`sync.RWMutex`), `readOnlyRoots []string`, `Clone() *Workspace`, `WithReadOnlyRoots`, `AddReadOnlyRoots`, `ReadOnlyRoots()`, `ResolveReadable()`, and `RelReadable()`.
   - Handlers derive a per-turn clone (`activeWS = h.workspace.Clone()`) so server-lifetime workspace instances are never mutated across turns.
   - Shared single pointer across `toolDeps`, `permission.Engine`, and `onActivateSkill`, ensuring model-activated skills are immediately readable even when the turn also carries a mention.
   - Modifying tools (`edit.go`, `git.go`, `plan.go`, `lsp.go`) strictly retain `Resolve` (bounded to `w.root`).
   - Read-only tools (`files.go` for `read_file`/`list_dir`, `search.go` for `globTool`/`grepTool`, `repomap.go` for `repo_map`) call `ResolveReadable`/`RelReadable`.
   - `permission.Engine.evaluateRiskRead` uses `ResolveReadable`, while `RiskWrite` uses `Resolve`.

5. **Compaction Retention:**
   - `compaction.Compact` explicitly preserves `<skill_content>`-bearing messages during history summarization so active skill instructions survive long turns.

6. **Subagent Delegation:**
   - `subagentToolNames` in `internal/api/chat/subagent.go` includes `tools.NameSkill: true`, allowing read-only child subagents to load and use skills during investigations.

---

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **`prompts/skills.go`** | `backend-go/internal/ai/prompts/skills.go` | `BuildSkillCatalogPrompt` and `BuildSkillCatalogPromptWithReport` for `<available_skills>` XML injection with rune truncation and reports. |
| **`prompts/skills_test.go`** | `backend-go/internal/ai/prompts/skills_test.go` | Unit tests for catalog formatting, limits (1024 runes/256 entries), UTF-8 rune boundary slicing, and `disable-model-invocation` filtering. |
| **`tools/skill.go`** | `backend-go/internal/ai/tools/skill.go` | `skillTool` definition, thread-safe `ActivationSet`, frontmatter stripping, `FormatSkillContent`, deduplication, and resource enumeration. |
| **`meta/sandbox_guard_test.go`** | `tests/suites/meta/sandbox_guard_test.go` | Inverted allowlist AST static analysis guard ensuring only `files.go`, `search.go`, and `repomap.go` call `ResolveReadable`, with non-vacuous test against synthetic `delete.go`. |

---

### Tests Added & Updated

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend | `tests/suites/backend/skills/` | 27 | Complete Phase 0 discovery suite + Phase 1 activation suite: system prompt catalog present/omitted, frontmatter stripping, bundled resource reading, write rejection outside workspace, auto-approval across all modes (`plan`, `interactive`, `edit`, `auto`), deduplication per turn, mention injection before first call, mention bypassing disable-model-invocation, unknown skill mention error, mention + model-activation combination, multi-turn read-only root isolation, enum rejection without model round-trip, compaction retention |
| meta | `tests/suites/meta/` | 4 | Inverted allowlist sandbox guard (`TestSandboxGuard_ModifyingToolsNeverUseResolveReadable` + `TestSandboxGuard_IsNonVacuous`), plus `TestSkillsSourcesGuard` and route coverage |
| backend unit | `backend-go/internal/agent/workspace/` | 5 | Mutex-protected `ResolveReadable`, `Clone`, and concurrent `-race` test (`TestWorkspace_ConcurrentAddAndResolve_Race`) |
| backend unit | `backend-go/internal/ai/tools/` | 6 | Skill tool parameter enum, mention + model activation resource readability, concurrent `-race` test (`TestSkillTool_ConcurrentActivation_Race`), filter survival |
| backend unit | `backend-go/internal/agent/compaction/` | 3 | Verbatim survival of `<skill_content>`-bearing messages during compaction |
| backend unit | `backend-go/internal/api/chat/` | 4 | Skill mentions resolution, per-turn workspace isolation, gated catalog prompt assembly, subagent tool availability |

---

## 2. What Diverged from the Plan, and Why

1. **`tools.Deps` workspace binding vs. non-existent `tools.Toolset`:**
   *What happened:* `docs/skills/02-activation.md` referenced adding read-only roots to a `tools.Toolset` type. Amiro has no `Toolset` type; file tools are constructed per request by `buildToolDeps` via `tools.Deps.Workspace *workspace.Workspace`.
   *What changed:* Placed `ReadOnlyRoots` on `tools.Deps`, wired `WithReadOnlyRoots`/`AddReadOnlyRoots` on `*workspace.Workspace`, and passed the roots into `tools.Deps`.

2. **Separate `ResolveReadable` method on `Workspace`:**
   *What happened:* The initial instinct was to expand `(*workspace.Workspace).Resolve` to check `readOnlyRoots`.
   *What changed:* Kept `Resolve` strictly bounded to `w.root` to guarantee modifying tools (`edit.go`, `git.go`, `plan.go`, `lsp.go`) cannot touch files outside the workspace root even when a skill is active. Added `ResolveReadable` and called it only from `files.go`, `search.go`, and `repomap.go`.

3. **Per-turn Workspace isolation (`Clone()`):**
   *What happened:* mutating `activeWS` directly modified `h.workspace` when no project directory was specified, leaking read-only roots across requests.
   *What changed:* Added `Clone() *Workspace` and derived per-turn instances in `runner.go`, ensuring server-lifetime workspace roots remain isolated across turns.

4. **Thread-Safe `ActivationSet` & `Workspace.mu` Concurrency:**
   *What happened:* Concurrent tool execution during turn steps created potential data races on map and slice mutations.
   *What changed:* Guarded `Workspace` with `sync.RWMutex` and implemented thread-safe `ActivationSet` (`sync.RWMutex` protected).

5. **Mention resolution structure reuse:**
   *What happened:* The plan suggested adding a new mention DTO struct.
   *What changed:* `mentionDTO` and `client.Mention` already carry `Type` and `Name` fields and required no Go struct changes. The only type change needed was adding the `z.literal("skill")` variant to `ChatMentionSchema` in `src/types/chat.ts`.

6. **Tool filter `alwaysOffered` semantics:**
   *What happened:* Custom agent tool filtering (`tools.Filter`) drops tools not in the agent's allowlist.
   *What changed:* Placed `ToolkitSkill` in `alwaysOffered`, allowing `skill` to survive explicit allowlists and default tool branches unless specifically restricted.

7. **Synchronous skill tool activation in scheduler:**
   *What happened:* When a model emitted `skill` and `read_file` in the same step, `read_file` (parallel) ran before `skill` (sequential queued for `Finish`), causing permission checks for bundled resources to fail.
   *What changed:* Updated `tool_scheduler.go` to execute `NameSkill` synchronously inside `Offer`, binding the read-only roots immediately before subsequent tool calls in the same step are evaluated.

8. **Inverted Allowlist AST Sandbox Guard:**
   *What happened:* The initial sandbox guard used a denylist of known modifying tool filenames, which could fail to catch new modifying tool files.
   *What changed:* Inverted the AST guard to an explicit allowlist (`files.go`, `search.go`, `repomap.go` only).

9. **Catalog Prompt Gated on Skill Tool Offered:**
   *What happened:* The catalog was constructed before tool filtering and was unconditionally injected into the prompt even if the `skill` tool was unoffered.
   *What changed:* Gated `catalogPrompt` on `tools.FindByName(activeTools, tools.NameSkill) != nil`.

10. **Rune-Boundary Truncation & Turn Data Events:**
    *What happened:* Description slicing at byte offsets could split multi-byte UTF-8 runes.
    *What changed:* Truncated descriptions on rune boundaries (`[]rune`) and added turn data events (`em.Data("skill-activation", ...)` and `em.Data("skill-catalog-truncation", ...)`).

---

## 3. Exit Criteria (Verbatim from the Phase 01 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `amirotest run --surface backend --feature skills` passes in under 60s. | ✅ MET | Passed 31/31 tests in 10.6s. |
| 2 | A test asserts the system prompt contains `<available_skills>` with the exact name and description of a planted skill, and that the section is **absent** when no skills exist. | ✅ MET | `TestSkills_SystemPrompt_CatalogPresentAndOmittedWhenEmpty` asserts both branches against the provider request. |
| 3 | A test asserts `skill("nonexistent")` is rejected by the enum without a model round-trip. | ✅ MET | `TestSkills_Activation_UnknownNameRejectedByEnumWithoutModelRoundTrip` verifies `tools` schema restricts `enum` strictly to discovered skills. |
| 4 | A test asserts `read_file` succeeds on a file inside an activated skill's directory and `write` on the same path is refused. | ✅ MET | `TestSkills_Activation_BundledResourceRead` and `TestSkills_Activation_WriteRejected` verify readable resource access and write containment refusal. |
| 5 | A test asserts a `{ type: "skill" }` mention injects the body before the first model call, using the fake provider's recorded request. | ✅ MET | `TestSkills_Mention_ExplicitInjectionBeforeFirstModelCall` verifies `<skill_content>` presence in `LastRequestBody()`. |
| 6 | A test drives a thread through `/compact` and asserts the `<skill_content>` block is still present afterwards. | ✅ MET | `TestSkills_Activation_SkillContentSurvivesCompaction` and unit test `TestCompact_KeepsSkillContentMessagesVerbatim` assert survival. |
| 7 | `go test ./suites/meta/... -v` passes, new sandbox guard included, proven non-vacuous. | ✅ MET | `TestSandboxGuard_ModifyingToolsNeverUseResolveReadable` and `TestSandboxGuard_IsNonVacuous` pass cleanly. |
| 8 | `amirotest run` is green overall, `suites/meta` included, with every skip reasoned. | ✅ MET | Full suite passed: 280 passed, 0 failed, 18 reasoned skips in 3m 0s. |

---

## 4. Standards Compliance

- **No time-based flakiness:** All tests use event-driven synchronization with zero arbitrary sleeps.
- **Zero test pollution:** Every test isolates its own workspace and home directories via temporary roots.
- **Strict sandbox boundaries:** Modifying tools are strictly isolated from read-only roots by compile-time and AST-guarded design.
- **All tests pass:** 31 feature tests, all meta guards, full unit suites, and full test runner suite pass cleanly.
