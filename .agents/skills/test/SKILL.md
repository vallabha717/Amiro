---
name: test
description: Amiro's testing standards — which test layer proves which change and how to run each one. Covers frontend unit tests (Vitest, co-located *.test.ts(x)), type-check and lint, backend integration tests (backend/tests/*.rs against the real axum router), runtime crate tests, the std-only Rust testkit, and the recorded Playwright E2E journeys in tests/e2e (isolated instance, captioned video, REVIEW.md). Use at the end of every feature or fix to decide and run the right tests, whenever asked to write, run, fix or debug tests, chase a flake, check coverage, or prove a change works end to end.
---

# Amiro testing standards

Testing is part of the change, not a follow-up. Pick every layer your change
touches, write the test next to the code, run it, and report the real result
(pass, fail with output, or "not run because …"). Never delete or weaken a
test to get green.

## Which layer proves what

| You changed | Write / update | Where | Run |
| --- | --- | --- | --- |
| A TS helper, hook, store, component | Vitest unit/component test | co-located `clients/web/src/**/<name>.test.ts(x)` | `pnpm test` (single: `pnpm vitest run <path>`) |
| Any TS (incl. E2E specs) | — | — | `pnpm check-types` · `pnpm lint` |
| A backend route / persisted setting | Integration test via `router().with_state(fixture)` + `oneshot` | `backend/tests/<area>.rs` (copy the fixture in `tests/voice.rs`) | `cargo test --manifest-path backend/Cargo.toml` |
| Backend pure logic / agent tool | `#[cfg(test)] mod tests` | bottom of the module / `agent_mcp.rs` | same as above |
| `runtime/` (local patch) | crate test next to the code; record the patch in `docs/runtime-customizations.json` | `runtime/crates/<crate>/src/**` | `pnpm runtime:check` + `cargo test --manifest-path runtime/Cargo.toml -p <crate>` |
| Translations | key + `{placeholder}` parity en↔hi | `clients/web/messages/` | `pnpm check:i18n` |
| **Anything a user can see or trigger** | a `step(...)` in the owning E2E journey | `tests/e2e/specs/NN-<journey>.spec.ts` | `pnpm build` then `pnpm --dir tests e2e --project <journey>` |

Which journey owns which surface, the config file for keys, fixtures (offline
MCP server with open/bearer/API-key/OAuth), and the video/REVIEW.md output:
load the **`e2e-journeys`** skill.

## Writing good tests here

- **Backend integration**: cover happy path, 401 (no token), 403 (non-owner
  on owner-only routes), 400 (bad input), and that secrets never appear in the
  response body. Use a temp home per test; never touch `~/.amiro`.
- **E2E**: wrap each user action in `step("What the user does → what they see")`
  (it becomes the video caption). Prefer `getByRole`/`getByLabel`/`getByTestId`;
  add a `data-testid` in `clients/web/src/` rather than CSS paths. Hard-assert the
  mechanism (card shown, API state changed, tool call visible); `expect.soft`
  model wording. Product bug found → `expect.soft(…, "what is wrong")` +
  `note("…", "bug")` so the journey keeps recording. Values a user supplies go
  in `tests/e2e.config.example.json`, guarded with `need()`.
- **No sleeps for state**: wait on a locator, response or `expect.poll`.
  Short pauses only so the video shows a result.
- **Flakes**: re-run the single test alone; if it passes alone and fails under
  load, record it as timing-sensitive (don't hide it). Compare against the
  base revision before calling a failure a regression.

## Need something from the owner to test?

Ask only when there is **no other way**. First try, in order:
1. the offline fixtures (`tests/e2e/fixtures/mcp-http-server.mjs` for MCP with
   open/bearer/API-key/OAuth, `tests/fixtures/mcp/server/server.mjs`), a
   dummy value (the agent-driven journey uses a fake Brave key), or a local stub;
2. a value already in `tests/e2e.config.json` or an `AMIRO_E2E_*` env var;
3. guarding the step with `need(cfg.x, "x")` so it **skips with a reason**
   instead of failing, while everything else still runs.

Only if the feature genuinely cannot be proven without it (a real provider
API key, a real OAuth account, a paid service, a device), ask the owner one
short question that says exactly what you need, why, and where it goes:
"add `<key>` to `tests/e2e.config.json` (gitignored) or set `AMIRO_E2E_<NAME>`".
Never ask for a secret to be pasted into chat, never hardcode it in a spec,
and don't stop the rest of the work while you wait: finish what can be
tested and list the skipped step in the final answer.

## End-of-feature test run (copy this)

```bash
pnpm check-types && pnpm lint && pnpm test                     # always
cargo test --manifest-path backend/Cargo.toml                  # backend/ touched
pnpm runtime:check                                             # runtime/ touched
pnpm build && pnpm --dir tests e2e --project <journey>         # user-visible
```

Then cut the recording of only your change and watch it:

```bash
pnpm --dir tests e2e:feature --grep "<your test titles>"
```

It prints the absolute paths of `feature-<slug>.mp4` (only your tests, back
to back), `FEATURE-<slug>.md` (timestamped steps, notes, errors) and each
test's own video. For release-level confidence run all
journeys: `pnpm test:e2e` (needs provider keys in `tests/e2e.config.json`).

## Report

List each command, its result, what you did not run and why, and any known
flakes/pre-existing failures (with the evidence that they pre-exist). For any
user-visible change, **end with the absolute paths printed by `e2e:feature`**
(feature video, FEATURE report, per-test videos) so the owner can verify only
what you built and suggest changes — see the template in `develop-feature`.

History: the Go `tests/` harness (`amirotest`, `harness.New(t)`, cassettes,
`suites/meta`) and the old `tests/ui` Playwright specs are retired. Their
replacements are the layers above.
