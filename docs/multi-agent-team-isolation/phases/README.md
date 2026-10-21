# Phases

```
            ┌──────────────────────────────┐
            │ 00 Agent computer (L)        │  supervisor, container per agent,
            │                              │  per-agent credential, shell+files policy
            └──────┬───────────────┬───────┘
                   │               │
     ┌─────────────▼──────┐  ┌─────▼──────────────────────┐
     │ 01 Egress + gVisor │  │ 02 Lifecycle + activity (M) │
     │ (M)                │  │                             │
     └─────────┬──────────┘  └─────────────────────────────┘
               │
     ┌─────────▼──────────┐
     │ 03 Browser (L)     │
     └────────────────────┘
```

| Phase | Title | Depends on | Blocks | Size | Surfaces |
| --- | --- | --- | --- | --- | --- |
| [00](phase-00-agent-computer.md) | Agent computer | — | 01, 02, 03 | L | backend, supervisor, web |
| [01](phase-01-egress-and-gvisor.md) | Egress restriction and gVisor | 00 | 03 | M | supervisor, backend, web |
| [02](phase-02-lifecycle-and-activity.md) | Lifecycle and activity | 00 | — | M | backend, supervisor, web |
| [03](phase-03-browser.md) | Browser in the container | 00, 01 | — | L | supervisor image, backend, web |

## Rules for every phase

1. Done means the exit criteria were **run** and their output read — not that
   code exists.
2. Every phase ships its own tests: backend integration tests in
   `backend/tests/`, unit tests next to pure logic in `backend/sandboxd/`, a
   live-Docker test that skips with a reason when Docker is absent, and a step
   in `tests/e2e/specs/12-team.spec.ts` for anything the owner can see.
3. No host fallback, ever. A phase that adds a tool adds a test proving the
   tool fails closed when the supervisor is down.
4. No secret in a response, a log line, a tool result, a container env or a
   fixture. A phase that adds a secret adds the assertion.
5. English and Hindi for every string; `pnpm check:i18n` passes.
6. Every phase updates the docs it invalidates: `docs/SECURITY-MODEL.md`,
   `docs/multi-agent-team/02-design.md` (Isolation), this folder's
   `progress/`.
7. Nothing regresses: `cargo test --manifest-path backend/Cargo.toml` and the
   `team` journey stay green.
