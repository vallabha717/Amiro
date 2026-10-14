# Amiro on jcode

Status: architecture note. No code. Explains what Vellum is, how to rebuild it with jcode as the
harness, and exactly how to restrict jcode to Amiro's needs.

Verified against jcode `master` source and jcode v0.95.0 (6487bbd7e) on 2026-10-14. Every claim
below that names a file, flag, profile, or API method was read from source or from the shipped
`@1jehuang/jcode-sdk` declarations, not inferred from marketing copy.

---

## 1. What Vellum actually is

Reference: `vellum-ai/vellum-assistant` (MIT). Local checkout at `/root/Projects/vellum-assistant`.

Vellum is not a chat app. It is a long-running daemon that owns one assistant's identity, memory,
and initiative, plus a policy gateway in front of every inbound message, plus thin clients.

Vocabulary from their `GLOSSARY.md` is load-bearing: Guardian (you), Assistant (the entity), Hatch
(create it), Home (where it runs), Client, Channel, Memory, Skill, Schedule, Heartbeat, Gateway,
Credential Vault.

### The five processes

| Process | Role |
|---|---|
| Runtime daemon (`assistant/`, Bun/TS, `vellum wake --foreground`) | The brain. Loopback HTTP + SSE on 127.0.0.1:7830. Conversation Manager with in-memory pool and stale eviction. Hosts memory, skills, approvals, computer use, apps, schedules, heartbeat, plugins, MCP, desktop, voice. |
| Gateway (`gateway/`, Bun/TS) | The trust boundary. Verifies channel webhooks (Telegram secret token, WhatsApp HMAC-SHA256, Slack Socket Mode, Twilio voice/status/media), normalizes to a message, resolves `conversation_id` to `actor_id` to a default route, forwards to the daemon. Also owns the OAuth callback and feature flags. |
| Credential executor (`credential-executor/`) | Separate process holding the encrypted store. Materializes a credential for a specific call under a specific grant. The model never sees the secret. |
| Clients (`clients/`) | macOS Swift menu bar, iOS, Next.js web, Chrome extension, Windows, Linux, Ink CLI. Thin: render and send. |
| Web + Postgres (`clients/web`) | Only for the multi-tenant *platform* story. Not on the critical path for a self-hosted single assistant. |

### Design invariants worth copying

- The assistant is **not allowed to write to the gateway**. Only the guardian can. Enforced by
  process boundary, not policy.
- Actor identity resolves to guardian / trusted / unknown once, at ingress, and is enforced
  everywhere downstream. Default is deny.
- Every tool call runs in a sandbox.
- One assistant, one memory, every channel. Managed and self-hosted share a codebase.

### Memory, precisely

Pipeline: new message, segment, extract structured items (identity, preference, project, event) with
source attribution and dedup, embed locally by default, and a jobs worker polling every 1.5s for
embed, extract, and cleanup_stale.

Recall: hybrid dense + sparse with RRF fusion, tier classification, staleness filtering, scope
filtering, and two-layer injection into context.

Two schema decisions matter: **eight typed memories** (episodic, semantic, procedural, emotional,
prospective, behavioral, narrative, shared) each with its own staleness window, and **scope
isolation per user and per channel**.

Identity lives in files: `SOUL.md` for behavior, `NOW.md` as a scratchpad for current focus, plus a
per-user journal of reflections, all written by the assistant itself during onboarding.

### Proactivity

- **Heartbeat**: hourly. Re-reads its notes, looks for anything unfinished or due soon, messages the
  guardian if needed, routes to the right channel, and will not interrupt an active conversation.
- **Schedule**: cron rows (`cron_jobs`, `cron_runs`) for a specific thing at a specific time.
- **Reminders**: with `routing_intent` and `routing_hints_json` so delivery target is data.

The distinction between a schedule (do this thing) and a heartbeat (stay present) is the product.

### Storage

`$VELLUM_WORKSPACE_DIR/data/db/assistant.db` (conversations, messages, tool_invocations,
memory_items, memory_item_sources, memory_jobs, attachments, channel_inbound_events,
conversation_keys, reminders, cron_jobs, cron_runs, tasks, task_runs, contacts) and
`assistant-memory.db` (memory_segments, memory_summaries, memory_embeddings). Vectors in Qdrant.
Secrets in `~/.vellum/protected/keys.enc`. Apps in `data/apps/`.

---

## 2. The insight: Vellum = harness + assistant shell

Everything generic (agent loop, provider fan-out, streaming, tool calling, compaction, session
persistence, MCP, skills, sandboxing, approvals, hooks, memory extraction and recall) is the
**harness**. jcode already is that harness, and it exposes a stable semver'd API to it.

jcode is open source: <https://github.com/1jehuang/jcode>. The SDK is
`@1jehuang/jcode-sdk` (protocol v1, GA), docs at <https://jcode.sh/sdk>.

So Amiro does not build an agent. Amiro builds the shell and points it at jcode.

### Component mapping

| Vellum | jcode | Verdict |
|---|---|---|
| Agent loop, providers, streaming | `jcode serve` daemon | Free |
| Session store, history | sessions + `~/.jcode/sessions` | Free |
| Compaction | `compact()`, `[compaction]` | Free |
| Memory extract / embed / recall | memory graph + sideagent + `[features] memory` + ambient consolidation | Free (mechanism) |
| Skills | `~/.jcode/skills`, `SKILL.md` | Free |
| Tools + MCP | base tools, `[tools]`, MCP config | Free |
| Approval prompts | `permission_request` + `respondToPermission()` | Free |
| Tool policy gate | `pre_tool` hook | Free |
| Tool input rewriting | `pre_tool_transform` hook | Free |
| Feedback into the model | `post_tool_feedback` hook | Free |
| Audit events | `turn_end`, `session_start/end`, `post_tool` | Free |
| Remote reach (phone/web) | `[gateway]`, `jcode pair`, `POST /pair`, `GET /health`, `ws://host:7643/ws?token=` | Free |
| iOS client | `ios/` SwiftUI + `JCodeKit` | Free |
| TUI client | `jcode` | Free |
| Headless one-shot | `jcode run --json` / `--ndjson` | Free |
| Proactivity | ambient mode + `[safety]` notify channels | Partial |
| Guardian / trust actor model | none | **Build** |
| Channel adapters + inbound policy | gateway is pairing and WS only | **Build** |
| Credential broker (usable but unreadable) | `setApiKey` stores provider keys only | **Build** |
| Heartbeat as relationship | ambient is code work with git branches | **Build** |
| Typed per-channel memory scope | one graph, one recall path | **Build** |
| Live voice | none | **Build** |

### Two integration shapes

- **A. Wrapper over the shared daemon.** Amiro spawns `jcode serve` + `jcode api-bridge`, clients use
  `JcodeClient.connect()`. One assistant, one accumulating memory, every client sees the same live
  sessions. Closest to Vellum's model. Best for the personal setup.
- **B. Private instance per Amiro.** `JcodeClient.launch({ jcodeHome })`. Isolated state, own
  credentials, cannot disturb your interactive jcode. Choose this when Amiro ships to other people.

They are not exclusive. Use A for yourself, and C (`jcode run --json`) for scheduled jobs that do not
need a live session.

### The Go question (important, and easy to miss)

The published SDK is **TypeScript only**. `sdk/` in the jcode repo contains just `npm` and
`typescript`. The Rust crate `crates/jcode-harness-api` exists as a library, but there is **no Go
SDK**. Since this repo's backend is Go, that is a real decision point rather than a detail.

Three ways to bridge Go to jcode:

| Option | How | Cost |
|---|---|---|
| **1. Speak protocol v1 directly** | Go dials the `api-bridge` owner-only Unix socket and reads and writes NDJSON frames itself. | Hand-written frame codecs in Go, and you track schema changes yourself. Protocol v1 is stable and the frame tags are mirrored mechanically between `crates/jcode-harness-api` and `sdk/typescript/src/protocol.ts`, so the shapes are discoverable, but nothing generates the Go code for you. |
| **2. Shell out per request** | Go runs `jcode run --json` or `--ndjson` per request. | Cheapest. Stateless. You lose live session control, permission prompts, per-session tools, and streaming into a persistent session. Fine for the scheduler, wrong for chat. |
| **3. Thin TypeScript sidecar** | A small Node process uses the official SDK and exposes HTTP + SSE to the Go backend. | Adds one process and one language to the runtime. The project already ships Node for the Next.js frontend, so it is not a new language for the repo. You keep every SDK guarantee: `configureTools`, `permission_request`, custom tools, `forkSession`, `sendSystemReminder`. |

Recommendation: **option 3** if Amiro needs per-session tools, custom tools, or an approval UI, which
it does. **Option 1** only if stack purity in Go is worth owning a hand-written protocol client.
**Option 2** is right for the heartbeat and schedule jobs regardless of what you pick for chat.

Note the shape this produces: Go keeps the HTTP surface your Tauri and web clients already talk to,
the sidecar owns the jcode conversation, and jcode owns the model, tools, memory, and sessions. That
is the same three-tier split Vellum uses (client, daemon, harness), just with the daemon tier split
across two languages.

### Session-scoped helpers the SDK gives you

Beyond the documented surface, the shipped declarations also include:

- `forkSession(id)` for branching a thread without losing the parent.
- `sendSystemReminder(id, reminder)` and `sendMessageWithReminder(...)` to inject context with **no
  model turn**. This is the heartbeat primitive.
- `setSessionSaved`, `todoState`, `ackTodoFollowUp` for UI state.
- `appletAction`, `closeApplet` for interactive panels rendered client-side.
- `backgroundTool`, `backgroundToolResult` for work that should not block a turn.
- `invalidateUsage`, `notifyAuthChanged` for catalog freshness.

---

## 3. How to restrict jcode

Ordered softest to hardest. Layers 1 to 4 are configuration. Layer 5 is enforcement. Layer 6 is the
only real boundary.

### Layer 1: Naming (renaming to Amiro)

jcode's own identity is load-bearing. From `crates/jcode-app-core/src/update.rs`:

- Auto-update is skipped when the running executable is inside a Git repository.
- The updater extracts assets by name, matching entries starting with `jcode` (excluding `.bin`) and
  `jcode.exe`.
- Install is channel-symlink based: `~/.jcode/builds/{current,stable,shared-server}` with `-version`
  stamps.
- `UPDATE_RELEASE_URL_OVERRIDE_ENV` is **only honored when `JCODE_HOME` points at a sandbox**.

Recommendation: ship `amiro` as your launcher, keep the engine binary named `jcode`, and let
`jcode update` keep working. If you later need a pinned build, the sandboxed-`JCODE_HOME` release
override is the supported hook. Fork-and-rename is the last resort, and it means owning updates
forever.

Open item: behavior when the running exe is a shim with a different name pointing at a managed
binary is unverified. Cheap to test once the shim exists.

### Layer 2: Persona and prompt

| Mechanism | Effect |
|---|---|
| `~/.jcode/prompt-overlay.md`, `./.jcode/prompt-overlay.md` | Appended. Adds guidance only. Safest. |
| `AGENTS.md` (project, `~/AGENTS.md`) | Appended conventions. |
| `~/.jcode/preferred-tools.md` | Nudges tool choice. |
| `~/.jcode/system-prompt.md` | Replaces **only** the base layer. Overlays, AGENTS.md, skills, memory still apply. |
| `CreateSessionOptions.systemPrompt` (SDK) | Replaces the **entire** assembled prompt. Immutable after creation, persisted for resume, inherited by forks. Empty string means no prompt. |

Use the SDK option for Amiro so the persona lives in your code and cannot be edited out of shape by a
repo's `AGENTS.md`.

There is no `--system-prompt` CLI flag. Verified: `src/cli/args.rs` has none.

### Layer 3: Tool surface

Single source of truth: `ToolConfig::selection()` in `crates/jcode-base/src/config.rs`.

Profiles:

| `profile` | Tools exposed |
|---|---|
| unrecognized, including empty | all base tools |
| `none`, `off`, `disabled` | none |
| `acp` | bash, read, write, edit, replace, apply_patch, agentgrep, ls, batch, mcp |
| `minimal`, `lite`, `small` | bash, read, write, edit, replace, apply_patch, agentgrep, ls |

Precedence, in order:

1. `enabled` containing `*` or `all` means unrestricted, no allow-list.
2. Non-empty `enabled` becomes the allow-list.
3. `disable_base_tools` or a `none` profile yields an empty set.
4. The profile preset.
5. Otherwise everything.
6. `disabled` is applied last, and is also subtracted from the allow-list. `disabled = ["mcp"]` kills
   `mcp`, `mcp__*`, `mcp_search`, and `mcp_call`.

Three ways to set it:

- Config `[tools]`: `profile`, `enabled`, `disabled`, `disable_base_tools`, `mcp_tools`
  (`auto`/`eager`/`deferred`), `codemode`.
- Env: `JCODE_TOOL_PROFILE`, `JCODE_TOOLS`, `JCODE_DISABLED_TOOLS`, `JCODE_DISABLE_BASE_TOOLS`.
- Global CLI flags: `--tool-profile`, `--tools`, `--disabled-tools`, `--disable-base-tools`,
  `--mcp-tools`, `--mcp-tools-token-threshold`.

For Amiro's launcher, lock the surface with **env vars only**. No config mutation, survives updates.

Security note: `[tools] codemode` (off by default) exposes a `codemode` tool that runs model-written
JavaScript in an embedded QuickJS sandbox able to call **every other tool, including MCP tools**.
Keep it off. A tool that can call other tools defeats a tool allow-list.

### Layer 4: Per-session tools from the SDK

`client.configureTools(sessionId, options)` and `createSession({ tools })`:

```ts
SessionToolsOptions {
  enabled?: string[] | null;  // omit/null inherits defaults; [] exposes NO built-in or MCP tools
  disabled?: string[];        // deny wins, including over custom tools
  custom?: SdkTool[];         // session-local tools: JSON Schema + execute callback
}
```

Capability-gated on the bridge advertising `session_tools`. Wire frame:
`{ req: "configure_tools", session_id, tools }`. Custom tool callbacks are Ajv-validated, cannot use
async schemas, and have a 60s ceiling. Companion methods: `listTools(id)`,
`submitToolResult(id, callId, result)`.

This is how Amiro gives the model *Amiro's* tools (channel sender, memory writer, guardian lookup)
instead of asking jcode to do it with shell.

### Layer 5: Policy (the gate)

`pre_tool` runs synchronously before every tool call. Env has `JCODE_HOOK_TOOL_NAME`; stdin has the
full tool input JSON. Exit 0 allows, exit 2 blocks and its stderr is returned to the model as the
tool error. `pre_tool_timeout_ms` defaults to 5000.

**It fails open.** Any other exit code, a timeout, a missing binary, or a spawn error allows the
call. That is deliberate, so a broken policy degrades to no policy rather than bricking every
session. Therefore **your policy script is the trust boundary, not jcode.** Write it defensively and
test it with malformed input.

Companions:

- `pre_tool_transform` rewrites tool input JSON before validation and execution, and runs **before**
  the gate, so policies always see the final input. Use it to canonicalize paths and commands.
- `post_tool` is fire-and-forget observation, with `JCODE_HOOK_TOUCHED_PATHS` listing the absolute
  paths the input named. Note it does not track files a `bash` command happened to modify.
- `post_tool_feedback` runs synchronously after success and appends its stdout to the tool result.

Recursion guard: nested jcode calls receive `JCODE_HOOKS_DISABLED=1`, so your hook cannot re-enter
itself.

### Layer 6: Isolation

- `JCODE_HOME` redirects all jcode-owned state, including app config. `JCODE_RUNTIME_DIR` redirects
  sockets.
- `JcodeClient.launch({ jcodeHome, inheritLogins: false, env })` starts a private instance with its
  own state dir, sessions, and sockets. Path resolution goes through that state dir, so it cannot
  read your interactive jcode's transcripts, and session ids are validated rather than pasted into
  paths. `close()` tears it down; an exiting process is still reaped.
- Telemetry opt-out: `JCODE_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, or `~/.jcode/no_telemetry`.

Hard limit, quoted from jcode's own SDK doc: isolation is **not** a sandbox for untrusted code. An
instance runs with the user's permissions and can read and write their files. For code you do not
trust, isolate the process with a container or VM. Vellum reached the same conclusion, which is why
they sandbox every tool call and keep credentials in a separate process.

### Layer 7: Audit

`turn_end` (status, duration, model, last assistant text, token counts), `session_start`/`session_end`
(`create`, `attach`, `resume`, `close`), and `post_tool` (tool name, call id, input, touched paths)
are enough to build an Amiro activity log. Push notifications via `[safety]` (ntfy, desktop, email,
telegram, discord).

---

## 4. What changes in this repo

By size, in `backend-go/internal/`:

| Package | Action |
|---|---|
| `ai` (~716K, provider clients) | Delete. jcode owns providers. |
| `agent` (~504K, own loop) | Delete. jcode owns the loop. |
| `mcp` (~148K) | Delete or reduce to config. jcode has MCP. |
| `skills` (~68K) | Delete or keep as a catalog UI over `~/.jcode/skills`. |
| `docs/coding-agent-parity/*` | Retire. Workspace trust, checkpoints, sandbox, git ops, background runs are jcode's now. |
| `tui` (~884K) | Keep, or retire in favor of the jcode TUI / your own client. |
| `api`, `db`, `httpserver`, `auth`, `secrets` | Thin to: persona files, the policy hook, the scheduler, the channel layer, and the jcode adapter. |
| Tauri shell, static Next.js frontend, i18n, SQLite bookkeeping, keyring | Keep. |

The Go backend stops touching models entirely. It becomes the assistant shell: per-session tool
configuration, the persona prompt, the policy script, the heartbeat, the channel gateway, and an
adapter to the jcode harness API.

That adapter is the open decision from "The Go question" above. Either Go gains a small TypeScript
sidecar that owns the SDK, or Go gains a hand-written protocol v1 client. Everything else in this
section is language-independent.

### Which clients to keep

The jcode repository ships exactly three client surfaces: the Rust TUI (`crates/jcode-tui`), the CLI,
and an iOS app (`ios/`, SwiftUI plus `JCodeKit`). There is **no web client and no desktop client** in
the repository. "Jcode Desktop" is referenced by the engine (the `desktop_selfdev` tool, and a
Desktop-specific prompt for sessions rooted in a Jcode Desktop checkout) but is not part of this
repository.

So this is not adopt-or-keep as a single decision. It is per surface:

| Surface | jcode ships one? | Recommendation |
|---|---|---|
| Desktop (Tauri) | No | Keep yours. Nobody ships one, so yours is not duplicated work. |
| Web (Next.js static export) | No | Keep yours. Talk to the harness API through the TypeScript SDK, which is stable and versioned, rather than the internal WebSocket protocol. |
| TUI | Yes, Rust | Either keep your Go TUI, or drop it and let power users run `jcode` directly for terminal work. Do not plan to reuse jcode's TUI protocol: it is internal, and the docs state it is deliberately not wire-compatible with the harness API. |
| iOS | Yes, Swift | Only relevant if you want mobile. Their app is a thin client over the internal gateway WebSocket protocol, so pointing it at your own backend means implementing that protocol. Use it as reference, not as a drop-in. |

The important correction to the earlier assumption: keeping your Tauri and Next.js clients is not
duplicated effort, because jcode does not provide either. The only genuine overlap is the TUI.

One protocol note that constrains the web client. jcode exposes two different surfaces:

- **Harness API** (`jcode api-bridge`, protocol v1, semver'd, curated subset, official TypeScript SDK).
  This is what Amiro's web and desktop clients should use.
- **Internal client protocol** (NDJSON over the daemon Unix socket, and the same frames over
  `ws://host:7643/ws?token=` for the gateway). The TUI and the iOS app use this. It is what the iOS
  app's `JCodeKit` encodes and decodes. It is not documented as stable.

Choosing the harness API means accepting that it is a curated subset. Choosing the internal protocol
means getting everything the TUI sees, at the cost of tracking an unstable surface. Start with the
harness API.

---

## 5. What jcode does not give you

Build these. There is no shortcut.

1. **Guardian / trusted / unknown actor model** with enforcement at every boundary.
2. **Channel adapters** (Telegram, Slack, WhatsApp, email) plus webhook verification and route
   resolution. jcode's gateway does pairing and WebSocket reach, not channel normalization.
3. **Credential broker.** jcode stores provider keys owner-only. It does not give you "the agent can
   call Notion but cannot read the Notion token". That is a separate process.
4. **Heartbeat as relationship.** jcode ambient is a coding loop with git branches. Your heartbeat is
   "re-read notes, notice what is due, choose a channel, speak", driven by your scheduler calling
   `sendSystemReminder` or `jcode run`.
5. **Apps and a dynamic workspace.** jcode `panel` renders Markdown and PDF. Vellum apps are
   assistant-authored HTML/JS talking back over `vellumBridge`. Different thing.
6. **Typed memory taxonomy and per-channel scope.** jcode gives one graph and one recall path. The
   eight types with individual staleness windows, and per-user/per-channel isolation, are yours.
7. **Live voice.**

---

## 6. Open items

- Shim-plus-updater behavior for a renamed launcher (see Layer 1).
- Memory has **no** SDK surface. Memory is automatic recall plus extraction plus agent-side tools.
  Anything that renders memory must either read the store or ask the agent. The on-disk graph is
  versioned (`GRAPH_VERSION` in `crates/jcode-memory-types`), which means it is deliberate, but
  versioned is not the same as supported.
- Whether `JCODE_TOOL_PROFILE` interacts with the SDK's per-session `configureTools` in the
  documented order. The config path populates session policy through `sdk::config(session)`; the
  precedence between an env-locked profile and a per-session SDK call should be confirmed empirically
  before relying on both at once.
