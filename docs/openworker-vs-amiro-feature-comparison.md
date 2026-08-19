# OpenWorker vs. Amiro — Feature Comparison

_Generated 2026-08-16 from a source audit of `~/Projects/Personal/openworker` (Python backend + React/Tauri GUI) and `~/Projects/Personal/Amiro` (Go backend + Next.js/Tauri desktop app)._

> **Updated 2026-08-16** — §4 is closed. Phases 1–5 of [agentic-loop-implementation-plan.md](./agentic-loop-implementation-plan.md) have landed, plus the evaluation harness; rows they changed are marked 🔨. One item is deliberately not done and is named as such: self-evolving custom tools (declined — a tool authored mid-run has no honest risk class). The EventLog *inversion* was the other, and it landed 2026-08-17. Everything else is unchanged from the original audit.
>
> **Updated 2026-08-17** — The SWE-bench Verified adapter landed (`internal/agent/eval/swebench`), so the evaluation harness now runs the gate Part 4 names rather than only local fixtures. Phase 6 closes the last open item of Tier 2 #7: a **propose-plan-then-approve** contract, plus a live task panel and an end-of-turn walkthrough, shown as artifacts in a review pane with inline comments. The plan is the first place Amiro's model is Antigravity's rather than OpenWorker's. One thing is consciously left out and named under "What is still deferred": an artifact review *policy* separate from the permission mode. Editing the plan in place was the other, and it landed 2026-08-17.

## TL;DR

The two apps are the same *shape* (local-first, Tauri shell, sidecar backend, BYO model key, OS keychain for secrets) but they aim at different products:

- **OpenWorker is an agentic coworker.** Its center of gravity is *doing work* — 40 SaaS connectors, a filesystem/shell/git toolset, a permission + approval engine, an Inbox for human-in-the-loop, scheduled automations, memory, skills, personas, and Slack-driven sessions.
- **Amiro is a polished chat product.** Its center of gravity is the *conversation surface* — real streaming multi-provider chat, MCP integration with full OAuth, a visual workflow builder, agent definitions, charts/code-execution/image-gen tool renderers, sharing/export/archive, admin + i18n.

Amiro's largest gaps vs. OpenWorker are: **native connectors**, **unattended autonomy** (Inbox, unattended mode, self-wake, audit), **scheduling/automations**, and **skills/personas**.

As of Phase 5, none of the loop, the file toolkit, the permission engine, context management, long-term memory, or codebase orientation is one of them — Amiro now matches OpenWorker on parallel tool execution, exceeds it on step budget, has read/list/glob/grep/write/edit/multi-edit with workspace containment and a syntax gate, and gates every consequential call behind Plan/Interactive/Auto modes with path scoping, a command allowlist and a shell-metacharacter guard. The shell is gated for the first time, and there is a `git` tool. Phase 4 added the things that make a 150-step turn survivable: a plan tool, auto-compaction with a visible marker, subagents whose exploration never enters the parent's context, and a ranked repo map. Phase 5 added a language server client (exact references and definitions, and post-edit diagnostics without running a build) and workspace-scoped durable memory. There is now also an evaluation harness that scores runs against a fixed task suite and reports failed-edit rate, which is what makes any of the above checkable rather than asserted.

Phase 6 added the human-in-the-loop half that was still missing *inside* a session: the agent proposes a plan, the run visibly stops on it, the user comments on any part of the document and approves — and approving hands back the permission mode the work needs. A task panel and an end-of-turn walkthrough came with it. All three are projections of the transcript, so there is no second record to drift.

What autonomy still lacks is the *cross-session* half — an Inbox, unattended mode, scheduling, and an audit trail — not the loop, the tools, the gate, what the agent remembers, or how a plan gets agreed.

---

## 1. Core platform

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Desktop shell | Tauri (Rust) | Tauri (Rust) | — |
| Backend sidecar | Python (`coworker/`), packaged with PyInstaller | Go (`backend-go/`), single binary | — |
| Frontend | React + Vite | Next.js 16 static export | — |
| Local storage | SQLite + local state dir | SQLite in OS app-data dir | — |
| Secrets | Local secret store (`secrets.py`) | OS keychain (Keychain/Cred Mgr/Secret Service) | — |
| Loopback auth token | Per-launch token, in-memory in app | Per-launch shared secret injected by shell | — |
| Auto-update | Yes — signed builds, update manifest (`packaging/make_update_manifest.py`) | **No updater wired** | ❌ Missing |
| Installers | macOS DMG (signed/notarized), Windows | `.deb`/`.rpm`/`.AppImage`/`.dmg`/`.msi`/`.exe` | ✅ Amiro broader |
| Alternate surfaces | Desktop GUI + **TUI** (`coworker/tui`) + Slack | Desktop GUI only | ❌ Missing |
| Multi-user / auth | Single local user | Auth service, roles, ban, admin panel | ✅ Amiro ahead |
| i18n | None | 7 locales (en/es/fr/ja/ko/no/zh) | ✅ Amiro ahead |

## 2. Models & providers

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Provider count | OpenAI, Anthropic, Gemini, Vertex, Bedrock, DeepSeek, Kimi, MiniMax, Mistral, OpenRouter, Together, Fireworks, Ollama, GLM, Qwen, Grok, Inkling | OpenAI, Anthropic, Google, xAI, Groq, OpenRouter, Ollama, custom OpenAI-compatible | ⚠️ Fewer, but covers the majors |
| Enterprise cloud auth | AWS Bedrock (IAM/profile/keys) + GCP Vertex (ADC) | **None** | ❌ Missing |
| Capability matrix per model | `providers/capabilities.py` + `matrix.py` — marks tool-calling-verified models | Per-provider model list with `supportsTools` flag on custom endpoints | ⚠️ Partial |
| Custom OpenAI-compatible endpoints | Via base_url override | `OPENAI_COMPATIBLE_DATA` JSON config | — |
| Streaming | Yes | Yes (real network token streaming) | — |
| Auto-compaction of long context 🔨 | Yes — LLM summary + mechanical state extraction (`compaction.py`) | **Yes** — `internal/agent/compaction`, per step rather than per turn; every user message kept verbatim | ✅ Parity |

## 3. Integrations & connectors

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Native SaaS connectors | **40** (`connectors/descriptors.py`) | **0** | ❌ Biggest gap |
| — Messaging | Slack, Discord, Telegram, WhatsApp | — | ❌ |
| — Email/Calendar | Gmail, Outlook, generic IMAP/SMTP, Google Calendar | — | ❌ |
| — Dev | GitHub, GitLab, Jira, Linear, Confluence, PagerDuty, Datadog | — | ❌ |
| — Docs/Files | Notion, Google Drive, Dropbox, Box, Canva, Figma, Descript | — | ❌ |
| — CRM/Sales | Salesforce, HubSpot, Attio, Close, Clay, Apollo, Hunter, Zendesk | — | ❌ |
| — PM/Finance | Asana, ClickUp, monday.com, Stripe, QuickBooks, DocuSign | — | ❌ |
| — Analytics | PostHog, Mixpanel, Amplitude | — | ❌ |
| Multi-account per connector | Yes (`accounts.py`, `gmail_accounts.py`, `gcal_accounts.py`, `hubspot_portals.py`) | n/a | ❌ |
| Managed one-click OAuth broker | Optional "OpenWorker Cloud" sign-in (Auth0 + PKCE); manual token paste always available | n/a | ❌ |
| MCP client | Yes (`mcp/client.py`, `mcp/oauth.py`), per-tool control | Yes — full RFC 9728/8414/7591/7636 OAuth client, server + tool customization UI, MCP dashboard | ✅ Amiro's is at least as good |
| Browser automation | Yes (`connectors/browser_automation.py`) | **No** | ❌ Missing |
| Connector audit log | Yes — durable SQLite audit of connector/tool actions with secret redaction | **No** | ❌ Missing |

## 4. Agent capabilities & tools

### 4a. Loop architecture 🔨

The substrate the tools run on. This was the real §4 blocker: Amiro's loop was a chat tool-loop, not an agent loop.

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Parallel tool execution 🔨 | Yes — `engine.py` partitions each turn's calls and `asyncio.gather`s the safe ones. Safety is *derived* from tool metadata: `risk_level == "low"` and not `requires_approval` | **Yes (new)** — `toolScheduler` runs `tools.Parallel` calls concurrently under an 8-way semaphore, everything else strictly in call order. Safety is now *derived* the same way — `Definition.Concurrency()` returns parallel iff `Risk == RiskRead`, and the hand-maintained field is gone 🔨 | ✅ **Parity**, on the same design |
| Deterministic result ordering | Implicit — `zip(concurrent, outcomes)` preserves call order | **Yes (new)** — results merge in the model's original call order regardless of completion order | — |
| Agent step budget 🔨 | `max_iterations = 12` | **`loopBudget{MaxSteps: 150, Wall: 15m}`** — was a hard `maxToolSteps = 10`. Subagents get a smaller `{30, 5m}` 🔨 | ✅ Amiro higher, and compaction now backs it up |
| Workspace path containment 🔨 | Yes (`roots.py`, `workspace_trust.py`) — plus a user-facing trust prompt | **Yes** — `internal/agent/workspace` confines every file tool (symlink-aware, catches writes through a symlinked parent, handles not-yet-created files), and the permission engine re-checks paths in every mode including Auto. No trust prompt | ⚠️ Enforcement done, consent UI pending |
| Event-sourced history (replayable runs) 🔨 | Yes | **Yes** — `internal/agent/session` has Action/Observation/EventLog, the loop and scheduler record into them in *call* order, and consumers read them (subagent reporting, the eval harness, compaction accounting). **The inversion landed 2026-08-17**: the persisted parts array is now `partsFromLog(log.Events())`, so the log is the source of truth and the transcript is a projection of it — the precondition replay needs 🔨 | ✅ Log is the record; parts are derived from it |
| Structured run metrics (steps, failed edits, denials) 🔨 | Partial — audit log records actions | **Yes (new)** — `session.Stats` separates a tool *refusing* (a bad edit anchor) from a tool *breaking* (a failed exec) from a permission *denial*. The first is the ACI signal the plan calls sharpest; averaging the three hides all of them 🔨 | ✅ Amiro ahead on the metric, behind on durability (nothing is persisted) |
| Auto-compaction 🔨 | Yes (`compaction.py`) | **Yes (new)** — `internal/agent/compaction`: LLM summary of the older history + every user message kept verbatim + a recent window untouched, per *step* rather than per turn. Never modifies the persisted transcript, only what is sent. A visible marker lands in the chat 🔨 | ✅ Parity |

### 4b. Tools

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Local file read/write 🔨 | Yes (`tools/files.py`) | **Yes (new)** — `read_file` (windowed, line-numbered, binary-detecting), `write_file`, `list_dir` | ✅ Parity |
| Directory browse / roots + workspace trust 🔨 | Yes (`tools/directories.py`, `roots.py`, `workspace_trust.py`) | **Mostly** — `list_dir` + symlink-aware containment, `.gitignore`-aware. **No trust prompt**: the root comes from `BETTERCHATBOT_WORKSPACE_ROOT`, not a user grant | ⚠️ Missing the consent UI |
| File editing (anchored replace) 🔨 | Yes (`tools/files.py`) | **Yes (new)** — `edit_file` + atomic `multi_edit`, exact-anchor SEARCH/REPLACE, uniqueness enforced, **rejects edits that break Go/JSON syntax before writing**, returns +N/−M | ✅ Parity |
| Shell / terminal execution 🔨 | Yes, permission-gated (`tools/shell.py`) | **Yes, permission-gated** — `RiskExec`, approval-carded, command-prefix allowlist with a metacharacter guard. Session is now per workspace root, and starts in it | ✅ Parity |
| Git operations 🔨 | Yes (`tools/git.py`) | **Yes (new)** — one `git` tool over a fixed subcommand allowlist (status/diff/log/show/add/commit), gated as `write`, paths workspace-resolved before git sees them. Network and history-rewriting subcommands deliberately absent | ✅ Parity, narrower on purpose |
| Codebase search 🔨 | Yes (`tools/search.py`), ripgrep | **Yes (new)** — `grep` (Go/RE2, context lines, include filter) + `glob` (`**` semantics, newest-first) | ✅ Parity; Go regexp not ripgrep, so no external dependency |
| Web search | Yes (`web/` with provider abstraction + guard) | Yes (Exa via `EXA_API_KEY`) | — |
| HTTP fetch tool | Yes (`web/fetch.py`) | Yes (`http_fetch.go`) | — |
| Codebase orientation / repo map 🔨 | **No** — OpenWorker has no equivalent | **Yes (new)** — `repo_map`: a ranked, budgeted outline of what each file declares, ordered by personalized PageRank over the file/symbol graph. `focus` biases it toward the task's own words. Go via `go/parser`, everything else via anchored line patterns — no tree-sitter, so no cgo | ✅ Amiro ahead |
| Symbol intelligence (LSP) 🔨 | **No** | **Yes (new)** — `lsp`: exact `definition` / `references` / `symbols`, plus `diagnostics` for checking an edit compiles without running a build. Opportunistic: gopls / typescript-language-server / pyright / rust-analyzer if installed, and the tool is simply not offered otherwise | ✅ Amiro ahead |
| Sub-agents / delegation 🔨 | Yes (`tools/subagent.py`) | **Yes (new)** — `task` spawns a child loop with its own context and a **read-only** tool subset, returning only its final text. Recursion is prevented structurally (`task` is not in the child's subset), and the child runs under the parent's permission engine | ✅ Parity |
| Planning tool 🔨 | Yes (`tools/plan.py`, PlanCard UI) | **Yes (new)** — `propose_plan` submits a markdown plan and **suspends the turn**; the user reads it in a review pane, anchors comments to any selected text (a phrase, a list item, one table cell), and answers Proceed or Send comments. Rides the client-tool pause, so no new plumbing and it survives a reload. Proceed also restores the pre-Plan permission mode, named on the button 🔨 | ✅ **Parity**, and ahead on inline comments |
| End-of-turn walkthrough 🔨 | **No** — OpenWorker has no equivalent | **Yes (new)** — `walkthrough`: a summary plus the files that changed **in reading order**, with a client-side cross-check that flags files the turn demonstrably edited and the summary never explains | ✅ Amiro ahead |
| Todo / task tracking 🔨 | Yes (`tools/todo.py`, TodoPanel) | **Yes** — `todo_write`/`todo_read`, per-thread, `RiskSession` (never gated — a plan revised eight times must not produce eight cards — but never parallel either). Since Phase 6 it also has a **live panel** that stays visible after the work log auto-collapses, instead of only a card inside it 🔨 | ✅ Parity |
| Long-term memory tools 🔨 | Yes (`memory/{base,sqlite_store,tools}.py` + settings UI) | **Yes (new)** — `memory_write`/`memory_read`/`memory_forget`, workspace-scoped, injected into the system prompt rather than fetched. Writes are `RiskWrite` and therefore approval-gated: a note changes every future conversation and appears in no transcript. No settings UI to browse or edit them yet | ⚠️ Parity on the tools, missing the management UI |
| Ask-the-user tool | Yes (`tools/ask.py`, structured questions/options) | **No** | ❌ Missing |
| Attachments & PDF ingest | Yes (`attachments.py`, `pdf_support.py`) | Yes (multimodal attachments, `file-ingest`) | — |
| Code execution (JS/Python sandbox) | **No** | Yes (`lib/code-runner`, worker-sandboxed) | ✅ Amiro ahead |
| Chart / table / visualization tools | **No** | Yes (bar/line/pie chart, interactive table) | ✅ Amiro ahead |
| Image generation | **No** | Yes (`ai/image/generate.go`) | ✅ Amiro ahead |
| Mermaid diagram rendering | **No** | Yes | ✅ Amiro ahead |

### 4c. Tool-result legibility

Not in the original audit; surfaced while planning §4. A 40-step agent run is only usable if each step is readable at a glance — and, since Phase 3, the same components are what a user reads *before* consenting to a step, which turned legibility from polish into part of the safety story.

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Per-tool result cards in chat | Yes (ApprovalCard, PlanCard, TodoPanel, ConnectorMessageCard, DirectoryRequestCard) | Yes (`tool-invocation/*.tsx`, dispatched by name) | — |
| Per-tool result rendering in the *workflow* canvas 🔨 | n/a (no workflow builder) | **Wired, but barely exercised** — the node face and result dialog both look the tool up in the registry (which now covers file, shell and git), with `JsonView` behind a "raw" tab. In practice the canvas can only *run* `webSearch`/`webContent` and MCP tools today, so the file/shell/git presenters are reachable there in principle, not in a workflow anyone can build yet | ⚠️ Rendering done; the executor is the limit |
| Shared presenter across surfaces 🔨 | n/a | **Yes** — `src/components/tool-presenters/` registry with `glance`/`Compact`/`Expanded`; both surfaces read it. `run_shell`/`terminal-execution` migrated in Phase 3 (the approval card needs a `Compact` that renders from *input* alone); `git` shipped with one 🔨 | ✅ Built |
| Presenter coverage of the agent toolkit 🔨 | n/a | **Yes** — file, shell, git, todo (checklist with strikethroughs), task (returned summary + the prompt it answered), repo_map (grouped file tree from the *structured* result, not the model's text), lsp and memory all render through the registry. A registry test asserts every one has all three slots 🔨 | ✅ Built |
| Approval card reuses the result presenter 🔨 | Yes in spirit — ApprovalCard is its own component | **Yes** — the card's body *is* the tool's `Compact` view, so approving an `edit_file` shows the diff and approving a shell call shows the literal command. A registry test asserts every gated tool has one, so no tool can reach an approval prompt as raw JSON 🔨 | ✅ Amiro's is one component, not two |
| Artifact review pane (plan / tasks / walkthrough) 🔨 | Partial — PlanCard and TodoPanel are cards in the conversation | **Yes (new)** — a docked pane sharing the Workflow View's wide column, with three tabs. Every artifact is a **projection of message parts**, so there is no second store to drift from the transcript and a reload restores the pane, the plan and the pending decision 🔨 | ✅ Amiro ahead |
| The run visibly stops at a decision 🔨 | Inbox/approval prompts, no graph | **Yes (new)** — the Workflow View halts on the plan node and resumes from it. The halt is structural (a suspended turn produces no further messages); what was built is the honesty — `waiting` is now a distinct node status, because a suspended call previously derived as `running` and showed a spinner on a node that was waiting for *the user* 🔨 | ✅ Amiro ahead |

## 5. Autonomy, safety & human-in-the-loop

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Permission engine 🔨 | Yes — Plan / Interactive / Auto modes, path scoping, command-prefix allowlists, shell-metachar guard (`permissions.py`) | **Yes (new)** — `internal/agent/permission`: the same three modes, path scoping in every mode, token-wise command-prefix allowlist, and the same metacharacter guard. No `custom` mode or user risk overrides | ✅ Parity on the core |
| Risk classification per tool 🔨 | Yes (`risk.py`: read / write / external, with user overrides) | **Yes** — `tools.Risk`: read / **session** / write / exec / external, zero value = unclassified = most restrictive. No user overrides yet. `session` (Phase 4) is the class for tools that mutate only the agent's own bookkeeping: never gated, never parallel 🔨 | ✅ Parity; Amiro splits exec out of write and session out of read |
| Approval prompts before consequential actions 🔨 | Yes (ApprovalCard, session allowlists) | **Yes (new)** — approve / always-allow / reject card rendering the tool's own `Compact` presenter (a diff for `edit_file`, the literal command for the shell), plus per-thread session grants. Rides the existing client-tool suspend, so it survives a reload | ✅ Parity |
| Inbox — cross-session human-attention queue | Yes (`inbox.py`, idempotent pending→resolved, first-responder-wins) | **No** | ❌ Missing |
| Unattended mode | Yes (`unattended.py`) — routes asks to Inbox, suspends agent | **No** | ❌ Missing |
| Inbox routing to Slack/DM | Yes (`inbox_routing.py`) | **No** | ❌ Missing |
| Audit trail | Yes (`audit.py`) | **No** — decisions are made and shown, but not recorded anywhere queryable | ❌ Missing |

**There is one tool-execution path, and it is gated.** Worth stating because the obvious way to lose this is to gain a second one: the workflow executor has its own tool node, but its `app-tool` branch (`internal/ai/workflow/executor/node_executor.go`) implements only `webSearch` and `webContent` and returns "Unknown tool" for everything else — so a workflow cannot reach `run_shell`, `write_file` or `git`, and there is no way to route around the permission engine by wrapping a tool in a graph. Wiring that branch up to `tools.Defaults()` would silently open exactly that hole, and would need the engine wired in alongside it.

## 6. Automation & background work

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Scheduled tasks / cron automations | Yes (`automation/`: cron + one-shot, timezone, max runs, notify-on-completion, per-task allowlists, run history with artifacts) | **No** | ❌ Missing |
| Self-wake (sleep/resume, wake-on-job-completion) | Yes (`selfwake.py`) | **No** | ❌ Missing |
| Channel subscriptions (agent listens to a Slack channel) | Yes (`subscriptions.py`) | **No** | ❌ Missing |
| Slack `@mention` → spawns a desktop session, replies in thread | Yes (`mentions.py`, `connectors/slack_*`) | **No** | ❌ Missing |
| Run history / transcripts for background runs | Yes (`TaskRun`, ScheduledView) | **No** | ❌ Missing |
| Visual workflow builder (node graph, conditions, executor) | **No** | Yes (`ai/workflow/`, tiptap nodes, conditions, callable as a chat tool) | ✅ Amiro ahead |

## 7. Personalization & knowledge

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Long-term memory 🔨 | Yes — SQLite-backed memory store + memory tools + settings UI | **Yes (new)** — JSON store in the app data dir, keyed per workspace root, capped at 200 notes with reinforcement-based eviction. Injected into the system prompt as explicitly fallible recollections. **No settings UI**: notes are readable at the path every tool result names, and correctable by the agent, but there is nowhere for a user to browse them | ⚠️ Store and tools done; management UI missing |
| Project/workspace scoping of memory 🔨 | Per-project | **Yes** — memories never cross workspace roots; "we use pnpm" is a fact about one repository | ✅ Parity |
| Skills (Anthropic `SKILL.md` format, progressive disclosure, `load_skill`) | Yes (`skills/`) | **No** | ❌ Missing |
| Personas (built-in + markdown/third-party, manifest + registry) | Yes (`personas/`) | Agents (system prompt + bound tools, callable from chat) | ⚠️ Amiro's "Agents" is a partial equivalent |
| Vetted capability catalog (stable id → tool bundle, per-persona `tools:`) | Yes (`catalog.py`) | **No** | ❌ Missing |
| Multiple agent surfaces (chat / code / cowork / helper) | Yes (`agents/`) | Single chat surface | ⚠️ Partial |
| Project/workspace context | Yes (`project.py`, `environment.py`) | ⚠️ **Partly** — a workspace root, a repo map of it, and durable notes about it, but no project/environment model | ⚠️ Partial |

## 8. Chat & UX surface

| Feature | OpenWorker | Amiro | Gap |
|---|---|---|---|
| Threads / conversation history | Yes | Yes | — |
| Temporary (unsaved) chat | **No** | Yes (`chat-bot-temporary.tsx`) | ✅ Amiro ahead |
| Archive threads | **No** | Yes | ✅ Amiro ahead |
| Bookmarks | **No** | Yes | ✅ Amiro ahead |
| Share / export conversation (with comments) | **No** | Yes (`api/export`, shareable cards) | ✅ Amiro ahead |
| Conversation graph view | **No** | Yes (`chat-graph`) | ✅ Amiro ahead |
| Keyboard shortcuts panel | **No** | Yes | ✅ Amiro ahead |
| `@`-mentions (tools, MCP servers, workflows, agents) | Mentions are Slack-side | Yes, in-composer | ✅ Amiro ahead |
| Tool-mode / enabled-tools dropdowns 🔨 | Per-tool control in settings | Yes, in-composer — and since Phase 3 the same menu carries the **permission mode** (Plan / Interactive / Auto), persisted, defaulting to Interactive 🔨 | ✅ Amiro ahead |
| Voice input | Yes — dedicated **Rust STT sidecar** (`stt/`), local speech-to-text | Yes — OpenAI Realtime voice chat (`openai_realtime.go`, `chat-bot-voice.tsx`) | ⚠️ Different: OW is local STT, Amiro is cloud realtime |
| Global search across sessions | Yes (SearchModal) | Fuzzy search (`lib/fuzzy-search.ts`) | — |
| Onboarding flow | Yes | Yes (`app/onboarding`) | — |
| Admin: users / providers / usage | **No** | Yes | ✅ Amiro ahead |

---

## What Amiro is missing — prioritized

### ✅ Closed since the audit
- **The agent loop itself.** Tool calls no longer run one-at-a-time inline in the stream hook; side-effect-free tools overlap, mutating ones stay ordered, results merge deterministically. The 10-step ceiling is gone. _(Phase 1 — 2026-08-16.)_
- **The file toolkit.** `read_file` / `list_dir` / `glob` / `grep` / `write_file` / `edit_file` / `multi_edit`, all workspace-confined, with an anchored-replace edit format that enforces anchor uniqueness and refuses edits that would break Go/JSON syntax. _(Phase 2 — 2026-08-16.)_
- **Tool-result legibility.** A shared presenter registry both chat and the workflow canvas read, so a file tool's result is readable at a glance in either surface instead of being a JSON blob on one of them. _(Phase 2 — 2026-08-16.)_
- **The permission engine, and the ungated shell.** Risk classes per tool, Plan/Interactive/Auto modes, path scoping in every mode, a token-wise command allowlist that refuses anything carrying shell metacharacters, and an approve/always/reject card that shows the tool's own compact view rather than a JSON blob. `terminal.go` is gated for the first time. A `git` tool landed with it. _(Phase 3 — 2026-08-16.)_

- **Context management, and the two features that depend on it.** Auto-compaction with a visible marker, a per-thread `todo` plan tool, and a `task` subagent whose exploration never enters the parent's context. The 150-step budget is now backed by something that survives reaching it. _(Phase 4 — 2026-08-16.)_
- **Codebase orientation.** `repo_map` — a ranked, budgeted outline of what each file declares, personalized toward the words in the task. Built without tree-sitter, since the parser was never the requirement: Go gets `go/parser`, everything else gets anchored line patterns, and a map is a navigation aid whose next step is always reading the real file. _(Phase 4 item 4 — 2026-08-16.)_
- **Symbol intelligence and long-term memory.** An LSP client (`definition`/`references`/`symbols`/`diagnostics`) that is offered only when a language server for a language this workspace uses is actually installed, and workspace-scoped durable notes injected into the system prompt rather than fetched by a tool. _(Phase 5 — 2026-08-16.)_
- **A way to tell whether any of it works.** `internal/agent/eval` + `cmd/eval`: fixed task suites scored by reading the workspace afterwards, reporting resolve rate, mean steps, tokens, and failed-edit rate — the last from a structured event log, because a rejected edit anchor and a crashed shell are both an error string on the wire. _(Part 4 — 2026-08-16.)_
- **Plan review, a task panel, and the walkthrough.** `propose_plan` suspends the turn on a markdown plan the user can annotate by selecting any text — including one cell of a table — then Proceed (which restores the permission mode the work needs, named on the button) or Send comments for a revision. The Workflow View stops on that node and continues from it. `walkthrough` closes a turn with what changed in reading order, cross-checked against the edits the turn actually made. All three artifacts are projections of message parts rather than a second store, so a reload restores them and nothing can drift from the transcript. _(Phase 6 — 2026-08-17.)_

### Tier 1 — defines the product category (Amiro is a chat app, OpenWorker is a worker)
1. **Native SaaS connectors (40)** with multi-account support and an OAuth broker. Everything OpenWorker markets ("triage my inbox", "untangle my calendar") depends on this. Amiro can only reach these through user-configured MCP servers.
2. ~~**Permission / approval engine + risk classification**~~ — done in Phase 3. What remains of this item: an **audit trail** of the decisions, **user risk overrides**, and gating `RiskExternal` (every MCP tool) behind something better than "allowed" — which is the Inbox work in Tier 2, not a policy tweak.
3. ~~**Local file, directory, and search tooling**~~ — done in Phase 2; **git tooling** done in Phase 3. What remains: the **workspace trust prompt** — the root is still an env var (`BETTERCHATBOT_WORKSPACE_ROOT`), not something the user grants.
4. **Scheduled automations** (cron + one-shot, run history, notifications). **Now the top blocker for autonomy**, together with the Inbox below: the agent can be trusted to act, but not yet to act while nobody is watching.

### Tier 2 — makes autonomy usable
5. **Inbox** (cross-session approval/question/notification queue) and **unattended mode**.
6. ~~**Long-term memory** store and memory tools~~ — done in Phase 5. What remains: a **settings UI** to browse and edit notes. They are a readable file at a path every tool result names, and the agent can correct them, but a user cannot yet see or prune the list.
7. ~~**Sub-agents / delegation**, **planning tool**, **todo tracking**, and the **repo map**~~ — **all done.** Subagents, todo and the repo map in Phase 4; the **propose-plan-then-approve** contract in Phase 6, which closes this item. Amiro now goes past OpenWorker here: the plan is a commentable document with a Review/Proceed header, and approving it hands back the permission mode the work needs.
8. ~~**Auto-compaction** of long histories~~ — done in Phase 4.
9. **Ask-the-user structured question tool.** Now the most valuable small gap: the approval rail from Phase 3 already does suspend-and-resume, so this is a tool on top of existing plumbing rather than new machinery.

### Tier 3 — reach and polish
10. **Skills** (`SKILL.md` progressive disclosure) and **personas** with a vetted capability catalog.
11. **Slack surface**: `@mention` → session, channel subscriptions, Inbox routing.
12. **Self-wake** (sleep/resume, wake-on-completion).
13. **Audit log** for connector/tool actions — and, since Phase 3, for permission *decisions*: every allow / ask / refuse is computed and shown, but nothing records what the agent was allowed to do or what the user approved. That record is the thing a user would want after an unattended run.
14. **Auto-update** + signed/notarized builds.
15. **Browser automation.**
16. **Bedrock / Vertex** enterprise model auth; broader provider list.
17. **TUI surface.**

## What Amiro has that OpenWorker does not

- Visual **workflow builder** with conditional branching, executable and callable as a chat tool
- **Code execution** sandbox (JS/Python in a worker)
- **Chart, table, and image-generation** tools with rich renderers; **Mermaid** diagrams
- **Sharing, export (with comments), archive, bookmarks, temporary chat, conversation graph**
- **Multi-user auth, roles, admin panel** (users / providers / usage)
- **i18n** across 7 locales
- **Linux packaging** (`.deb`/`.rpm`/`.AppImage`)
- In-composer **@-mentions** for MCP tools, workflows, and agents; per-message tool selection

---

## Suggested reading order in the OpenWorker source

Rows marked ✅ have been ported; the Go equivalent is named so the two can be diffed when OpenWorker's version moves.

| Want to port… | Read | Ported to |
|---|---|---|
| Permission model ✅ | `coworker/permissions.py`, `coworker/risk.py` | `internal/agent/permission/`, `internal/ai/tools/risk.go` |
| Human-in-the-loop | `coworker/inbox.py`, `coworker/unattended.py`, `coworker/inbox_routing.py` | — (the in-session half exists: `internal/api/chat/approvals.go`) |
| Scheduling | `coworker/automation/{models,scheduler,store,tools}.py` | — |
| Connectors | `coworker/connectors/{descriptors,base,gateway,accounts}.py` | — |
| Memory ✅ | `coworker/memory/{base,sqlite_store,tools}.py` | `internal/agent/memory/`, `internal/ai/tools/memory.go` |
| Skills / personas | `coworker/skills/base.py`, `coworker/personas/`, `coworker/catalog.py` | — |
| Context management ✅ | `coworker/compaction.py` | `internal/agent/compaction/` |
| Agent loop ✅ | `coworker/engine.py`, `coworker/agent.py`, `coworker/agents/` | `internal/api/chat/tool_loop.go`, `tool_scheduler.go` |
| File & shell tools ✅ | `coworker/tools/{files,search,directories,shell,git}.py` | `internal/ai/tools/{files,search,edit,terminal,git}.go` |
| Todo & subagents ✅ | `coworker/tools/{todo,subagent}.py` | `internal/ai/tools/todo.go`, `internal/api/chat/subagent.go` |
| Plan review & walkthrough ✅ | `coworker/tools/plan.py` (the artifact/comment model is Antigravity's, not OpenWorker's) | `internal/ai/tools/plan.go`, `src/components/artifacts/` |
| Codebase orientation ✅ | n/a — no OpenWorker equivalent; modelled on Aider's repo map | `internal/agent/repomap/`, `internal/ai/tools/repomap.go` |
| Symbol intelligence ✅ | n/a — modelled on Crush's Go LSP client | `internal/agent/lsp/`, `internal/ai/tools/lsp.go` |
| Run metrics & evaluation ✅ | n/a — closest is `coworker/audit.py` | `internal/agent/session/`, `internal/agent/eval/`, `cmd/eval/` |
