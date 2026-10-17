# Amiro vs. Cursor / Claude Code / Antigravity / OpenCode — Feature Comparison

_Written 2026-08-22. Amiro's side is a source audit (`backend-go/internal/agent`, `internal/ai/tools`, `internal/tui`, `docs/agentic-loop-implementation-plan.md`, `docs/tui-progress.md`, `docs/skills/`). The competitors' side is a web survey — current as of this date, and these products ship weekly, so re-verify anything load-bearing before quoting it externally. Sources are listed at the end of each table's section on first use._

## TL;DR

Amiro's agent core — loop, file/git/shell tools, permission engine, repo map, LSP, memory, plan-review artifacts, eval harness — was rebuilt over the last week (see [agentic-loop-implementation-plan.md](../agentic-loop-implementation-plan.md)) specifically to close the gap with this category, and on **loop architecture, tool ergonomics, and plan/artifact review it is at parity or ahead** of what the sources below describe. The Skills system ([docs/skills/](../skills/)) landed today reading the same open `SKILL.md` standard Claude Code, Cursor, OpenCode and Gemini CLI all read, so skills are portable in, not a walled garden.

What Amiro does not have is **the product shape** these four are built around: none of them are chat apps first. Cursor and Antigravity *are* editors; Claude Code and OpenCode ship a CLI/TUI that's IDE-extension-attachable and a headless SDK for CI; all four run agents in the background/cloud while you do something else, several spin up a real browser to test their own work, and all four have a marketplace or plugin ecosystem for third parties to extend them. Amiro has a native desktop GUI *and* now a TUI (`cmd/amiro`, landed 2026-08-18) built on the same backend — that dual-surface shape is genuinely unusual — but still no inline editor experience (no tab-completion, no ghost text, no in-file diff gutter).

---

## 1. Product shape & surfaces

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| Primary surface | Native desktop GUI (Tauri) **+ TUI** (`cmd/amiro`) | Full IDE (VS Code fork) | CLI, + IDE extensions | Full IDE (VS Code-based) + IDE extensions (VS Code, VS, JetBrains, Zed) | Terminal-native TUI (OpenTUI/Zig+SolidJS) |
| In-editor inline completion / ghost text | ❌ None — Amiro is not an editor | ✅ Tab, multi-line predictive | Via IDE extension, not the CLI itself | ✅ (IDE) | ❌ (terminal-only; relies on the host editor via LSP context) |
| Headless / CI mode | ✅ `amiro run "<prompt>" --json --yes` — one-shot, no server, JSON schema + exit codes (0/1/2) | Background Agents (cloud), not a local one-shot | ✅ `claude -p` headless, Agent SDK for CI/batch | n/a (IDE-centric) | ✅ headless/CI documented |
| Attach to an already-running instance from another client | ✅ `amiro --connect <url> --token …`, proven multi-client-safe on one thread | — | — | — | — |
| Multi-user / auth / admin | ✅ auth service, roles, ban, admin panel | Team/org seats | Org seats via API console | Org seats | Org via GitHub/host |
| Deployment | Single local binary, SQLite, OS keychain | Desktop app, cloud account | CLI + cloud subscription | Desktop app, cloud account | CLI, BYO-provider |

**Sources:** [Cursor 2026 guide](https://myengineeringpath.dev/tools/cursor-ai/) · [Cursor background agents](https://tutorials.technology/tutorials/cursor-ai-v3-complete-guide-2026.html) · [Claude Code headless](https://amux.io/guides/claude-code-headless/) · [Antigravity product page](https://antigravity.google/product/antigravity-ide) · [Antigravity IDE extensions](https://thenewstack.io/google-antigravity-ide-extensions/) · [OpenCode TUI](https://deepwiki.com/sst/opencode/6.4-tui-commands-and-dialogs)

## 2. Agent loop & autonomy core

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| Parallel tool execution | ✅ 8-way semaphore for read-only calls, deterministic call-order merge | ✅ (agent mode) | ✅ published parallel tool-use pattern | ✅ (Agent Manager) | ✅ |
| Step budget | 150 steps / 15 min wall, 30/5min for subagents | Not published as a hard number | Not published as a hard number | Not published | Not published |
| Auto-compaction of long context | ✅ per-step, LLM summary + every user message kept verbatim, visible marker | ✅ (context management, unpublished internals) | ✅ | ✅ | ✅ |
| Event-sourced, replayable run log | ✅ `internal/agent/session` — EventLog is the source of truth, transcript is a projection | Not published | Session/resume exists; internals not published | Not published | Session-based, not published as event-sourced |
| Plan-then-approve contract | ✅ `propose_plan` suspends the turn on a commentable document; Proceed restores the pre-Plan permission mode | ✅ Plan Mode (Composer 2.0) — outlines steps, asks clarifying questions | Plan mode exists (read-only planning) | ✅ **Amiro's design is explicitly modeled on this** — Implementation Plan artifact | Plan agent (restricted-permission role), less structured as an artifact |
| End-of-turn walkthrough / summary artifact | ✅ `walkthrough` — files changed in reading order, cross-checked against real edits | Not a named artifact | Not a named artifact | ✅ Walkthrough artifact — **Amiro's is modeled on this** | Not a named artifact |
| Checkpoints / rewind to a prior state | ✅ Auto-checkpoint before each write, `/rewind` or Esc-Esc, "Rewind to here" on web/desktop — [shipped](../coding-agent-parity/progress/phase-01-checkpoints-and-rewind.md) | Some undo/history via editor | ✅ Auto-snapshot before each change, `/rewind` or double-Esc | Not clearly published as a discrete feature | Not clearly published |

**Sources:** [Cursor Plan Mode](https://myengineeringpath.dev/tools/cursor-ai/) · [Claude Code rewind/checkpointing](https://platform.claude.com/docs/en/agent-sdk/file-checkpointing) · [Antigravity implementation plan](https://antigravity.google/docs/implementation-plan) · [Antigravity walkthrough](https://antigravity.google/docs/walkthrough) · [Antigravity artifact review](https://antigravity.google/docs/artifact-review)

## 3. Tools (agent-computer interface)

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| File read/write/edit | ✅ windowed `read_file`, `write_file`, anchored SEARCH/REPLACE `edit_file`, atomic `multi_edit` | ✅ | ✅ | ✅ | ✅ |
| Edit rejected before writing if it breaks syntax | ✅ Go/JSON via stdlib parsers; other languages pass through unchecked | Unpublished | Unpublished | Unpublished | Unpublished |
| Codebase search | ✅ `grep` (Go RE2, no external dep) + `glob` | ✅ (ripgrep-backed, editor-native) | ✅ (ripgrep-backed) | ✅ | ✅ |
| Codebase orientation / repo map | ✅ `repo_map` — personalized PageRank over file/symbol graph, task-focus biasing (Aider-style) | Editor's own indexer (different mechanism, same goal) | Not a named tool | Not a named tool | Not a named tool |
| Symbol intelligence (LSP) | ✅ `lsp` — definition/references/symbols/diagnostics, opportunistic (gopls/tsserver/pyright/rust-analyzer if installed) | ✅ (built on the editor's own LSP) | Via IDE extension only | ✅ (IDE) | ✅ **40+ LSP servers wired**, richer coverage than Amiro today |
| Shell / terminal | ✅ gated, command-prefix allowlist, metacharacter guard, per-workspace session | ✅ | ✅ | ✅ | ✅ |
| Git tool | ✅ shipped 2026-08-29 (`docs/coding-agent-parity/` Phase 3) — fixed subcommand allowlist (status/diff/log/show/add/commit) **+ push**, always asking for approval regardless of mode; `pull`/`rebase`/`reset` still absent by design | ✅ (full, via editor) | ✅ (full) | ✅ (full) | ✅ (full, incl. PR creation — see §7) |
| Browser automation / self-testing | ❌ None | Browser control (Hooks) | Not core | ✅ **Browser Subagent** — spins up real Chrome, clicks/fills/screenshots, self-debugs on failure | Not core |
| Code execution sandbox (JS/Python) | ✅ worker-sandboxed | Via terminal | Via terminal | Via terminal / browser subagent | Via terminal |
| Chart / table / image-gen tools | ✅ | — | — | — | — |

**Sources:** [Cursor architecture](https://myengineeringpath.dev/tools/cursor-ai/) · [Antigravity browser subagent](https://thenewstack.io/google-antigravity-ide-extensions/) · [OpenCode LSP integration](https://deepwiki.com/sst/opencode/5.4-language-server-integration)

## 4. Safety, permissions & review

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| Risk classification per tool | ✅ read/session/write/exec/external, unclassified = most restrictive | Unpublished granularity | Permission modes, unpublished granularity | Unpublished | ✅ per-tool permissions, native agent roles (build/plan/general/explore) with different defaults |
| Modes (read-only / ask / auto) | ✅ Plan / Interactive / Edit / Auto, path-scoped in every mode | ✅ (Ask / Agent modes) | ✅ (permission modes + managed settings) | ✅ | ✅ (auto-approve toggle per session) |
| Approval card shows the real diff/command, not raw JSON | ✅ reuses the tool's own `Compact` presenter — a registry test enforces every gated tool has one | ✅ | ✅ | ✅ | ✅ |
| Session-scoped "always allow" grants | ✅ exact-command, per-thread, dies with the process | ✅ | ✅ | ✅ | ✅ |
| Workspace-trust consent UI (first-open prompt) | ✅ shipped 2026-08-23 (`docs/coding-agent-parity/` Phase 0) — a `workspace_trust` grant per (user, resolved root), checked ahead of every mode including Auto; env/CLI-sourced roots auto-grant; web/desktop show a prompt + Settings revoke, terminal reuses the approval dialog | ✅ (workspace trust) | ✅ | ✅ | ✅ |
| Sandboxed/isolated execution environment | ✅ shipped 2026-08-29 (`docs/coding-agent-parity/` Phase 2) — `run_shell` wrapped in bubblewrap on Linux (workspace root is the only writable bind, network denied by default via an unshared netns unless a command's prefix is on a per-project allow-list), `sandbox-exec` on macOS (implemented, unverified against a real host this round), an honest no-op fallback everywhere else with every result stating whether isolation actually happened | Cloud sandbox for Background Agents | ✅ sandboxing modes for autonomous runs | ✅ (cloud/VM-backed agent runs) | Local, host-level |
| Hooks (PreToolUse/PostToolUse-style user scripting) | ❌ None | ✅ Hooks | ✅ Hooks (documented pattern: grep a log instead of reading it whole) | Unpublished | Unpublished |
| Audit trail of decisions | ❌ decisions are shown, not recorded anywhere queryable | Unpublished | Unpublished | Unpublished | Unpublished |

**Sources:** [Claude Code hooks](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/) · [Claude Code sandboxing](https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/) · [OpenCode permissions](https://opencode.ai/docs/permissions/)

## 5. Context, memory & long-running tasks

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| Sub-agents / delegation with isolated context | ✅ `task` — read-only subset, structurally can't recurse, returns only final text | Background Agents are the rough equivalent, but async/cloud rather than in-turn | ✅ Subagents — own context, prompt, tool permissions | ✅ Agent Manager — up to 5 parallel, fully async | ✅ multi-session parallel agents |
| Persistent cross-session memory | ✅ workspace-scoped, JSON store, reinforcement-based eviction, injected into system prompt — **no browsing/editing UI yet** | ✅ (Rules act as durable, user-edited memory) | Session resume; explicit long-term memory less structured | Unpublished as a discrete feature | Community plugins add shared memory; not core |
| Todo / task list tool + live panel | ✅ `todo_write`/`todo_read`, live panel, survives work-log collapse | ✅ (task list in agent UI) | ✅ (well-known pattern for long tasks) | ✅ (Task List artifact) | ✅ |
| Rules / project-instructions file | ✅ `AGENTS.md`/`.agents/AGENTS.md`, shipped 2026-08-23 (Phase 0) — read every turn ahead of the Skills catalog, distinct from Skills' on-demand activation | ✅ `.cursorrules` / Rules, read on every turn | ✅ `CLAUDE.md` | ✅ | ✅ (`AGENTS.md`-style) |
| Evaluation / benchmarking harness | ✅ `internal/agent/eval` + SWE-bench Verified adapter, reports resolve rate / steps / tokens / failed-edit rate | Internal, not published | Internal, not published | Internal, not published | Internal, not published |

## 6. Extensibility — skills, plugins, MCP

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| MCP client | ✅ full RFC 9728/8414/7591/7636 OAuth, per-tool control, MCP dashboard | ✅ | ✅ | ✅ | ✅ |
| `SKILL.md` open-standard skills | ✅ **landed today (2026-08-22)** — discovers skills from `.agents/`, `.amiro/`, `.claude/`, `.codex/`, reads the same spec Claude Code/Cursor/Gemini CLI/Copilot/OpenCode/Goose all read; author/edit/generate from a dashboard | ✅ reads the standard | ✅ originates much of the standard | Unpublished whether it reads the open spec | ✅ reads the standard |
| Third-party plugin system | ❌ None | Extension-adjacent (it's a VS Code fork, so the whole VS Code extension ecosystem applies) | Growing plugin/marketplace ecosystem | Unpublished | ✅ local/npm plugins, full permissions (community: `oh-my-opencode`, memory-sharing, multi-agent coordination plugins) |
| Slash commands in composer | ✅ (skills + built-ins) | ✅ | ✅ | ✅ | ✅ |
| `@`-mentions (tools/servers/workflows) | ✅ in-composer, since Phase 3 also carries permission mode | ✅ (`@` file/symbol mentions) | ✅ | ✅ | ✅ |

**Sources:** [Claude Code skills 2026](https://www.totalum.app/blog/claude-code-skills-totalum) · [OpenCode plugins](https://github.com/opensoft/oh-my-opencode) · `docs/skills/00-overview.md`, `docs/skills/reference/agent-skills-standard.md`

## 7. Collaboration, automation & background work

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| Background/async agents that keep working while you do something else | ✅ shipped 2026-08-29 (`docs/coding-agent-parity/` Phase 4) — a durable job (`internal/agent/background`) survives the client that started it disconnecting and a graceful server restart (resumes if its trust grant still holds); capped at 2 concurrent by deliberate choice, self-hosted rather than cloud-run; `task` subagents remain separately synchronous within one turn | ✅ Background Agents — up to 8 parallel, cloud-run, opens a PR when done | ✅ (headless/SDK-driven parallel runs, CI) | ✅ Agent Manager — up to 5 parallel, visible status panel | ✅ multi-session parallel |
| Opens a pull request automatically | ✅ shipped 2026-08-29 (`docs/coding-agent-parity/` Phase 3) — `create_pr` opens a GitHub PR via the REST API (no `gh` CLI), title/body built from `walkthrough`; GitHub only this round, always asks for approval regardless of mode | ✅ | Via GH Actions integration | Unpublished as automatic | ✅ GitHub integration — comments, commits, opens PRs |
| Scheduled / cron automations | ❌ None | Unpublished as a core feature | Via external CI scheduling | Unpublished | Unpublished as core |
| Shareable session/thread links | ⚠️ Export with comments, not a live share link | Unpublished as core | Unpublished as core | Unpublished as core | ✅ shareable links, on by default for public repos |
| Conversation graph / thread visualization | ✅ (`chat-graph`) | — | — | — | — |
| Sharing, archive, bookmarks, temporary chat | ✅ all four | — | — | — | — |

**Sources:** [Cursor background agents](https://tutorials.technology/tutorials/cursor-ai-v3-complete-guide-2026.html) · [Antigravity Agent Manager](https://www.baytechconsulting.com/blog/google-antigravity-ai-ide-2026) · [OpenCode GitHub integration](https://opencode.ai/docs/github/) · [OpenCode session sharing](https://medium.com/@techlatest.net/opencode-agent-masterclass-full-tutorial-b4b828aa3ab4)

## 8. Models & providers

| Dimension | Amiro | Cursor | Claude Code | Antigravity | OpenCode |
|---|---|---|---|---|---|
| Provider count | OpenAI, Anthropic, Google, xAI, Groq, OpenRouter, Ollama, custom OpenAI-compatible (8 families) | Multi-model, editor-curated list + BYO key | Anthropic-native; other models via proxies only | Gemini-native (Gemini 3.5 Flash), some multi-model support | ✅ **75+ providers via Models.dev**, incl. local models, and BYO Claude Pro/Copilot/ChatGPT subscription auth |
| Enterprise cloud auth (Bedrock/Vertex) | ❌ None | Unpublished as core | ✅ (via API console / enterprise plans) | ✅ (Google-native) | Partial (Bedrock listed) |
| Secrets storage | ✅ OS-native keychain, never in a config file | Cloud account | Cloud/API key | Cloud account | Local config / env |
| Pricing model | Free/OSS, BYO key | Subscription ($ tiers) + usage | Subscription ($20/$100/$200 tiers) or API metered | Free (as of the 2026 launch) | Free/OSS, BYO key or subscription passthrough |

**Sources:** [OpenCode providers](https://aiwiki.ai/wiki/opencode) · [Claude Code pricing 2026](https://www.cloudzero.com/blog/claude-code-pricing/) · [Antigravity free tier](https://www.blog.brightcoding.dev/2026/05/20/google-antigravity-20-the-ai-ide-that-defies-development-gravity-complete-guide-2026)

---

## What Amiro already has that this category generally doesn't

- **A native desktop GUI and a terminal client sharing one backend**, including a proven multi-client contract — attach to the same thread from the TUI while the desktop app is open, resolve an approval from either. None of the four surveyed products document this shape.
- **A visual workflow builder** with conditional branching, callable as a chat tool.
- **Chart, table, image-generation, Mermaid** tool renderers.
- **Full multi-user auth, roles, admin panel, 7-locale i18n** — none of the four are multi-tenant desktop products in this sense.
- **A registry-backed tool-presenter system** shared verbatim between the chat surface and the workflow canvas — one `glance`/`Compact`/`Expanded` definition per tool, asserted by a test to exist for every gated tool.
- **An eval harness with a public benchmark adapter (SWE-bench Verified)** committed in-repo, not just an internal number a vendor blog quotes.

## Prioritized gap list

### Tier 1 — closest to "this is a coding agent, not a chat app with tools"
1. ✅ **Workspace-trust consent UI** — shipped 2026-08-23, `docs/coding-agent-parity/` Phase 0. A grant per (user, resolved root), checked ahead of every mode; env/CLI-sourced roots auto-grant, matching every competitor's own carve-out for an explicit launch gesture.
2. ✅ **Checkpoints / `/rewind`** — shipped 2026-08-29, `docs/coding-agent-parity/` Phase 1. A pre-image per file per turn, restored one file at a time; `/rewind`/Esc-Esc in the terminal, "Rewind to here" on web/desktop.
3. ✅ **Sandboxed execution for the shell tool** — shipped 2026-08-29, `docs/coding-agent-parity/` Phase 2. `run_shell` runs inside bubblewrap on Linux (workspace root the only writable path, network denied by default) or `sandbox-exec` on macOS (implemented, not yet verified against a real macOS host), an honest no-op fallback elsewhere with every result stating whether isolation actually happened.
4. ✅ **A plain, always-on rules file** (`AGENTS.md`/`.cursorrules`-equivalent) — shipped 2026-08-23, `docs/coding-agent-parity/` Phase 0, alongside item 1. Read on every turn ahead of the Skills catalog, distinct from Skills' on-demand activation model.

### Tier 2 — shipping work back
5. ✅ **`git` push + PR creation** — shipped 2026-08-29, `docs/coding-agent-parity/` Phase 3. Push resolves and targets only the checked-out branch (never model-namable); `create_pr` calls the GitHub REST API directly (no `gh` CLI), title/body built from `walkthrough`. Both are gated tighter than `commit`: a new `AlwaysAsk` predicate asks every time, in every mode including Auto, overriding both Auto's own "run everything" rule and the RiskExternal carve-out every MCP tool relies on. GitHub only this round; GitLab/Bitbucket remain a real gap.
6. **Scheduled/cron automations** (already flagged as a gap vs. OpenWorker; also a gap vs. this category).

### Tier 3 — polish and reach
7. **Browser automation / self-testing subagent** (Antigravity's is the clear bar — spins up Chrome, clicks through the UI it just built, self-debugs).
8. **Hooks** (PreToolUse/PostToolUse-style) for user-authored automation around tool calls.
9. **A plugin system** for third-party extensions (OpenCode's is the reference: local/npm, full permissions, audited by the user).
10. **Shareable live session links**, distinct from the existing export-with-comments.
11. **Audit trail** of permission decisions (flagged in the OpenWorker comparison too — still open).
12. **Memory browsing/editing UI** — the store and tools exist; there's nowhere for a user to see or prune what the agent remembers.

Not pursued, and why: an in-editor experience (tab-completion, inline diff gutter) would mean either forking an editor (Cursor's approach) or shipping a proper LSP-based extension for VS Code/JetBrains (Antigravity's, OpenCode's) — a different product than "a desktop chat app with a first-class agent," not an incremental feature. Worth a deliberate decision, not a silent gap.
