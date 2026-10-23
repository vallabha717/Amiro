---
name: amiro-standards
description: The single entry point for working in the Amiro repository (self-hosted AI agent: Next.js static UI in clients/web/src/, Rust axum backend in backend/, vendored jcode-derived runtime in runtime/, Tauri shell in clients/desktop/). Covers where code goes, the folder structure and naming, frontend/backend/runtime rules, English+Hindi i18n, secrets, recorded Playwright E2E journeys, required checks, commit conventions and which deeper skill to load next. Use at the start of ANY task in this repo — adding or changing a feature, page, API route, agent tool, connector, setting, translation, test, doc or script, fixing a bug, reviewing a change, or preparing a commit/PR — and whenever unsure where something belongs or what "done" means here.
---

# Amiro standards

Load this first for any Amiro task. It routes you to the deeper skill and
holds the rules every change must meet. Details: [reference/layout.md](reference/layout.md),
[reference/recipes.md](reference/recipes.md), [reference/done.md](reference/done.md).

## The product in one breath

`amiro-backend` (Rust, `backend/`) serves the static UI (`clients/web/out/`, built from
`clients/web/src/`) and the JSON API on one port, and owns the runtime bridge.
`amiro-runtime` (Rust, `runtime/`, a rebranded fork of jcode) runs the agent
loop, providers, tools, MCP and memory. `clients/desktop/` wraps it as a desktop
app. `adapter/` is retired; never build on it. There is no Go.

## Where does my change go?

| You are changing | Put it in | Then load |
| --- | --- | --- |
| Building a whole feature (backend → UI → tests) | follow the workflow | `develop-feature` |
| A page / component / UI text | `clients/web/src/app/**`, `clients/web/src/components/**`, strings in `clients/web/messages/en.json` **and** `clients/web/messages/hi.json` | `ui` |
| A call from the UI to the API | `clients/web/src/lib/backend/<area>-api.ts` via `apiJson` | `ui` |
| An HTTP route / persistence / auth | `backend/src/routes/<area>.rs` (`pub fn routes()`, merged in `src/routes.rs`) | `backend` |
| A tool the agent can call (configure X, open card) | `backend/src/agent_mcp.rs` tool list + handler | `backend` |
| Agent loop, providers, MCP client, memory, TUI | `runtime/` — only as a local patch, recorded in `docs/runtime-customizations.json` | `amiro-runtime-update` |
| Pulling a new jcode upstream | never by hand-copying | `amiro-runtime-update` |
| Tests for any change | the right layer(s) | `test` |
| A user-visible flow | a step in `tests/e2e/specs/NN-*.spec.ts` | `e2e-journeys` |
| Planning a multi-phase initiative | `docs/<initiative>/` | `plan`, then `implement` |
| A new skill | `.agents/skills/<kebab-name>/SKILL.md` | `.agents/skills/README.md` |

## Rules that apply to every change

1. **Secrets never travel through chat.** Agent tools ask with the secure card
   (`ui_prompt_secret` / connector setup card) or an OAuth card; values go to
   the encrypted vault. Never log, echo, commit or put a key in a fixture.
2. **Languages: English and Hindi only.** Every new string goes into both
   `clients/web/messages/en.json` and `clients/web/messages/hi.json` with the same key and
   `{placeholders}`. Never hardcode user-facing English in components that
   already use `useTranslations`. Speech languages: English, Hindi, auto-detect.
3. **Every user-facing change ships with an E2E journey step** and you watch
   its recording (`e2e-journeys` skill). Values a user supplies go in
   `tests/e2e.config.example.json`, never in a spec.
4. **Honest product.** No UI for capabilities that don't exist; no doc claim
   before it works end to end; say when behaviour comes from the runtime.
5. **Don't fork history or others' work.** Never stash, reset, or commit
   someone else's uncommitted changes; never force-push `main`.
6. **Runtime is a fork.** Keep `AMIRO_ALLOW_UPSTREAM_UPDATE` /
   `AMIRO_ALLOW_UPSTREAM_TELEMETRY` default-deny. Don't mass-rename
   `jcode` strings: URLs, `~/.jcode` compat paths, subscription ids and
   licence text stay upstream.
7. **No build output in git:** `clients/web/out/`, `node_modules`, `*/target/`,
   `clients/desktop/binaries/`, `tests/recordings/`, `tests/e2e.config.json`.

## Definition of done (short form — full list in reference/done.md)

```bash
pnpm check-types && pnpm lint && pnpm test                 # frontend (+ e2e specs typecheck)
pnpm check:i18n                                            # if clients/web/messages/ changed
cargo test --manifest-path backend/Cargo.toml              # if backend/ changed
pnpm runtime:check                                         # if runtime/ changed
pnpm --dir tests e2e --project <journey>                   # if anything user-facing changed
```

Commit as Conventional Commits: `type(scope): imperative summary` (types
`feat fix test docs build style refactor perf security a11y chore`; scopes
`backend runtime agent agent-ui schedules search providers sidebar usage test docs i18n e2e`).
Report what you ran and what you did not run; never claim green you didn't see.
