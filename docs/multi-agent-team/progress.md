# Progress

The record of what was built and verified. Phases are planned in
[implementation-plan.md](implementation-plan.md).

| Phase | Status |
| --- | --- |
| 0 — Runtime persona per session | ✅ Built, unit-tested |
| 1 — Backend | ✅ Built, integration-tested |
| 2 — UI | ✅ Built, type/lint/unit/i18n checked |
| 3 — Onboarding, navigation, E2E | ✅ Built; `team` journey recorded and passing |
| 4 — Stage 2 isolation | 🟡 Phase 00 built — see [../multi-agent-team-isolation/progress/](../multi-agent-team-isolation/progress/README.md) |

## How to update this file

Append a section per phase when it lands: date, branch/commit, what was
built, the exact commands run with their result, what was not run and why,
and anything that differs from the plan.

## Phases 0–3 — 2026-10-21, branch `worktree-agent-sandbox-research`

### Built

- **Runtime** (`runtime/crates/amiro-base/src/agent_home.rs`, `prompt.rs`):
  `load_agent_home_files(working_dir)`; `AMIRO_AGENTS_ROOT`. Recorded as
  `team-agent-home` in `docs/runtime-customizations.json`.
- **Backend**: `backend/src/routes/agents.rs` (registry, folders, channels,
  files listing); `runtime.rs` exports `AMIRO_AGENTS_ROOT`; `chat.rs` routes
  `agentId` and keeps channel titles; `threads.rs` hides team threads from
  the main list, adds `agentId`/`channel`, refuses to delete channels.
  `agent.rs` helpers made `pub(crate)` for reuse.
- **UI**: `src/lib/backend/agents-api.ts`; `src/components/team/*`; pages
  `/team`, `/team/new`, `/team/agent`, `/team/chat`; `ChatBot` gained
  `agentId`, `threadPath`, `emptyState`; sidebar **Team** entry; onboarding
  lands on `/team`; `Team` + `Layout.team` strings in en and hi.
- **E2E**: new journey `tests/e2e/specs/12-team.spec.ts` (`team`), onboarding
  finish step now expects `/team`, ux-audit covers the three Team pages.

### Differs from the plan

- Per-agent model selection was dropped from Stage 1: the composer's model
  picker already chooses the model per message, and a second selector would
  conflict with it (the redesign decision puts model choice in the composer).
- Added `/team/chat` for an agent's non-channel chats (not in the first draft).
- The composer's folder picker is replaced by a "<name>'s own folder" label
  in team agents' chats (`PromptInput` `workspaceLabel`), because the backend
  ignores a client folder for them. Found by watching the first recording.

### Checks run

| Command | Result |
| --- | --- |
| `cargo test --manifest-path runtime/Cargo.toml -p amiro-base --lib agent_home` | 9 passed (3 new) |
| `cargo test --manifest-path backend/Cargo.toml --test agents` | 9 passed |
| `cargo test --manifest-path backend/Cargo.toml` | all suites passed, 0 failed |
| `pnpm check-types` | clean (includes E2E specs) |
| `pnpm lint` | clean |
| `pnpm check:i18n` | hi.json: 955 keys match en.json |
| `pnpm test` | 75 files, 871 tests passed |
| `pnpm runtime:check` | passed |
| `node scripts/verify-runtime-update-contract.mjs` | PASS, incl. `team-agent-home` |
| `pnpm build` | passed; `/team`, `/team/new`, `/team/agent`, `/team/chat` exported |
| `pnpm --dir tests e2e --project team --project ux-audit` | 9 passed, 1 failed (below) |
| `pnpm --dir tests e2e:feature --grep "team:"` | 4/4 team tests passed; recording watched |

The first E2E run (`--project team`) passed 7/7 including the soft check that
Scout answers with its own name, which proves the runtime loads the team
agent's persona from its folder.

### Known failure, not from this change

`[ux-audit] keyboard: shortcuts dialog and new-chat shortcut` times out
clicking a button named "Toggle Sidebar". That button is `md:hidden` in
`src/components/layouts/app-header.tsx` (untouched here) and the desktop
sidebar labels its toggle "Collapse sidebar", so the step cannot pass at the
desktop viewport. This change only added the three Team pages to that spec's
page list; all Team pages pass the audit on desktop and phone. Not re-run on
the base revision.

### Follow-ups (from that round)

- Stage 2 isolation (container per agent, per-agent tool policy) — [02-design.md](02-design.md#isolation).
- Fix the ux-audit sidebar-toggle selector above.

## Round 2 — 2026-10-21: Team app, agent spaces, per-agent everything

The owner refined the product (in their words: Team shows the agents; clicking
one opens its fixed Team thread beside the list; a button opens that agent's
main space, which is today's Amiro page unchanged; agents are created in Team
and configured in their space; every agent has its own connectors, keys,
providers and workspace; Amiro is only the default). What changed:

- **Team is its own full-page app** (`src/app/(team)/`, `team-shell.tsx`):
  list + fixed Team thread; header buttons **Open <name>**, **Computer**
  (Stage 2's panel, as a dialog) and **Delete**. The custom agent page and
  `/team/chat` from round 1 were removed — configuration lives in the space.
- **Agent spaces** (`agent-scope.ts`, `agent-scope-banner.tsx`): `?agent=<id>`
  makes the whole existing app act as that agent; banner with **Back to
  Team** / **Switch to Amiro**; page content remounts on scope change.
- **One runtime per agent** (`AppState::for_agent`, `AgentState` extractor):
  providers/models, connectors (remote only for team agents), keys (own
  vault), search, skills, memory, workspace, Personality/identity, chat list,
  new chats, schedules — see [03-per-agent-config.md](03-per-agent-config.md).
  Runtime bridges tracked per socket; deleting an agent stops its runtime and
  removes its private folder in the background.
- **Composer fix found by the journey**: the editor no longer takes focus on
  creation when something else already has focus (`mention-input.tsx`) — a
  quick click on the model picker right after a Team thread opened used to
  close it again.

### Checks run (round 2)

| Command | Result |
| --- | --- |
| `cargo test --manifest-path backend/Cargo.toml --test agents` | 17 passed |
| `cargo test --manifest-path backend/Cargo.toml` | all suites passed (before the last two agents.rs edits; agents suite re-run after) |
| `pnpm check-types && pnpm lint && pnpm check:i18n && pnpm test` | clean; 1014 keys en = hi; 77 files, 875 tests |
| `pnpm --dir tests e2e --project team --project chat` (1st) | team 5/5; chat run hit `ENOSPC` (disk full) |
| same, after freeing ≈9 GB | **team 5/5 passed**; chat 8/10 — two failures below |

The disk filled up during the first chat run (96 GB used). This worktree's
incremental build caches and its own old recordings were removed and the
journeys re-run.

### Round 2, final changes and verification

- Composer label "<name>'s workspace"; the agent id stays in every URL of its
  space (`agent-scope-banner.tsx` re-adds `?agent=<id>`, `ChatBot` keeps it in
  thread URLs); the Computer view is unmounted (owner: "later").
- Team agents' remote connectors work on providers without native deferred
  tool loading (Stage 2, `sandbox.rs`/`runtime.rs`: `mcp_search`/`mcp_call`).
- Runtime patch `refused-tool-is-a-tool-error` (owner-approved): a refused tool
  call reaches the model as a tool error instead of aborting the turn
  (`turn_loops.rs`, `turn_streaming_mpsc.rs`; test
  `refused_tool_call_is_answered_as_a_tool_error_not_a_turn_error`).

| Command | Result |
| --- | --- |
| `cargo test -p amiro-app-core --lib -- refused_tool_call desktop_selfdev validate_tool` | 16 passed |
| `node scripts/verify-runtime-update-contract.mjs` | PASS incl. `refused-tool-is-a-tool-error` |
| `cargo test --manifest-path backend/Cargo.toml --lib routes::agents` | 3 passed |
| `pnpm --dir tests e2e --project team` (recordings `2026-10-21T09-06-10`) | **8/8 passed**, no bug notes; feature video watched |

Chat failures in the earlier re-run:

- `skills (/) and tools (@) palettes` — the `/` palette finds no skills. **Pre-existing**: the main checkout's own runs on 2026-10-19/20 record the same "finds nothing for 'weath'" bug note.
- `follow-up queue, message actions and threads` — the queued follow-up is sent the moment the first turn ends and the backend answers `unknown_session: Unknown session '…' or session has no working directory` (runtime `client_subscribe_context.rs`: the session is still held by its finishing turn). Failed in both runs here; passed in the main checkout's earlier runs. The main-agent chat path is unchanged by this branch (`chat.rs` scoping and Stage 2's tool configuration only act for team agents), so the cause is **not established** — a reattach race made worse by load is suspected, not proven.
