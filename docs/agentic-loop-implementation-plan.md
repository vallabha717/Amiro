# Amiro — Agentic Loop & Tooling Implementation Plan

_Plan for closing §4 "Agent capabilities & tools" from [openworker-vs-amiro-feature-comparison.md](./openworker-vs-amiro-feature-comparison.md). Written 2026-08-16 after a web survey of current agent scaffolds and the ACI literature._

---

## Part 0 — Where Amiro actually stands today

Read before planning anything. The current loop is [`backend-go/internal/api/chat/tool_loop.go`](../backend-go/internal/api/chat/tool_loop.go) (313 lines):

| Property | Current state | Why it blocks a strong agent |
|---|---|---|
| Step cap | `maxToolSteps = 10` | A real repo task needs 30–150 steps. Hard ceiling. |
| Tool execution | **Sequential, inline in the stream hook** — `runToolCall` runs synchronously inside `OnToolCallReady` | Reading 5 files costs 5 serial round trips. Parallel reads are structurally impossible without refactoring this. |
| Tool set | `visualization`, `webSearch`, `http`, `terminal` (`tools.Defaults()`) | No file read, no edit, no glob, no grep. The agent cannot see the codebase. |
| Permission model | None. `terminal.go` executes shell unguarded | Adding file-write + shell without a gate is a security regression, not a feature. |
| Context management | None | 30-step sessions will blow the window with no recovery. |
| State between steps | Messages array only | No workspace state, no file-read ledger, no todo list. |
| Tool result rendering | **Two disconnected paths.** Chat has per-tool renderers (`tool-invocation/*.tsx`, dispatched by name in `message-parts.tsx`). Workflow has **one generic path** — `NodeResultPopup` dumps raw `JsonView` in a dialog | A 40-step agent session is unreadable if each step is a JSON blob. At-a-glance comprehension is a *correctness* feature here, not polish — it's how a user catches a wrong edit before it compounds. |

**Conclusion:** this is a chat tool-loop, not an agent loop. §4 is not "add some tools" — it's a rebuild of the loop with tools layered on top, *plus* a rebuild of how tool results are shown. Plan accordingly.

---

## Part 1 — What to reference, and why

### The four sources that should drive the design

| # | Reference | What to take from it | Link |
|---|---|---|---|
| 1 | **SWE-agent — "Agent-Computer Interfaces Enable Automated Software Engineering"** (NeurIPS 2024) | The foundational thesis: **tool ergonomics dominate model choice**. Same model, better ACI = large jumps in resolve rate. Specific transferable ideas: windowed file viewing, the edit command that **runs a linter and rejects syntactically-invalid edits before applying them**, concise environment feedback. Read `docs/background/aci.md` in the repo — it's the design rationale, not just API docs. | [paper](https://arxiv.org/abs/2405.15793) · [ACI docs](https://swe-agent.com/latest/background/aci/) |
| 2 | **OpenHands SDK** — "A Composable and Extensible Foundation for Production Agents" | The **architecture** to copy. Core idea: *an agent is a pure function from event history to next event, run in a loop.* Stateless `Agent` emits `Action`s; a `Conversation` runs the loop and owns an append-only `EventLog`; a `Workspace` executes actions and returns `Observation`s. Nothing calls anything else directly — UI, agent, and runtime all read/append to one chronological log. Consequences you want: every run is replayable by construction, the UI is agent-agnostic, and pause/resume/approval is a natural insertion point. | [SDK paper](https://arxiv.org/html/2511.03690v1) · [events docs](https://docs.openhands.dev/sdk/arch/events) · [repo](https://github.com/OpenHands/OpenHands) |
| 3 | **Charmbracelet Crush** | **The single most directly portable codebase — it is Go.** Amiro's backend is Go, so Crush is the reference implementation you can read and adapt line-for-line rather than transliterate from Python/TS. Take: the tool package layout (`internal/agent/tools/`, each tool = one `.go` + one `.md` description file — self-documenting, prompt lives next to the code), SQLite session persistence, multi-provider abstraction, LSP integration for context, MCP over stdio/HTTP/SSE. | [repo](https://github.com/charmbracelet/crush) · [DeepWiki architecture](https://deepwiki.com/charmbracelet/crush) |
| 4 | **Claude Code tool design** (parallel tool use + subagents) | The **concurrency and context model**. Multiple `Read`/`Glob`/`Grep` calls issued in one assistant turn and executed concurrently, results merged before the next reasoning step. Subagents run in an isolated context window and return **only a final text result** — none of their intermediate reads pollute the parent context. This is the answer to "read multiple files at once" *and* to context bloat, and it's one mechanism, not two. | [parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) · [subagents](https://code.claude.com/docs/en/agents) |

### Secondary references — read, don't necessarily copy

| Reference | Use it for | Link |
|---|---|---|
| **Aider** | Repo-map (tree-sitter ranked context selection), and the most battle-tested multi-file edit-format work. Still the strongest all-around OSS coding agent for multi-file editing + git. | [repo](https://github.com/Aider-AI/aider) · [unified diffs writeup](https://aider.chat/docs/unified-diffs.html) |
| **mini-swe-agent** | The SWE-agent team now recommends this **over** SWE-agent — same performance, radically simpler. Best proof that a strong loop does not need a large framework. Good sanity check against over-engineering. | [repo](https://github.com/SWE-agent/mini-swe-agent) |
| **Live-SWE-agent** | Current top open scaffold: **79.2% SWE-bench Verified** with Opus 4.5. Its trick is self-evolution — the agent writes its *own* custom tools as executable scripts at runtime on top of a bash-only base. Worth knowing; **do not build this first.** It's a Phase 5+ idea. | [leaderboard/site](https://live-swe-agent.github.io/) |
| **"Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures"** | Cross-agent comparison of Aider/SWE-agent/OpenHands/AutoCodeRover/Agentless on exactly the axes you're deciding: file ops, search, shell, edit mechanism, context filtering, parallel calls, sub-agents. Its explicit builder recommendations line up with this plan: explicit tool semantics, aggressive context filtering, support both sequential and parallel paths, modular sub-agents. | [arXiv 2604.03515](https://arxiv.org/pdf/2604.03515) |
| **Diff-XYZ (JetBrains)** | Benchmark on edit-format understanding. Key finding: **no single edit format dominates across models**; unified diff was worst in their Pass@1 runs *and* highest token cost. | [arXiv 2510.12487](https://arxiv.org/html/2510.12487v1) |
| **"Your Code Agent Can Grow Alongside You with Structured Memory"** | For the memory piece (Tier 2 of the parity doc) once the loop exists. | [arXiv 2603.13258](https://arxiv.org/pdf/2603.13258) |
| **Confucius Code Agent** | Scaffolding for large real-world codebases; 74.6% SWE-bench Verified on Sonnet 4, above OpenHands. Good source of localization ideas. | [arXiv 2512.10398](https://arxiv.org/pdf/2512.10398) |

### Recommended stack

> **Architecture from OpenHands (event-sourced loop) · tool ergonomics from SWE-agent's ACI · Go implementation patterns from Crush · concurrency + subagent context model from Claude Code · edit format and repo-map from Aider.**

Do **not** adopt LangGraph/CrewAI/Semantic Kernel. They're Python/.NET orchestration frameworks; Amiro's loop is Go and already owns its streaming, persistence, and provider layer via Bifrost. A framework here would be a rewrite that buys nothing.

---

## Part 2 — Design decisions to settle before coding

### 2.1 Edit format — recommend **anchored SEARCH/REPLACE**, not unified diff

The literature genuinely conflicts here and you should know it rather than be surprised later:

- Aider's own benchmark found unified diffs raised GPT-4 Turbo from 20% → 61% and made it "3X less lazy."
- JetBrains' Diff-XYZ found the opposite direction on newer models: unified diff **worst** on Pass@1 and highest token cost.
- The taxonomy work reports **exact string matching is more reliable than line-number-based or unified-diff editing** for LLM-generated patches.

Resolution: the Aider result is a 2023-era GPT-4 finding about *laziness*, largely solved by modern models. Line numbers are the real failure mode — they drift the moment any earlier edit lands. **Go with exact-string anchored SEARCH/REPLACE** (what Claude Code and current Aider both effectively ship), plus:

- Require the SEARCH block to be **unique** in the file; error with the match count if it isn't. Force the model to widen its context rather than guess.
- **Reject the edit if the result doesn't parse** — SWE-agent's single highest-leverage ACI trick. Go: `go/parser`. TS/JS: run the project's own tooling. Fall back to a bracket/indent sanity check for other languages.
- Return a **compact diff of what actually changed** as the observation, not the whole file.

### 2.2 Parallel tool execution — the core refactor

Today `runToolCall` runs inline in `OnToolCallReady`, so tool N+1 waits for tool N. Change to:

1. **Collect** tool calls during the stream (keep `ToolInputStart`/`Delta` streaming to the UI so cards still appear live — this is the UX property worth preserving).
2. At step end, **partition** by side-effect class: read-only tools (`read_file`, `glob`, `grep`, `list_dir`, `web_search`) → `errgroup` with a concurrency cap (8 is a reasonable start). Mutating tools (`edit_file`, `write_file`, `run_shell`) → strictly sequential, in the order the model emitted them.
3. Merge results **in the model's original call order** before the next step, regardless of completion order — non-deterministic ordering in history will degrade the model's reasoning.

This is exactly the "support both sequential and parallel execution paths" recommendation from the taxonomy paper, and it's what makes "read multiple files at once" real.

### 2.3 Multi-file reading — three mechanisms, not one

| Need | Mechanism |
|---|---|
| Read 5 known files | Parallel `read_file` calls in one turn (§2.2) |
| Find the right files in a large repo | `glob` + `grep` (ripgrep-backed) + Aider-style **repo map** injected into the system prompt |
| Explore without polluting context | **Subagent** with its own context window returning only a summary (§2.4) |

`read_file` must be **windowed** — offset/limit, with a default cap (~2000 lines) and a truncation notice. Unbounded reads are how agents die.

### 2.4 Subagents — the context-management primitive

Following the Claude Code model: a `task` tool spawns a child loop with its own `EventLog`, its own (typically read-only) tool subset, and its own context window. The parent receives **only the final text**. This is both the parallelism story and the context story — treat it as one feature.

### 2.5 Permission gating — non-negotiable, ships *with* the tools

The moment `edit_file`/`write_file` land, the existing ungated `terminal.go` becomes a much bigger liability. Port OpenWorker's model ([`coworker/permissions.py`](../../openworker/coworker/permissions.py), [`coworker/risk.py`](../../openworker/coworker/risk.py)):

- **Risk class per tool**: `read` / `write` / `external`.
- **Modes**: Plan (read-only) · Interactive (auto-approve reads, ask on writes/commands) · Auto (allow, still path-scoped).
- **Path scoping** to an explicit workspace root; **command-prefix allowlists**; **reject any shell command containing metacharacters** from allowlist auto-run (`;`, `&&`, `|`, backticks, `$(`) — one allowlisted command must not become several.
- The event-sourced loop makes this clean: a pending `Action` is a natural suspend point.

### 2.6 Context management

The 10-step cap is currently doing context management by accident. Once it's raised: port OpenWorker's [`compaction.py`](../../openworker/coworker/compaction.py) approach — when the outbound history nears the limit, replace the older portion with an LLM-written structured summary + mechanically-extracted state, keeping recent turns and **all user messages**. Never modify the persisted transcript; compact only what's sent to the model.

### 2.7 Every default tool ships with a presenter — chat card **and** workflow node

**Rule: a tool is not done until you can tell what it did at a glance, in both surfaces.** No tool merges with a raw-JSON fallback.

#### The pattern to follow — terminal, as it exists today

[`terminal-invocation.tsx`](../src/components/tool-invocation/terminal-invocation.tsx) is the model, and its shape is the important part: **52 lines of thin adapter** on top of a **414-line reusable presentational component** ([`ui/terminal-window.tsx`](../src/components/ui/terminal-window.tsx)). The adapter does only three things:

1. Pulls `part.input` (the command) and `part.output` (cwd, exit code, output text).
2. Derives a **status tri-state** — `pending` / `error` / `success` — from `part.state.startsWith("output")`, `part.errorText`, and `exit_code !== 0`.
3. Hands both to a dumb component that owns all the visuals.

That split is what makes it reusable across surfaces. Keep it for every new tool: **the presentational component must not know whether it's inside a chat message or a workflow node.**

#### The gap on the workflow side

Chat already has per-tool renderers; workflow does not. Today:

- [`default-node.tsx`](../src/components/workflow/default-node.tsx) renders a per-*kind* summary stack on the node face (`LLMNodeDataStack`, `HttpNodeDataStack`, `ToolNodeStack`, …) — so the "inline summary on the node body" pattern exists.
- But **every** tool collapses into one generic `ToolNodeStack`, and results open as [`node-result-popup.tsx`](../src/components/workflow/node-result-popup.tsx) — a dialog with input/output tabs rendered as raw `JsonView`.

So `grep`, `edit_file`, and `run_shell` would all look identical on the canvas. That's the thing to fix.

#### Proposal — one shared tool-presenter registry, three render slots

Create `src/components/tool-presenters/` exporting a registry keyed by tool name. Both surfaces consume it; neither owns its own switch statement.

```ts
interface ToolPresenter {
  icon: LucideIcon;
  // One line, ~60 chars. The at-a-glance answer. Rendered on the workflow
  // node face and as the collapsed chat card header.
  glance(input, output, status): string;
  // Node-sized: fits in a ~280px workflow node body. No scrolling.
  Compact: FC<{ input; output; status }>;
  // Full chat-message card, and the workflow result dialog body.
  Expanded: FC<{ input; output; status }>;
}
```

| Slot | Used by | Constraint |
|---|---|---|
| `glance` | Workflow node face; collapsed chat card | Single line, no wrap, degrades to tool name |
| `Compact` | Workflow node body; chat card when collapsed | Fixed height, no internal scroll |
| `Expanded` | Chat message card; workflow `NodeResultPopup` body | Scrollable, full detail |

Three changes wire it up:

1. **Extract the status tri-state** into a shared helper. Chat derives it from `ToolUIPart.state`/`errorText`; workflow derives it from `NodeRuntimeHistory.status`/`error`. One `ToolRunStatus` type, two adapters — so presenters take a status, never a surface-specific object.
2. **`message-parts.tsx`**: replace the growing if/switch chain (~L887–930) with a registry lookup, keeping the existing `dynamic()` import behavior for heavy presenters (`interactive-table` is 526 lines — don't regress that).
3. **`node-result-popup.tsx`**: when a presenter exists for the node's tool, render `Expanded` instead of `JsonView`; keep `JsonView` behind a "Raw" tab. And render `Compact`/`glance` on the node face via a new `ToolNodeStack` branch in `default-node.tsx`.

Existing renderers (`web-search`, `code-executor`, charts, `image-generator`) get folded into the registry as they're touched — not as a big-bang refactor.

#### Glance line + node visual per new tool

This is the spec for Phase 2. Each `glance` must answer *"what changed / what was found"*, never *"a tool ran"*.

| Tool | `glance` line | `Compact` node visual | Status derivation |
|---|---|---|---|
| `read_file` | `src/lib/utils.ts · 120 lines` | File chip + line range; "truncated at 2000" badge when windowed | error if unreadable |
| `list_dir` | `src/components/ · 24 entries` | Dir chip + entry count, file/folder split | — |
| `glob` | `**/*.tsx · 47 matches` | Pattern + match count, first 3 paths | 0 matches = warning, not error |
| `grep` | `"runToolCall" · 3 hits in 2 files` | Hit count + per-file breakdown, one preview line | 0 hits = warning |
| `write_file` | `+ created tool_loop_v2.go · 210 lines` | Path + created/overwritten badge + line count | — |
| `edit_file` | `tool_loop.go · +12 −4` | **Diff strip** — green/red bar with counts, first changed hunk | **error on failed anchor match — must be visually loud** |
| `multi_edit` | `tool_loop.go · 3 edits · +40 −18` | Stacked diff strips, one per edit, atomic-applied badge | all-or-nothing outcome |
| `run_shell` | `go test ./... · exit 0` | **Reuse `TerminalWindow` unchanged** | existing exit-code logic |
| `git` | `git commit · 3 files staged` | Subcommand + affected-file chips | — |
| `task` (subagent) | `explored auth flow · 12 steps` | Child step count + returned summary, expandable to child log | child's terminal status |
| `todo` | `4 done · 2 pending` | Checklist with strikethroughs | — |

Two that carry the most weight:

- **`edit_file` is the one to get right first.** It's the only tool that silently corrupts work. Its `glance` must show `+N −M` and its failed-anchor state must be unmissable in both surfaces — a user scanning a 40-step run needs to spot the one edit that didn't land.
- **`run_shell` reuses `TerminalWindow` as-is.** It's already surface-agnostic. This is the proof the registry approach works — if the first tool needs no new presentational component, the abstraction is right.

#### The work log — collapsing a whole turn

Presenters answer "what did this step do". The work log answers "what did this *turn* do", which is the question that actually matters once a turn is 40 steps long.

An assistant turn that used tools renders as:

```
▸ Worked for 1m 12s          ← collapsed by default once finished
Here's what changed: …        ← the final answer, always visible
```

Expanded, it is a chronological feed where consecutive calls of the same kind fold into one row:

```
▾ Worked for 1m 12s
  ▸ Explored 3 files
      src/lib/utils.ts · 120 lines
      src/lib/format.ts · 8 lines
      "slugify" · 2 hits in 1 file
  ▸ Ran 2 commands
  ▸ Edited 2 files
      utils.ts · +12 −4
      ⚠ edit failed · format.ts
```

Design rules, and why:

- **The split point is the last tool call.** Everything before it is *how* the answer was reached; everything after is the answer. A turn with no tool calls renders exactly as before — a plain chat reply must not grow a "Worked for 0s" header.
- **Collapsed rows still show their glance lines.** Folding to just "Explored 3 files" hides the one fact worth scanning for. The glance lines come straight from the presenter registry, so this needed no new per-tool code.
- **Auto-collapse fires once.** After that the user's choice sticks, or the component fights them on the next render.
- **Duration is measured, never guessed.** A reloaded thread has no start time, so its header reads `Worked · 7 steps` rather than inventing an elapsed figure.
- **Grouping is by what the user was told happened**, not by tool identity (`lib/ai/tools/step-kind.ts`) — `read_file`, `glob` and `grep` are three tools but one idea.

Files: `src/components/work-log.tsx`, `src/lib/ai/tools/step-kind.ts`, and the partition in `message.tsx`.

#### Approval cards use the same presenters

Phase 3's approve/deny card must show the *same* `Compact` view as the eventual result. A user approving an `edit_file` needs to see the diff they're approving, not a JSON argument blob. Building the registry in Phase 2 is what makes Phase 3's approval UI nearly free.

---

## Part 3 — Phased implementation

### Phase 1 — Loop rebuild _(foundation; nothing else works without it)_ — **landed 2026-08-16; the inversion completed 2026-08-17**

1. ✅ **Types landed 2026-08-16; the inversion landed 2026-08-17.** Introduce `Action` / `Observation` / `EventLog` types in a new `internal/agent/` package (OpenHands model). The `EventLog` becomes the source of truth; the persisted parts array becomes a *projection* of it. — `internal/agent/session/`, projected by `internal/api/chat/parts.go`.
2. ✅ Refactor `runToolCall` out of `OnToolCallReady`: stream tool-input deltas live, but **collect** calls and execute after step end. — `tool_scheduler.go`
3. ✅ Add the parallel/sequential partitioned executor (§2.2) with a concurrency cap + original-order merge. — `tools.Concurrency` declares per-tool side-effect class; `maxParallelToolCalls = 8`. Used a semaphore + `WaitGroup` rather than `errgroup`: a failing tool must record an error outcome and let the others finish, not cancel its siblings.
4. ✅ Replace `maxToolSteps = 10` with a step + wall-clock budget. — `loopBudget{MaxSteps: 150, Wall: 15m}`
5. ✅ Add a `Workspace` abstraction: explicit root, path normalization, symlink-aware containment. — `internal/agent/workspace/`. The `.gitignore`-aware lister moves to Phase 2, where `list_dir` consumes it.

**Done when:** ✅ the existing 4 toolkits still work unchanged through the new loop, and parallel tool calls in one turn demonstrably run concurrently (`tool_scheduler_test.go`, race-clean); ✅ the persisted parts array *is* `partsFromLog(log.Events())` rather than a second accumulation that happens to agree (`TestToolLoop_PersistedPartsAreTheProjectionOfTheLog`).

Notes on the inversion, landed 2026-08-17:

- **The feared rewrite of persistence never happened, because there was nothing to rewrite.** The deferral note assumed the inversion meant changing `route.go` and `models.ChatMessage`. It did not: `route.go` already received the whole array as one value (`loopResult.Parts`) and only persisted it, so the entire change is contained in the loop, the scheduler, and one new projection function. The cost was overestimated because the boundary was better than the note remembered.
- **Ordering is now an explicit rule instead of an emergent one, and that is the real win.** The log is appended in the order things *happen* — tool calls at offer time, mid-stream, before the step's text is even known — while the user was shown the text first. Projecting in log order would have reordered every tool-using turn in every existing thread, which is precisely the bug this tree has already shipped once (from the mirror-image mistake). So the projection sorts by step, then by a named within-step rank: compaction → reasoning → text → tool calls in call order → approval requests. Before, that order was whatever the sequence of `append` calls in the loop happened to produce; it is now a stated contract with a test that fails when it is removed.
- **`TestToolLoop_PersistedPartsGolden` was written *before* the change and is the proof it is safe.** It captures a multi-step, multi-tool turn's persisted array byte-for-byte from the pre-inversion code, and the post-inversion projection reproduces it exactly. A refactor of the thing that renders every historical thread needed evidence, not care.
- **Two deliberately-lossy fields had to become lossless, and the reasoning inverted with the log.** `Action.Text` was clipped to 400 characters and the observation carried a 200-character summary instead of the tool's output, on the grounds that "the transcript already holds the full text". Once the transcript is projected *from* the log, a clip there is a clip in the saved conversation. The memory objection does not survive either: the parts array held those same bytes, in the same request, for the same duration — they moved rather than being added.
- **`Suspended` is a flag, not a status.** A suspended call has an outcome *and* the property that nothing further happened: a client-executed tool is `StatusOK` and unfinished, one awaiting approval is `StatusDenied` and unfinished. Folding those into the status enum would force a choice between recording why a call stopped and recording that it stopped, and the projection needs both — it checks `Suspended` first, because a status read first would render a call the turn is still waiting on as one that produced a result.
- **The scheduler lost a field, which is how you can tell the inversion is real.** `toolCallOutcome.part` and the scheduler's `approvals` slice are both gone: a call now describes itself in exactly one place, and the approval request rides on its own observation rather than in a parallel list.
- **The old drift test could not be deleted, but it could stop being load-bearing.** `TestToolLoop_EventLogAgreesWithThePersistedParts` proved only "these two structures currently agree about this one scenario", which holds right up until someone appends to one and not the other on a path no test covers. It is kept because it states the invariant in the terms a reader will look for, and superseded by the projection-identity test, which fails for *any* turn where the two could differ.



### Phase 2 — Core file ACI — **landed 2026-08-16**

Following Crush's layout — one `.go` + one `.md` per tool in `internal/agent/tools/`:

| Tool | Notes |
|---|---|
| `read_file` | Windowed (offset/limit), line-numbered output, truncation notice, binary detection |
| `list_dir` | `.gitignore`-aware, depth-capped |
| `glob` | Pattern → paths, sorted by mtime |
| `grep` | ripgrep-backed, with `-A/-B` context and a match cap |
| `write_file` | Whole-file create/overwrite; refuses outside workspace root |
| `edit_file` | Anchored SEARCH/REPLACE, uniqueness check, **syntax validation before apply**, diff observation (§2.1) |
| `multi_edit` | N edits to one file applied atomically — all or nothing |

All read tools declared **parallel-safe**; all write tools **sequential**.

✅ All seven landed in `internal/ai/tools/{files,search,edit}.go`. Notes on what differed from the plan:

- **`grep` is Go/RE2, not ripgrep-backed.** Shelling out to `rg` means a runtime dependency the desktop app cannot assume is installed, and a silent capability difference between machines. `regexp` + `WalkDir` is deterministic everywhere and needs no probe-and-fallback path.
- **`list_dir`'s `.gitignore` support is deliberately partial** — no negation, no `**` across segments, no nested ignore files. Documented at the type. Missing one costs a stray listing entry; containment (the thing that would actually matter) is `workspace.Resolve`'s job, not the ignore matcher's.
- **The syntax gate only covers Go and JSON.** Those have parsers in the stdlib. A false rejection is worse than a missed catch — the model can recover from a build error but cannot argue with a tool that refuses to write — so unrecognized extensions pass through unchecked.
- **File tools are opt-in**: they only exist when `BETTERCHATBOT_WORKSPACE_ROOT` is set. `Defaults(nil)` omits them entirely rather than defaulting to the process working directory.

Alongside the tools, the presenter layer from §2.7 — **built in the same pass, not after**:

8. ✅ `src/components/tool-presenters/` + `ToolRunStatus` and its two adapters (`statusFromToolPart`, `statusFromNodeHistory`).
9. ✅ `message-parts.tsx` consults the registry first, falling through to the existing `tool-invocation/` dispatch. Older renderers (charts, web search, terminal, image) migrate as touched — a big-bang refactor would risk regressing `interactive-table` (526 lines, `dynamic()`-imported) for no immediate gain.
10. ✅ `node-result-popup.tsx` renders `Expanded` when a presenter exists, with `JsonView` behind a new "raw" tab; `tool-node-config.tsx`'s `ToolNodeStack` shows the glance line on the node face once a node has run. `execute-tab.tsx` resolves `nodeId → node.data.tool.id`, since `NodeRuntimeHistory` records the node but not the tool.
11. ✅ A presenter per file tool. `run_shell` still uses `TerminalWindow` through the old path — it needs no presenter, which was the point of the exercise.

**Done when:** ✅ 30 backend tests green (containment, windowing, gitignore, glob `**` semantics, anchor uniqueness, syntax gate, `multi_edit` atomicity); `tsc`, `biome` and 219 frontend tests clean. Still to verify by hand: a real multi-file edit session end to end — see the test prompts below.

### Phase 3 — Safety, and only then shell — **landed 2026-08-16**

1. ✅ Risk classification + permission engine + path scoping (§2.5). — `internal/ai/tools/risk.go`, `internal/agent/permission/`
2. ✅ **Retrofit the existing `terminal.go` behind it** — this closes a live gap, don't defer it.
3. ✅ Approval UI: extend `message-parts.tsx`'s approval rendering into a real approve/deny/always-allow card; persist session allowlists. **It renders the presenter's `Compact` view** (§2.7) — approving an `edit_file` shows the diff, not raw arguments.
4. ✅ Git tool (`git status/diff/log/add/commit`) — gated as `write`, with its presenter.

**Done when:** ✅ Plan mode provably cannot mutate the filesystem (`TestPlanMode_RefusesEveryConsequentialRiskWithoutAsking`, `TestToolLoop_PlanModeRefusesAndTellsTheModelWhy`), a shell command with `;` in it always requires approval (`TestCommandAllowlist_RejectsShellMetacharacters`), and no approval prompt shows raw JSON (`presenters.test.ts` asserts a `Compact` view for every gated tool).

Notes on what differed from the plan, and the decisions worth knowing:

- **`tools.Concurrency` is now derived, not declared.** `Definition.Concurrency()` returns `Parallel` iff `Risk == RiskRead`, and the hand-maintained field is gone — OpenWorker's `engine.py` derivation, which the parity doc called the better design. One consequence is real and was accepted: `http` is `RiskExternal` (the model picks the method and body), so parallel HTTP fetches now serialize.
- **`RiskUnclassified` is the zero value and the *most* restrictive.** Forgetting to classify a tool costs an approval prompt, never a silent hole. `TestDefaults_EveryToolDeclaresRisk` keeps built-ins out of that state; it exists for the dynamically-loaded definitions (MCP, workflows) whose provenance we genuinely cannot vouch for.
- **Interactive mode allows `RiskExternal` rather than asking.** Every MCP tool is External, MCP servers are already user-configured and per-tool toggleable, and prompting for each would make the feature unusable. Plan mode *does* deny External — "read-only" must not mean "reads no local files while posting to Jira". Routing External to a considered approval is the Inbox work in Tier 2.
- **Approval rides the existing client-tool pause, not a new rail.** The suspended call stays in `input-available`, the loop stops, and the AI SDK resubmits the assistant message once the user answers — `resolveApprovals` (`approvals.go`) then runs the approved call server-side and replaces the confirmation with the tool's real result. A held-open request waiting on an `/approve` endpoint would have needed session state, would not have survived a reload, and would have had to be reconciled with this path anyway. What is new is a persisted `data-tool-approval` part: `input-available` alone cannot tell "waiting for the browser" from "waiting for a human".
- **The approval card renders outside the work log.** The suspended call is by construction the last thing the turn did, so it lands inside a log that auto-collapses; a prompt you have to expand a section to find reads as a hung turn.
- **"Always allow" is session-scoped and, for commands, exact.** Grants live in a per-thread `permission.Store` on the handler (the round trip spans two requests) and die with the process — a standing grant that outlives its conversation is one the user has stopped being able to see. Approving `go test ./...` grants that command line, not the shell.
- **The default command allowlist is tiny and all reads.** `go build`/`go test`/`npm run` are deliberately absent: each executes project code, which is indistinguishable from running an arbitrary program. A user can add them; the default must not decide it for them.
- **`git` is one tool with a fixed subcommand allowlist**, not a passthrough. `push`/`pull`/`reset`/`rebase`/`checkout`/`clean` are absent — the first reach the network, the rest destroy uncommitted work. It renders itself as a command line (`Definition.CommandLine`) so one allowlist covers it and the shell, which is what keeps `git status` from prompting forever despite the tool being `RiskWrite` as a whole.
- **The shell session is now per workspace root, not per process.** Found while gating it: a single global executor seeded from whichever request arrived first left `cwd` pointing at another thread's directory.
- **`run_shell`/`terminal-execution` migrated into the presenter registry**, since the approval card needs a `Compact` view that renders from *input* alone — a card built from `output` has nothing to say at the moment it matters most. `TerminalWindow` is still used unchanged for `Expanded`.

### Phase 4 — Context & scale — **landed 2026-08-16**

1. ✅ `todo` tool + panel (OpenWorker's `tools/todo.py`; also how Claude Code keeps long tasks coherent). — `internal/ai/tools/todo.go`
2. ✅ Auto-compaction (§2.6). Emit a **visible compaction marker** in both surfaces — a silent context drop is the kind of thing users need to see to trust the transcript. — `internal/agent/compaction/`, `internal/api/chat/compact.go`
3. ✅ Subagent `task` tool with isolated context (§2.4). — `internal/api/chat/subagent.go`
4. ✅ **Landed 2026-08-16, without tree-sitter.** Aider-style **repo map** for large-repo orientation. — `internal/agent/repomap/` + the `repo_map` tool. Go is parsed with `go/parser`; every other language with anchored line patterns. Ranking is personalized PageRank over the file/symbol graph, the same design Aider uses.

**Done when:** ✅ a turn whose history exceeds the budget continues instead of failing, and says so on screen; a subagent's reads provably never enter the parent's context (`TestSubagent_ReturnsOnlyItsFinalTextToTheParent`); the plan survives across turns in a thread; a repo map ranks the file everything depends on above the leaf that mentions it once (`TestBuild_RanksByDependenceNotJustMentionCount`).

Notes on what differed, and the decisions worth knowing:

- **A fifth risk class, `RiskSession`, and the split it forced.** A todo write mutates the agent's own bookkeeping and nothing else. Gating it would produce an approval card on every plan revision — unusable, and worse, it trains the user to click through cards unread, which degrades the Phase 3 gate that actually matters. But it is *not* parallel-safe: two writes to one list race and last-write-wins silently drops half the plan. So `Risk.Consequential()` and `Definition.Concurrency()` are no longer the same predicate. They agreed for read/write/exec/external, which made it tempting to treat "needs approval" and "must not overlap" as one question; they are two — *who else is affected* versus *does this commute with itself*.
- **Compaction runs per step, not per turn.** A turn that reads thirty files does most of its growing *inside* itself, so a per-turn check measures the history before the growth that caused the problem.
- **The summarizer uses the turn's own model, not a cheap one.** The summary becomes the agent's only memory of the first half of its own run — it is the one call whose output the model will trust unconditionally, and a weaker model's version of "what was learned about this codebase" is where a long turn silently goes wrong.
- **A failed summary is not a failed turn.** The token estimate is a character heuristic and deliberately cautious, so the full history may well still fit. Compaction failing closed would turn an optimization into an outage.
- **Every user message survives compaction verbatim**, re-inserted after the summary. They are the smallest and most load-bearing part of a history — summarizing "use tabs, not spaces" into "the user gave formatting preferences" is how an agent forgets its own task. `TestCompact_KeepsEveryUserMessageVerbatim` is the guard.
- **Token estimation is chars/4, and named an estimate.** A real tokenizer would mean one per provider family, kept in sync with model releases, to decide a threshold that only needs to be approximately right. What matters is that it is monotonic in what it bounds.
- **The subagent's tool subset is read-only, and that is load-bearing.** A child runs unwatched — no cards, no approval prompts, nothing in the transcript until it is done. Giving that loop write or exec access would undo Phase 3 through the side door. It also runs under the *parent's* permission engine rather than a permissive one: its tools are all reads so nothing should ever be gated, but a child holding a weaker engine is precisely the shape of a privilege escalation.
- **Recursion is prevented structurally, not by a depth counter.** `task` is not in the child's subset, so a subagent cannot spawn one. `TestSubagent_CannotSpawnASubagent` asserts it.
- **The subagent's `Expanded` view is the returned summary, not a child event log.** The plan called for expanding into "the child's own event log" — but the child's steps genuinely do not exist outside the server, which is the entire point of the feature. Rendering the prompt alongside the answer is the honest version: without the prompt a reader cannot judge whether the answer addresses the right question. A real child log would require persisting the child's history, which trades away the context saving that justifies subagents at all.
- **`Defaults(ws)` became `Defaults(tools.Deps{…})`.** Three call-site dependencies and counting; the struct's contract is that every field absent means "that toolkit is not offered", never "substitute a default".
- **The repo map landed without tree-sitter, which was the thing blocking it.** Every Go tree-sitter binding is cgo, and this cross-compiles to six installer formats — turning cgo on is a packaging decision, not a tooling one. The resolution was to notice that the *parser* was never the requirement: Go gets `go/parser` from the standard library, and every other language gets line-anchored patterns. Those find declarations, not a parse tree, and the honest framing is that this is acceptable **for this artifact specifically** — a map is a navigation aid whose next step is always reading the real file, so a missing entry costs one grep and a spurious one costs one read. Compare `edit_file`'s syntax gate, which refuses to write on a parse failure and therefore covers only the two languages with real parsers in the standard library: precision is worth paying for where being wrong is expensive, and not where it is cheap.
- **Ranking is personalized PageRank, not a reference count.** A count answers "how many files mention this", which over-rewards the utility module everything touches shallowly. `Options.Focus` biases the personalization vector toward the words in the task, which is what makes "map me the auth code" a different answer from "map me the repo" — the globally-highest-ranked file in any repo is some shared types package, which is true and useless when the question was about authentication.
- **Test files are demoted, not excluded.** They rank high on the raw graph (they reference the code they test heavily and nothing references them) and a map opening with four `_test.go` files has answered "what is this repo about" with "testing". Excluding them would be wrong the other way: "where are the tests for the permission engine" is a real question. `testFileWeight = 0.25`.
- **A live bug this work surfaced: the Phase 4 plan tools were never reachable.** `todo_write`/`todo_read` are in the `todo` toolkit, `Filter` drops any toolkit missing from the request's `allowedAppDefaultToolkit`, and the frontend always sends an explicit list that no UI ever put "todo" on. The tools existed, their unit tests passed, and the model was never offered them. Fixed by exempting the toolkit (`alwaysOffered`) with the reasoning that the allowlist is a *user-facing capability* switch and an agent's own bookkeeping is not a capability in that sense. `TestFilter_KeepsThePlanToolsRegardlessOfTheAllowlist` guards it. `memory` is deliberately *not* exempt — see Phase 5.

### Phase 5 — Optional / research — **LSP and memory landed 2026-08-16; self-evolving tools declined**

1. ✅ **LSP integration** for real symbol context. — `internal/agent/lsp/` + the `lsp` tool (definition / references / symbols / diagnostics).
2. ⛔ **Self-evolving custom tools à la Live-SWE-agent — not built, and not a scheduling decision.** See below.
3. ✅ **Structured long-term memory.** — `internal/agent/memory/` + `memory_write` / `memory_read` / `memory_forget`, workspace-scoped, injected into the system prompt.

**Done when:** ✅ `lsp references` finds a use of a symbol in a file that never names the symbol's package (`TestGopls_FindsReferencesAcrossFiles`, against real gopls); a machine with no language server is never offered the tool (`TestDefaults_DoesNotOfferLSPWithoutAPool`); a note written in one conversation is in the next conversation's system prompt, and a note about one workspace never reaches another (`TestOpen_ScopesMemoriesToTheWorkspace`).

Notes on what differed, and the decisions worth knowing:

- **LSP is optional in a way the repo map is not, and the difference is what happens when it is missing.** A language server is an external binary the desktop app cannot assume — the same objection that kept ripgrep out of `grep` and tree-sitter out of the repo map. But there, the tool *was* the capability, so a missing binary would have meant a core tool that worked on the developer's machine and not the user's. Here it accelerates questions the agent can already answer with `grep` and `repo_map`, so absence costs precision rather than the ability. Discovery is therefore opportunistic and silent: no server found means the tool is never offered, and the model is never told about something that would fail on its first call.
- **The protocol is tested against an in-process fake server, not against gopls.** A protocol implementation whose only test needs a language server installed is untested on any machine without one, including CI — and a test that silently skips is worse than no test, because it reports green. `Conn` therefore takes an `io.ReadWriteCloser` rather than an `*exec.Cmd`. The gopls tests exist too, as a supplement: what a fake cannot confirm is that the handshake this code sends is one a real server accepts. That distinction earned its keep immediately — the fake-server test for result shapes caught a decoding bug where a `LocationLink` array unmarshals into `[]Location` *without error*, leaving every field zero, so the check had to be on the decoded content rather than on the error.
- **Diagnostics distinguish "clean" from "not analysed yet", and that is the whole reason the operation is trustworthy.** They are pushed, not requested, so both are an empty list on the wire — and they are opposite answers to the question the agent is asking. Reporting them as the same thing is how a tool tells an agent its broken edit compiled. `Server.Diagnostics` returns a `received bool`, and the presenter renders the two differently.
- **A project marker is searched two levels below the workspace root, and the server is started where the marker was found.** The first implementation checked only the root, which is wrong for the most common real layout there is — *this* repository has `package.json` at the top and `go.mod` in `backend-go/`, so it found no Go project and the `lsp` tool silently never appeared. That is the "not offered rather than broken" design failing by accident rather than by choice, which is the one way it must not fail. Rooting gopls at the repository instead of at the module would not have helped: it answers nothing useful from there.
- **Language servers are discovered on PATH *and* in `~/go/bin`, `~/.local/bin`, `~/.cargo/bin`.** On macOS and Linux a windowed app inherits the session PATH, not the login shell's, so exactly the directories `go install` and `pip install --user` write to are routinely absent. Without this the feature would work when a developer runs the binary from a terminal and silently not work for a user who launched it from the dock.
- **A server is only started when the language is actually used here.** Extension matching alone would spawn a Python language server for one stray `.py` script in a Go repository, so `ServerSpec.RootMarkers` requires `go.mod`, `package.json`, `Cargo.toml` and so on.
- **Memory writes are `RiskWrite`, and this is the one place the `RiskSession` argument deliberately does not carry over.** A todo affects the current turn and the user watches it happen; a memory silently changes how the agent behaves in every future conversation about this workspace and appears in no transcript afterwards. A wrong memory is an invisible, persistent behavioural bug — exactly the kind of thing a human should have seen once. The card frequency is fine because memories are rare, unlike plan revisions.
- **Memories are injected into the system prompt, not fetched by a tool.** A memory the model has to remember to look up is not memory; it will skip the lookup precisely on the turns where it already thinks it knows the answer, which are the turns a stale assumption costs most. `memory_read` exists for searching past the injection budget. The injected block frames them as recollections rather than fact, because the model has no other way to tell a note it wrote three weeks ago from something the user just said.
- **Memories live in the app data directory, not in the repository.** Writing agent notes into the user's tree would put them in `git status` and get them committed by accident. They are scoped per workspace root, because "we use pnpm" is a fact about one repository and carrying it into another is how an agent becomes confidently wrong about a project it has never seen.
- **Dedup is exact-on-normalized-text and nothing cleverer.** Fuzzy matching would merge "the tests are `pnpm test`" with "the tests are `pnpm test:e2e`", and a memory silently replaced by a similar-looking wrong one is far worse than two memories that nearly agree. Repeating a fact bumps `UpdatedAt`, which is what keeps it alive through eviction: reinforcement, not age, is the signal a memory is still true.
- **`memory` is a real toolkit with a real toggle, unlike `todo`.** The Filter exemption above is for the agent's own bookkeeping; durable notes that change future behaviour are a capability a user should be able to switch off, so `AppDefaultToolkit.Memory` appears in the dropdown with labels in all seven locales.

#### Why self-evolving custom tools were not built

This one is declined rather than deferred, and the reason is not effort.

A self-evolving tool system means the agent writes code and that code is then executed as a tool. Everything Phase 3 built assumes the opposite: that the set of things the agent can do is fixed and classifiable *before* the turn starts. `Risk` is a static property of a `Definition`; the permission engine decides from that class plus the mode; the command allowlist reasons about a command line it can see. A tool the agent authored during the run has no honest risk class — `RiskUnclassified` is the correct answer, which means every call needs approval, which means the user is approving code they would have to read to evaluate. That is the exact failure mode Phase 4 refused for the todo tool: an approval prompt the user cannot meaningfully answer trains them to click through the ones they can.

There is also a narrower point. Amiro already has a JS/Python code-execution sandbox and a gated shell. An agent that needs to do something the toolkit does not cover can already write a script and run it — visibly, through a gate, without becoming a permanent capability nobody classified. That covers most of what "self-evolving tools" is for, at a fraction of the risk.

Worth revisiting if two things change: an audit trail (Tier 3 of the parity doc) so authored tools leave a record, and a way to bound what generated code may reach that is stronger than "the user said yes once".

### Phase 6 — Plan review, the task panel, and the walkthrough — **landed 2026-08-17; in-place plan editing added 2026-08-17**

The last open item of §4 was Tier 2 #7's remainder: a **propose-plan-then-approve** contract. Plan mode refused writes and nothing more, so its output was prose in the chat and no decision point. Two adjacent gaps closed with it — the todo list existed but lived inside a work log that auto-collapses, and nothing summarized a finished turn at all.

The shape is Google Antigravity's: an Implementation Plan, a Task List and a Walkthrough shown as **artifacts** in a review pane, with inline comments and a Review/Proceed header ([plan](https://antigravity.google/docs/implementation-plan) · [artifact review](https://antigravity.google/docs/artifact-review) · [walkthrough](https://antigravity.google/docs/walkthrough)).

1. ✅ `propose_plan` — suspends the turn so a human can answer it. `internal/ai/tools/plan.go`
2. ✅ `walkthrough` — end-of-turn summary: what changed, in reading order. Same file.
3. ✅ `prompts.BuildPlanContractPrompt` — the positive half of Plan mode: *finish by proposing a plan*.
4. ✅ The artifact pane — `src/components/artifacts/`, sharing the wide pane the Workflow View established.
5. ✅ The Workflow View halts on the plan node and resumes from it. `chat-graph/`, `derive-chat-graph.ts`.

**Done when:** ✅ a Plan-mode turn ends in a document the user can comment on and approve; the graph stops on it and continues from it; the task list survives the work log collapsing; a finished turn explains itself. `plan_test.go`, `use-artifacts.test.ts`, `plan-anchors.test.ts`, and the derive-graph assertions below.

Notes on what differed from the sketch, and the decisions worth knowing:

- **`propose_plan` has no server-side executor, and that *is* the mechanism.** A `Definition` with a nil `Execute` is already left in `input-available` by the scheduler, which stops the loop and hands the call to the browser — the rail client-executed tools and Phase 3's approval cards both ride. The user's decision arrives as the tool's result and the turn resumes from exactly that call. Nothing new persists, nothing new suspends, and reload survival comes free because the parts were already saved with the turn.
- **It is deliberately *not* routed through the permission engine.** "A human must sign off on this document" is a property of one tool; `Risk` is what decides whether *any* tool may run. Expressing this as a risk class would have meant the engine special-casing a tool name, which puts a UI contract inside the thing that decides what the agent is allowed to do. `propose_plan` is `RiskSession` — proposing a plan changes nothing outside the conversation, and a plan the user rejects has still cost nothing.
- **The halt in the Workflow View needed no machinery.** `deriveChatGraph` is a pure function of `messages`, and a suspended turn produces no further messages, so the graph stops on the gate by construction. What it needed was **honesty**: a suspended call sits in `input-available`, which the old derivation read as "still going", so the node showed a spinner. A spinner on a node that is waiting for *you* says "be patient" when the true message is "nothing happens until you answer". Hence a fourth `ChatGraphNodeStatus`, `waiting`, and `TestDeriveChatGraph` asserting a suspended plan never derives as `running`. The `isSuspendingTool` allowlist keeps client-executed tools out of it — those also sit in `input-available` but resolve on their own in a second, and repainting every mid-flight sandbox call as "blocked on you" would make the state meaningless.
- **Auto-follow latches onto the gate, rather than auto-follow being disabled.** Merely focusing the newest node once is not enough: a late measurement, a re-layout or a resize re-frames the viewport and the decision scrolls away with nothing on screen explaining why the run stopped. Pinning is also what makes resuming right — when the answer lands the pin clears, the next node is focused normally, and the run visibly continues *from* the gate instead of refitting the whole thread.
- **Proceed changes the permission mode, and names the mode on the button.** Approving a plan means "go do this", and Plan mode refuses every write, so proceeding without a mode change leaves the agent refused on its first real step — which reads as a bug, not a policy. It restores `modeBeforePlan` rather than picking one: someone who works in Manual and drops into Plan to think should land back in Manual and keep approving individual writes. Promoting them to Edit because it is more convenient would grant, on their behalf, exactly the permission Phase 3 exists to make them grant deliberately. The button reads *"Proceed in Manual"* — a permission change the user did not read is a permission change they did not make.
- **Artifacts are a projection of the transcript, never state of their own.** The plan, the task list and the walkthrough are all read back out of message parts (`use-artifacts.ts`), the same move `message.tsx` already made for pending approvals. Three consequences, and each is the reason: a reload finds them again; they cannot drift from what happened, because there is one record and this reads it; and nothing new persists. The artifact-store design would have created a second account of one turn — the exact cost Phase 1's un-inverted EventLog is still paying.
- **The plan is markdown; the task list is not.** They look like the same data and are not. A plan is a document a human reads and argues with, so it needs headings and tables and prose — and one markdown body makes every comment anchor a text range in one place. A task list is machine-updated state with three legal statuses, revised eight times a turn. Merging them would have forced the plan through a schema or the todo list through a parser.
- **Comments anchor to quoted text, not to a position.** A block index or character offset is invalidated by any edit above it, which is every revision — and the agent revises *in response to the comments*, so the document has always moved by the time the user sees their note again. A quote survives reordering, and it is also the only form the model can act on: "on «X»: your note" is a complete instruction, "on block 4" is not. The block hash is carried alongside but used only to decide where to *draw* the comment, so a reworded block still shows it.
- **A quote that vanished is shown as outdated, not dropped.** A comment disappearing looks like the app lost it. What actually happened is that the agent answered the objection by deleting the thing objected to — which is the answer, and the one the user most needs to see and confirm.
- **Comment drafts live in `sessionStorage`, not on the server.** An unsent comment is a draft; once sent it rides the tool result into the transcript, and that copy is the one worth keeping. Durable drafts would mean an objection written weeks ago resurfacing against a plan that has since changed, with no way for the user to tell a fresh comment from a stale one. Session scope covers the case that actually happens — a reload, or a tab left open while the user goes to read the code the plan is about.
- **The walkthrough's cross-check is client-side, and it checks the workspace's own record rather than the model's.** The tool validates and echoes; the presenter compares the summary against the turn's *successful* `edit_file`/`write_file`/`multi_edit` calls and names files that changed without being explained. Doing it in the executor would have meant a per-session ledger of edited paths maintained by the write tools — new mutable state for a check the frontend can do from parts it already holds. Failed edits are excluded deliberately: flagging a file that was never written trains the reader to ignore the flag, which is the only thing keeping it useful.
- **Proceed appears in three places and is implemented once.** The artifact header, the card in the chat stream, and the halted graph node all call `usePlanDecision`. The user may be looking at any of the three when they decide, and three copies of "write the tool result, then change the permission mode" is three chances to forget the second half — the half that decides what the agent may do next.
- **Both tools are exempt from the toolkit allowlist** (`alwaysOffered`), for the reason the todo tools already are, with higher stakes: Plan mode's entire contract is "finish by proposing a plan", so an allowlist that silently drops `propose_plan` produces a mode that can never reach its own end state. This is the bug that hid the Phase 4 plan tools for a whole phase, and `TestFilter_*` now covers all four names.
- **A subagent can never call `propose_plan`, and the reason is sharper than "it is not a read tool".** A nil-executor tool inside a child loop has nobody to answer it: nothing about a child renders until it returns, so the pause would never resolve, the child would burn its budget waiting and the parent would block behind it. `subagentToolNames` is an explicit allowlist, so this is prevented structurally rather than by a rule someone has to remember — the same argument as `task` not being in its own subset. `TestSubagent_CannotProposeAPlan`.
- **Two existing tests changed meaning rather than being relaxed.** `TestDefaults_EveryToolHasExecute` became `…ExceptProposePlan` and asserts the exception *by name*, because a blanket "some tools may lack an executor" would let a genuine omission through, and the symptom of that is a turn that hangs forever. The two `Filter` tests were passing only because `Defaults(Deps{})` has no todo store; the plan tools need none, so the exemption became visible and is now asserted directly.
#### Editing the plan in place — landed 2026-08-17

The `propose_plan` result always carried an optional `plan` field for a user-edited version and the model was always told to follow it when present; nothing in the UI wrote it. This was deferred deliberately, with the argument that a comment leaves the fix to the agent while a direct edit makes the user silently responsible for a document's internal consistency they cannot check. The note ended "the UI stays comment-only until there is a reason it must not"; the field is now written. — `plan-anchors.ts`, `use-plan-edits.ts`, `commentable-markdown.tsx`, `plan-artifact.tsx`, `use-artifacts.ts`.

- **Editing is per block, and the alternative was the obvious one.** A single textarea holding the whole plan is a much smaller change and the wrong one: every comment anchors into this document, and swapping the rendered plan for a source editor takes all of them off screen at the moment the user is deciding what to change. The anchors would still resolve on save — the user would simply be editing blind, which is exactly how someone deletes the sentence their own comment was about without noticing. Per-block editing also keeps the deferral's real concern proportionate: correcting one row of a file table hands the user one row to keep consistent, not the whole document.
- **The question the deferral left open — do an edit and a comment coexist? — is answered: both apply.** They are different instructions. A comment says "this is wrong, and here is why", which the agent acts on with its own judgement about what else must change. An edit says "this part now reads this way". A user who fixes a path by hand and objects to a phase's approach in a comment has said two true things, and the tool result carries both.
- **A comment whose quote the user edited away goes `outdated` through the existing mechanism, not a new one.** Anchoring runs against the *edited* document (`applyEdits` feeds `commentsByBlock`), so such a comment fails to find its quote and reports outdated by exactly the same path as one the *agent* rewrote away. One rule covers both, which is the point: a second "the user invalidated this" state would be one more thing to keep in step with the first, and the two would eventually disagree.
- **Outdated still means shown, not dropped** — the Phase 6 rule, unchanged. "I deleted the thing I was objecting to" is still an objection, and a comment that silently vanished would read as the app losing it.
- **A deleted block stays on screen as a tombstone with a Restore action.** Clearing a block's text deletes it, which is the natural gesture and needed no separate control; but a block that vanishes on save leaves no way back and no way to see what the document used to say there. Excluded from the markdown that gets sent, present in the view — the same split the outdated comments already use.
- **An edit identical to the original is recorded as no edit, and this is what keeps the field meaningful.** The model is told that a `plan` field means the user rewrote the plan and that version is authoritative. A field present on every approval — because someone opened a block, read it, and closed it — would make that instruction worthless on the turns it matters. `hasEdits` compares against the agent's text rather than counting overrides.
- **Edits are session-scoped drafts, keyed by tool call id**, exactly like comment drafts and for the same reason. Keying on the call id is what makes a *revised* proposal start clean: the agent's second plan is a new call, so edits made to the version the user rejected cannot reappear half-applied on the plan written to replace it.
- **`buildPlanDecision` became a pure function.** The payload is the contract with the model — `plan.go`'s `planDecision` is its other half — and it previously existed only as an object literal inside a hook's callback, which in a project with no jsdom and no testing-library meant it could not be tested at all. The field whose absence is invisible is precisely the one worth asserting.
- **Only the artifact pane can send an edit, and "nothing" has to keep meaning "the agent's version stands".** The chat card and the halted graph node offer Proceed on a plan they only summarize, so they pass no edited plan. Hence an optional argument rather than an empty string: an empty string is a plan the user deleted entirely, and the field cannot mean both.

- **Motion is deliberately thin.** The pane and the chat column transition on one curve and one duration (`--ease-drawer`, 240ms) so they read as one movement; the gate breathes on a slow 2s cycle in amber rather than reusing the running pulse, because two states must not be told apart only by tempo; the task list crossfades colour only, since it updates many times inside a turn and anything that moved layout would make status data jump under the reader's eyes. Click-to-open is not animated at all — it mounts on the same commit, because the entire point of the interaction is getting the document in front of the user. Rejected: staggered entrances on walkthrough rows and task items (decoration on data being read), per-node arrival animation (the canvas already moves the viewport for 400ms), and any overshoot on the pane — `--ease-spring` exists, and bounce belongs to motion a gesture threw, not to a panel that arrived from a click.

---

## Part 4 — Evaluation — **harness landed 2026-08-16; SWE-bench adapter landed 2026-08-17**

`internal/agent/eval/` + `cmd/eval`. Run it with:

```
go run ./cmd/eval -suite evals/smoke.json -json /tmp/before.json
go run ./cmd/eval -swebench evals/swebench/verified-subset.json -json /tmp/before.json
```

It exits non-zero when any task is unresolved, so it works as a CI gate, and the JSON report is the artifact worth keeping — comparing two runs is the entire point and a terminal summary is not diffable.

The harness is the task format, the runner, the scoring, the report, and an `Agent` interface at the boundary with `chat.EvalAgent` as the adapter onto the real `runToolLoop`. The SWE-bench adapter (`internal/agent/eval/swebench/`, pinned by `cmd/swebench-pin`) materializes an instance into a workspace directory and a verify step; it added one extension point to the harness and duplicated none of it.

Three decisions inside it worth knowing:

- **Scoring reads the workspace, never the agent's account of itself.** `TestRunner_ScoresByTheWorkspaceNotByWhatTheAgentSays` is the guard, and it is the difference between a benchmark and a survey.
- **The fixture is copied into a fresh temporary workspace per task.** A task that mutates its own fixture passes on the first run and fails afterwards, and diagnosing that costs far more than the copy.
- **Verification still runs after a timeout.** An agent that solved the task and then spent its remaining budget admiring the result has solved the task; scoring that as a failure measures the budget rather than the agent.

The metrics, and why these and not just resolve rate:

- **SWE-bench Verified subset** (50–100 instances) as the regression gate. Full 500 is expensive; a fixed subset catches scaffold regressions fine.
- Current reference points for calibration: Live-SWE-agent + Opus 4.5 = **79.2%**; Confucius + Sonnet 4 = **74.6%**; OpenHands was the strongest official OSS entry as of Dec 2025.
- Track per-phase: resolve rate, **mean steps to completion**, tokens per task, and failed-edit rate (the last is the sharpest signal on whether the ACI is working). All four come out of `Report.Summary()`.
- **The means are over resolved tasks only**; the failed-edit rate is over every task including the failures. A task that burned 150 steps failing would drag the mean toward "how long do failures take", which moves opposite to the thing being tracked — but a task that failed *because* its edits kept missing is the single most important data point the edit metric has.
- **Failed edits come from the event log** (`internal/agent/session`), which is why Phase 1 item 1 had to land first: a rejected `edit_file` and a crashed `run_shell` are both an error string on the wire, and averaging them together hides both. `classifyToolError` separates them on the convention that a tool refusing prefixes its own name.
- Expect Phase 1+2 alone to be worth more than any model upgrade — that's the SWE-agent thesis, and it's the reason to do the ACI work properly rather than fast.

### The SWE-bench adapter — landed 2026-08-17

`internal/agent/eval/swebench/` turns a pinned instance into an ordinary `eval.Task` plus one registered scorer. The pinned subset is seven instances spanning seven repositories (`evals/swebench/verified-subset.json`, 324K), which is the "prove the plumbing before scaling" step; growing toward the 50–100 instance gate is re-running `cmd/swebench-pin` with more ids and changes no code.

- **The dataset ships far more than the plan assumed, and it removed the hard part.** Each Verified instance carries an `image` (a prebuilt container with the repo checked out at `/testbed` and its dependencies installed) and an `eval_script` (the benchmark's own test invocation). So the per-instance environment never has to be reconstructed from `environment_setup_commit` and a version table — which was the piece that genuinely needed a Python toolchain. The remaining Python dependency is *inside* the image, where it belongs.
- **The data is fetched once and vendored, never fetched at run time.** A regression gate compares two runs, so the tasks must be the same tasks; a suite that re-fetches depends on a third-party service being up and on the dataset not being revised underneath it. `cmd/swebench-pin` is run deliberately and its output is committed, so a change to the benchmark is a diff someone approved. 500 instances × parquet on HuggingFace is not a file that ships with the benchmark, which is why this needed answering at all.
- **The workspace rides `Task.Fixture`, the harness's existing per-task copy.** The adapter materializes each instance's tree into a cache directory and points the task's fixture at it; the runner's "copied into a fresh temporary workspace per task" path then does what it already did. The property the plan flags — a task that mutates its own fixture must not affect later runs — is preserved by exactly the mechanism the smoke suite relies on. What the adapter changes is where the bytes come from, never how they are isolated.
- **Scoring reads the workspace, and for SWE-bench that means git.** The patch is `git diff HEAD` over the tree the agent left behind, with `add -N` so a new file counts. Not the `edit_file` calls it made, not its own account: an agent that reports six edits and made none produces an empty patch and scores zero. This is `TestRunner_ScoresByTheWorkspaceNotByWhatTheAgentSays` applied to the real benchmark.
- **A patch goes back in, not a directory.** That is the benchmark's own contract — SWE-bench evaluates a `model_patch` against a pristine checkout — and it also avoids scoring whatever else the agent left lying around: build artifacts, a virtualenv, a test file it deleted.
- **Everything crosses the container boundary as a tar stream, and this was found the hard way.** The first version used `docker cp` to a host path and a `-v` bind mount, both of which ask the *daemon* to resolve a host path. The integration test failed on the first real run against a snap-confined docker (`invalid output path: directory /tmp/... does not exist`), which is also the nastiest possible shape of failure: it looks like a broken checkout rather than a misconfigured daemon. Streaming through the CLI's stdin/stdout makes the transfer depend only on the pipe, so rootless, snap, remote and VM-backed daemons all behave identically.
- **Result parsing covers pytest and unittest — 425 of the 500 instances — and declines the rest by name.** The benchmark ships a per-repository log parser because each project formats results differently. Ten of the twelve repos emit pytest's format (194 instances); django emits unittest's (231), and supporting it was not optional: a subset drawn only from the pytest repos would exclude the single most-represented project in the benchmark. sympy's runner (75) matches neither and is refused at load, because an instance whose log cannot be read scores unresolved and is indistinguishable in a report from an agent that failed. Same choice `edit_file`'s syntax gate makes.
- **`MISSING` is a distinct status from `FAILED`, and it is what makes the parser trustworthy.** "The test ran and failed" and "the test never ran, or its output could not be read" are opposite diagnoses — one is about the patch, the other about the harness. A parser that quietly stopped understanding a repo would otherwise report every instance as an agent failure, at a number that looks entirely plausible. A log with nothing recognizable in it is reported as its own condition rather than as "everything failed".
- **A skip is not a pass.** Counting one would let a patch that disables the failing test score as a fix.
- **A patch that will not apply is reported separately from a patch that is wrong.** It is a scaffold or edit-format problem — the thing the failed-edit metric exists to surface — and folding it into the resolve rate hides it.
- **The end-to-end proof asserts both directions.** `TestIntegration_...` (opt-in via `SWEBENCH_INTEGRATION=1`; skipped otherwise so `go test ./...` stays hermetic) materializes a real instance, checks that an untouched workspace produces an empty patch and scores **unresolved**, then applies the gold patch *through the workspace* and checks it scores **resolved**. The second direction alone would be satisfied by a scorer that says yes to anything; the first alone by one that says no. Verified against `astropy__astropy-12907` in 27s.

---

## Part 5 — Risks

| Risk | Mitigation |
|---|---|
| Parallel execution reorders history non-deterministically | Merge strictly in model call order; never in completion order |
| Raising the step cap explodes context | Phase 4 compaction is not optional once Phase 1 lands — sequence them close together |
| Shell + file write shipped before gating | Phase 3 is a hard dependency of Phase 2 reaching users; ship them together behind a flag if needed |
| Edit-format churn | Pick anchored SEARCH/REPLACE, instrument failed-anchor rate, revisit only on data |
| Scope creep into a framework rewrite | mini-swe-agent is the counter-example: strong results, minimal scaffold. Bifrost stays the provider layer |
| Presenters deferred as "polish" and never built | Make it a merge gate: no tool ships with a JSON fallback. The cost compounds — retrofitting 11 presenters later is far worse than one per PR, and Phase 3's approval UI depends on them |
| Presenter registry drifts from the Go tool list | Tool names are already shared constants (`DefaultToolName` ↔ `tools.Name*`). `presenters.test.ts` asserts every gated/registered backend tool has all three slots |
| Compaction quietly loses the instruction the run is answering | Every user message survives verbatim, asserted by test. Never modify the persisted transcript — compact only what is *sent* |
| Subagents become an ungated execution path | The child's subset is read-only *and* it runs under the parent's permission engine. Two independent reasons, because either alone is one edit from being wrong |
| A tool exists, its tests pass, and the model is never offered it | Happened, to the Phase 4 plan tools: `Filter` dropped a toolkit no UI ever put on the allowlist. Unit tests cannot catch it because the tool works perfectly in isolation. `TestFilter_*` now asserts the wiring, not just the tool |
| The event log and the persisted parts drift apart | **Closed 2026-08-17.** There is one record: the parts array is `partsFromLog(log.Events())`. `TestToolLoop_PersistedPartsAreTheProjectionOfTheLog` asserts the identity rather than an agreement, and `TestToolLoop_PersistedPartsGolden` holds the projected output byte-identical to what the pre-inversion code wrote |
| A language server's absence becomes a silent capability difference | The `lsp` tool is not offered at all when no server is found, so the model never learns about a capability it does not have. The repo map is the always-present floor underneath it |
| Long-term memory accumulates a confident wrong fact | Notes are framed as recollections rather than fact in the prompt, `memory_forget` exists and is described as preferable to leaving a stale note, writes are approval-gated, and the store is a readable file at a path the tool result names |
| The artifact pane and the transcript disagree about what was proposed | The pane is a *projection* of message parts, not a second store — there is nothing to disagree with. This was the one place the Phase 1 inversion's lesson got applied up front rather than paid for later; as of 2026-08-17 the loop applies it too |
| A suspended plan renders as "running" and the user waits for an agent that is waiting for them | `waiting` is a distinct `ChatGraphNodeStatus` and the derivation is asserted (`TestDeriveChatGraph` — a suspended `propose_plan` must never derive as `running`). The failure is silent and indistinguishable from a slow turn, which is why it needs a test rather than care |
| Proceed grants a permission the user did not realize they were granting | The button names the mode it restores, and it restores the one they were last in rather than choosing a more permissive default |
| A comment survives onto a plan that no longer says what it objected to | Anchors are quoted text; an anchor whose quote is gone renders as **outdated** rather than silently re-attaching somewhere plausible. Drafts are session-scoped so none outlives its conversation. Since 2026-08-17 this covers the user's *own* edits too: anchoring runs against the edited document, so a quote the user retyped away goes outdated by the same path, with no second mechanism |
| A benchmark reports the harness's own breakage as agent failures | SWE-bench instances are validated at load, an unreadable result format is refused by name rather than scored, a test absent from the log is `MISSING` rather than `FAILED`, and a patch that would not apply is reported separately from a patch that was wrong. Each of these otherwise looks exactly like an agent that tried and failed |
| The SWE-bench gate silently drifts from the published benchmark | The subset is fetched once and committed (`cmd/swebench-pin`), so a change is a reviewed diff; scoring runs the instance's own `eval_script` in its own image rather than a guessed test command; and the end-to-end test asserts a gold patch resolves *and* an empty patch does not |

---

## What is still deferred, and why

Two things from this plan are deliberately not done. Neither is a scheduling accident.

_(The EventLog inversion and in-place plan editing were both deferred here and both landed 2026-08-17; the SWE-bench adapter landed the same day. Their notes now live with their phases — Phase 1, Phase 6, and Part 4 respectively.)_

**Self-evolving custom tools (Phase 5 item 2).** Declined, with the argument written out under Phase 5. Short version: a tool the agent authored mid-run has no honest risk class, so every call would need an approval the user cannot meaningfully evaluate — and the existing code sandbox plus gated shell already cover most of what the feature is for, visibly and through a gate.

**An artifact review *policy* (Phase 6).** Antigravity offers "Request review" versus "Always proceed" as a setting. Amiro has the equivalent already, and it is the permission mode: Plan mode is "request review", and the other three modes leave `propose_plan` available but not required. A second, independent switch would let a user be in Plan mode *and* auto-proceeding — a mode whose entire purpose is stopping to ask, configured not to. If a standing "don't ask me" is wanted later, it belongs in the mode dropdown next to the others, not beside it.

---

## Sources

- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering (arXiv 2405.15793)](https://arxiv.org/abs/2405.15793) · [ACI design docs](https://swe-agent.com/latest/background/aci/)
- [The OpenHands Software Agent SDK (arXiv 2511.03690)](https://arxiv.org/html/2511.03690v1) · [OpenHands events architecture](https://docs.openhands.dev/sdk/arch/events)
- [charmbracelet/crush](https://github.com/charmbracelet/crush) · [Crush architecture on DeepWiki](https://deepwiki.com/charmbracelet/crush)
- [Claude parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) · [Claude Code subagents](https://code.claude.com/docs/en/agents)
- [Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures (arXiv 2604.03515)](https://arxiv.org/pdf/2604.03515)
- [Diff-XYZ: A Benchmark for Evaluating Diff Understanding (arXiv 2510.12487)](https://arxiv.org/html/2510.12487v1)
- [Aider — unified diffs writeup](https://aider.chat/docs/unified-diffs.html)
- [Live-SWE-agent leaderboard](https://live-swe-agent.github.io/)
- [Confucius Code Agent (arXiv 2512.10398)](https://arxiv.org/pdf/2512.10398)
- [Your Code Agent Can Grow Alongside You with Structured Memory (arXiv 2603.13258)](https://arxiv.org/pdf/2603.13258)
