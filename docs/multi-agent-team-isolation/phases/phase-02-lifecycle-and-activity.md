# Phase 02 — Lifecycle and activity

**Depends on:** 00 · **Blocks:** — · **Size:** M

**Surfaces touched:** backend · supervisor · web

This phase will give the owner control and a record: Start/Stop on the
Computer tab, idle stop after a configurable time, container replacement on
master rotation (`scripts/sandbox.sh rotate`), removal of the container when
an agent is deleted, and an **Activity** list of what each agent did in its
container (tool name, time, success, exit code — never command text, file
contents or output, following OpenDots' audit rule).

## Deliverables

1. Supervisor: `POST /v1/agents/{id}/remove`; idle reaper by label; rotation
   recreates containers whose credential label hash differs.
2. Backend: `DELETE /api/agents/{id}` removes the container (archive keeps
   the folder); `store/agent-activity/<id>.jsonl`, last 1,000 records;
   `GET /api/agents/{id}/computer/activity`.
3. Decide and document whether an in-container helper receives the agent
   credential (needed only if something inside the container calls back).
4. UI: Start/Stop buttons, state badge, Activity list.

### Test coverage

| Surface | Where | Covers |
| --- | --- | --- |
| backend | `tests/agent_computer.rs` | activity records hold no command text; delete removes container (fake supervisor) |
| supervisor live | `tests/live_docker.rs` | rotate replaces container, folder persists |
| web | `12-team.spec.ts` | Stop → state stopped; Activity shows the self-check run |

## Exit criteria

1. Deleting an agent leaves no `<ns>-agent-<id>` container (`docker ps -a` in the live test).
2. Activity entries never contain the command string (asserted with a sentinel).
3. After rotation, the old credential is rejected and the folder content survives.
