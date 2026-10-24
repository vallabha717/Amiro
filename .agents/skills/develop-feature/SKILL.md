---
name: develop-feature
description: The step-by-step workflow for coding or developing any feature, fix or change in Amiro, from first read to a tested, committed result. It sequences the other skills — amiro-standards (where things go, rules), backend (Rust API standards and folder structure), ui (Next.js standards and folder structure), test and e2e-journeys (testing at the end), amiro-runtime-update (engine changes) — and says exactly when to load each. Use whenever you are about to write code in this repository: "build/add/implement a feature", "add a page/setting/endpoint/agent tool", "fix this bug", "change how X works", or when unsure what order to do things in or what "done" means.
---

# Develop a feature in Amiro

Follow the phases in order. Each phase names the skill to load — read it when
you reach that phase, not before. Skip a phase only when the change truly
does not touch that layer, and say so in the final report.

## 0 · Orient (always)

1. Load **`amiro-standards`**: where each kind of change goes, the
   non-negotiable rules (secrets, English+Hindi, honesty), naming.
2. Read the code you will touch and one neighbouring feature that already
   does something similar — copy its shape.
3. `git status` — note uncommitted work that is not yours; never stash,
   revert or commit it.
4. Write a short plan in your own words: user goal → backend change → UI
   change → tests. Multi-phase initiative? Use **`plan`** then **`implement`**.

## 1 · Backend (if the feature needs data, an endpoint, a setting or an agent tool)

Load **`backend`**. Then:

- [ ] Route in `backend/src/routes/<area>.rs` (`pub fn routes()`, merged in
      `src/routes.rs`) or the owning top-level module
- [ ] `AuthUser` on every non-public handler; owner check for admin actions
- [ ] Persist under `AMIRO_HOME/store` with the store lock; secrets only in the vault
- [ ] Agent should be able to do it from chat? Add the `<area>_<verb>` tool in
      `agent_mcp.rs` calling the same function; secrets via the secure card
- [ ] Integration test in `backend/tests/<area>.rs`; `cargo test --manifest-path backend/Cargo.toml`

Engine behaviour (agent loop, providers, MCP client, memory)? That is
`runtime/` — load **`amiro-runtime-update`** and record the patch in
`docs/runtime-customizations.json`.

## 2 · UI (if anything is visible or triggerable)

Load **`ui`**. Then:

- [ ] Typed client functions in `clients/web/src/lib/backend/<area>-api.ts` (`apiJson`)
- [ ] Thin page in `clients/web/src/app/(chat)/…/page.tsx`; components in `clients/web/src/components/<feature>/`
- [ ] `useSWR` + `mutate`; `toast` feedback; errors shown, not swallowed
- [ ] Strings in `clients/web/messages/en.json` **and** `clients/web/messages/hi.json`; `pnpm check:i18n`
- [ ] Theme tokens (light + dark), `ui/*` primitives, aria-labels, `data-testid`s
- [ ] Vitest test next to any non-trivial helper/component

## 3 · Test (always, at the end)

Load **`test`** (which layer proves what), and **`e2e-journeys`** for the
recorded browser journey. Then run, in this order, and keep the output:

```bash
pnpm check-types && pnpm lint && pnpm test                 # always
pnpm check:i18n                                            # clients/web/messages/ touched
cargo test --manifest-path backend/Cargo.toml              # backend/ touched
pnpm runtime:check                                         # runtime/ touched
pnpm build && pnpm --dir tests e2e --project <journey>     # user-visible change
```

- [ ] New/updated `step(...)` in the owning journey (`tests/e2e/specs/NN-*.spec.ts`).
      Give your tests titles that name the feature, so they can be picked out
- [ ] Run only what you touched: `pnpm --dir tests e2e --project <journey> -g "<your test titles>"`
      (onboarding/provider always run first to set up a fresh instance)
- [ ] Cut the recording of **only your feature** and watch it:
      `pnpm --dir tests e2e:feature --grep "<your test titles>"` → prints
      `feature-<slug>.mp4` (just your tests, back to back) and `FEATURE-<slug>.md`
      (status, own video and timestamped steps per test)
- [ ] Any failure: fix it, or prove it pre-exists on the base revision — never
      delete or weaken the test

### Need something from the owner to test?

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

## 4 · Finish

- [ ] `git diff --check`; only your files staged
- [ ] Docs updated where behaviour is described (`README.md`, `docs/*.md`, skill files)
- [ ] Conventional Commit per concern: `type(scope): imperative summary`
      (e.g. `feat(connectors): …`, `fix(voice): …`, `test(e2e): …`)
- [ ] Report in the final answer (template below) — always with the recording paths

## Final answer template (required)

```
What I built: <one or two sentences, user-facing>

Verify it here (only this feature):
  ▶ Video:  /abs/path/tests/recordings/<stamp>/feature-<slug>.mp4
  📄 Steps: /abs/path/tests/recordings/<stamp>/FEATURE-<slug>.md
  Per test:
    ✅/❌ [<journey>] <test title> — /abs/path/…/videos/NN-<journey>--<test>.webm
  What to look at: @mm:ss <step worth checking>, @mm:ss <…>

Checks run: <command> → <result>, … · Not run: <what> because <why>
Needs from you (only if unavoidable): <value> → put it in <where>; skipped until then
Files changed: <list>   Known issues / follow-ups: <list or none>
```

Paste the absolute paths printed by `e2e:feature`, never the whole-run
`full-run.mp4`, and never a placeholder. No user-visible change (pure
refactor or backend-only)? Say so and give the backend/unit test results
instead of a video. A test failed? Still give the paths (the video shows the
failure) and say what is wrong.

## Skill map

| Need | Skill |
| --- | --- |
| Where does X go? Rules? Naming? | `amiro-standards` |
| Rust API, auth, storage, vault, agent tools | `backend` |
| Pages, components, data fetching, i18n, styling, a11y | `ui` |
| Which tests, how to run them, flakes | `test` |
| Recorded Playwright journeys, config, videos | `e2e-journeys` |
| Changing or updating the vendored engine | `amiro-runtime-update` |
| Planning / executing a multi-phase initiative | `plan` → `implement` |
