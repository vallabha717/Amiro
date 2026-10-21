# Phase 01 — Egress restriction and gVisor

**Depends on:** 00 · **Blocks:** 03 · **Size:** M

**Surfaces touched:** supervisor · backend · web

Phase 00 will let the owner cut the network for *every* container
(`AMIRO_SANDBOX_NETWORK=none`) and pick `runsc` globally. This phase will make
both per agent and verifiable: an **Internet** switch per agent (off → network
`none`; on → an internal network whose only way out is an allowlisting HTTP(S)
proxy run by the supervisor), and the self-check will report the OCI runtime
actually in use.

## What already exists (after Phase 00)

`spec.rs` takes `NetworkMode` and `Runtime` from the supervisor's environment;
the self-check reports them; the policy has `shell`, `files`, `browser`.

## Deliverables

1. Policy gains `internet: false` and `allowedHosts: []` (hostnames, no
   wildcards beyond one leading `*.`).
2. Supervisor creates `<ns>-egress` (internal) network and a proxy container
   (`packaging/sandbox/egress.Dockerfile`, tinyproxy-style allowlist) with the
   same hardening; agent containers get `HTTP(S)_PROXY` only.
3. `ensure` takes the network choice from the backend-signed policy hash, not
   from free-form input; spec hash changes replace the container.
4. Runtime detection: `GET /health` lists available runtimes; `runsc`
   requested but missing → `ensure` fails with a clear error instead of
   silently using `runc`.
5. UI: Internet switch + allowed hosts list on the Computer tab; isolation
   line mentions "no internet" / "only <hosts>".

### Test coverage

| Surface | Where | Covers |
| --- | --- | --- |
| supervisor unit | `spec.rs` | network none/internal per policy; runtime field |
| supervisor live | `tests/live_docker.rs` | `curl https://example.com` fails with internet off, succeeds only for an allowed host |
| backend | `tests/agent_computer.rs` | policy validation (bad host → 400) |
| web | `12-team.spec.ts` | switch persists; self-check shows `network: none` |

**Deliberately not covered:** gVisor on CI unless `runsc` is installed; the
live test skips with that reason.

## Exit criteria

1. Live test proves an agent with internet off cannot resolve or connect out.
2. Live test proves the allowlist admits only the listed host.
3. With `AMIRO_SANDBOX_RUNTIME=runsc` and no gVisor installed, `ensure` returns
   an error naming `runsc`; the backend shows it on the Computer tab.

## Risks

- **DNS exfiltration through the proxy's resolver.** The proxy resolves only
  allowlisted names.
