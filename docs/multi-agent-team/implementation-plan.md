# Implementation plan

Phases are intent. What actually landed is in [progress.md](progress.md).

| # | Phase | Surfaces | Depends on | Size |
| --- | --- | --- | --- | --- |
| 0 | Runtime: persona from the session's agent folder | runtime | — | S |
| 1 | Backend: agent registry, workspaces, channels, chat routing | backend | 0 | M |
| 2 | UI: Team view, channel, New agent wizard, agent page | web, desktop | 1 | M |
| 3 | Onboarding lands on Team; sidebar entry; E2E journey | web, desktop | 2 | S |
| 4 | Stage 2 isolation (container per agent, tool policy) | backend, runtime | 1 | L — separate initiative |

Rules for every phase: exit criteria are commands whose output was read;
every phase ships its own tests; nothing regresses existing tests; every new
string is in both `messages/en.json` and `messages/hi.json`.

## Phase 0 — Runtime persona per session

Deliverables
1. `load_agent_home_files(working_dir)` in
   `runtime/crates/amiro-base/src/agent_home.rs`, both call sites in
   `prompt.rs` pass the session folder.
2. Unit tests in `agent_home_tests.rs`: folder inside the root → that agent's
   files; outside → `AMIRO_AGENT_HOME`; sub-folder of an agent → the agent;
   root unset → unchanged behaviour.
3. Entry in `docs/runtime-customizations.json`.

Exit: `cargo test -p amiro-base agent_home` passes; `pnpm runtime:check` passes.

## Phase 1 — Backend

Deliverables
1. `backend/src/routes/agents.rs` with the routes in [02-design.md](02-design.md#api-backendsrcroutesagentsrs), merged in `routes.rs`.
2. `runtime_env` sets `AMIRO_AGENTS_ROOT`.
3. `chat.rs`: `agentId` handling; `threads.rs`: list filter, `agentId`/`channel` fields, channel delete protection.
4. `backend/tests/agents.rs`: create → folder + IDENTITY.md + channel; list order; 401 without token; 403 for non-owner create; bad name → 400; main PATCH/DELETE → 409; channel delete → 409; sidebar list hides agent threads; id traversal rejected.

Exit: `cargo test --manifest-path backend/Cargo.toml` passes.

## Phase 2 — UI

Deliverables
1. `src/lib/backend/agents-api.ts` (+ `agents-api.test.ts`).
2. `src/components/team/*` and pages `src/app/(chat)/team/{page,new/page,agent/page}.tsx`.
3. `ChatBot` props `agentId`, `threadPath`.
4. `Team` strings in en + hi.

Exit: `pnpm check-types && pnpm lint && pnpm test && pnpm check:i18n` pass.

## Phase 3 — Onboarding, navigation, E2E

Deliverables
1. Onboarding completion and the already-onboarded redirect go to `/team`.
2. Sidebar **Team** entry.
3. Journey steps in `tests/e2e/specs/` (onboarding lands on Team; channel
   streams a reply; create a second agent; its page shows the pinned
   channel; channel cannot be deleted).

Exit: `pnpm --dir tests e2e --project <journey> -g "team"` passes and the
feature recording was watched.

## Phase 4 — Stage 2 isolation

Planned separately (see [02-design.md](02-design.md#isolation)).
