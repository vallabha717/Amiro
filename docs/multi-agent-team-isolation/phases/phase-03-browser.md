# Phase 03 — Browser in the container

**Depends on:** 00, 01 · **Blocks:** — · **Size:** L

**Surfaces touched:** supervisor image · backend · web

This phase will turn the `browser` policy switch from "rejected" into a real
capability: headless Chromium inside the agent's own container, with a
persistent profile in `/home/agent/.browser`, driven by `agent_browser_navigate`,
`agent_browser_snapshot` (text + element refs) and `agent_browser_act`.
Egress rules from Phase 01 apply to the browser too.

## Deliverables

1. `agent.Dockerfile` variant with Chromium and a small CDP helper bound to
   the container's loopback only.
2. Supervisor routes `/v1/agents/{id}/browser/*` proxied to the helper via exec.
3. Backend tool definitions and routing; `browser: true` accepted.
4. UI: Browser switch appears; screenshots shown in tool output.

### Test coverage

| Surface | Where | Covers |
| --- | --- | --- |
| supervisor live | `tests/live_docker.rs` | navigate to a local fixture page served inside the container; snapshot returns its title |
| backend | `tests/agent_computer.rs` | browser tools offered only when switched on; fail closed when supervisor down |
| web | `12-team.spec.ts` | Browser switch persists |

## Exit criteria

1. With internet off, navigation to an outside URL fails; the fixture page works.
2. Two agents' browser profiles are separate folders (live test).
