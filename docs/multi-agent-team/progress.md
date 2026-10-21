# Progress

The record of what was built and verified. Phases are planned in
[implementation-plan.md](implementation-plan.md).

| Phase | Status |
| --- | --- |
| 0 — Runtime persona per session | ✅ Built, unit-tested |
| 1 — Backend | ✅ Built, integration-tested |
| 2 — UI | ✅ Built, type/lint/unit/i18n checked |
| 3 — Onboarding, navigation, E2E | ✅ Built; `team` journey recorded and passing |
| 4 — Stage 2 isolation | ⬜ Not started (separate initiative) |

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

### Follow-ups

- Stage 2 isolation (container per agent, per-agent tool policy) — [02-design.md](02-design.md#isolation).
- Per-agent memory, schedules/heartbeat, connectors and default model.
- Fix the ux-audit sidebar-toggle selector above.
