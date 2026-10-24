---
name: e2e-journeys
description: Amiro's recorded Playwright end-to-end journeys in tests/e2e (onboarding, provider, voice, chat, connectors/MCP, credentials, agent hub, agent-driven configuration, live voice, schedules, UX audit). Use whenever you add or change a user-facing feature, page, setting, agent tool, connector/auth flow or voice behaviour — the change must ship with a journey step that records it on video — and whenever asked to run the E2E tests, record a demo/review video, reproduce a UI bug end to end, or produce a review report for another agent.
---

# E2E journeys (Playwright, recorded)

Every user-facing change ships with an E2E step. The suite boots a **fresh
isolated Amiro** (empty `AMIRO_HOME`, never your `~/.amiro`), walks real user
journeys against the real model, and writes a captioned video + `REVIEW.md`.

## Run

| What | Command (from repo root) |
| --- | --- |
| One-time setup | `pnpm --dir tests install && pnpm --dir tests install-browsers` |
| Config | `cp tests/e2e.config.example.json tests/e2e.config.json` and fill keys (gitignored) |
| Everything | `pnpm test:e2e` |
| One journey (+ its onboarding/provider deps) | `pnpm --dir tests e2e --project connectors` |
| Several | `pnpm --dir tests e2e --project chat --project agent-driven` |
| Watch it live | add `--headed` (or `AMIRO_E2E_HEADLESS=false`) |
| Prereqs | `clients/web/out/index.html` (`pnpm build`), `backend/target/{release,debug}/amiro-backend`, a runtime binary (`clients/desktop/binaries/runtime-*` or `runtime/target/*/amiro-runtime`), `ffmpeg` for stitching |

Output (gitignored): `tests/recordings/<stamp>/` → `full-run.mp4` (title card +
chapters per test), `suites/<journey>.mp4`, `videos/*.webm`, `REVIEW.md`,
`review.json`, `html/`, `backend.log`. Hand `REVIEW.md` + the mp4 to a
reviewing agent; it already contains the review instructions.
`pnpm --dir tests e2e:feature --grep "<regex>"` cuts `feature-<slug>.mp4` +
`FEATURE-<slug>.md` with only the matching tests (setup journeys excluded).

## Add or extend a journey

1. Find the journey that owns the surface (table below). Add a `test(...)` or
   a `step(...)` there. New surface → new `NN-name.spec.ts` **and** add `name`
   to `JOURNEYS` in `tests/playwright.config.ts` (order = file number).
2. Import from `../support/fixtures` (`test`, `expect`, `need`) and
   `../support/chat` (`newChat`, `selectModel`, `send`, `ask`, `waitForReply`).
3. Wrap every user-visible action in `step("What the user does → what they see", ...)`.
   The title becomes the on-video caption and the report line — write it for a reviewer.
4. Any value the user must supply (API key, model, URL) goes in
   `tests/e2e.config.example.json` + the `E2EConfig` type + an `AMIRO_E2E_*`
   env mapping in `support/config.ts`. Guard with `need(cfg.x, "x")` → skipped with a reason, never failed.
5. Selectors: `getByRole`/`getByLabel`/`getByTestId`. If a control has no
   accessible name, add `aria-label`/`data-testid` in `clients/web/src/` rather than
   using CSS paths.
6. Model output varies: hard-assert the mechanism (tool call shown, card
   rendered, API state changed); `expect.soft` the wording.
7. Product bug found? Keep the journey going with `expect.soft(..., "what is wrong")`
   and `note("…")` — it lands in `REVIEW.md` with a timestamp. In the
   prerequisite journeys (`onboarding`, `provider`) never fail on a product
   bug — every other journey depends on them and would be skipped; use
   `note("…", "bug")` instead.
8. Secrets: never type into the chat composer. Agent-requested secrets go
   through `secret-prompt-card`; assert the value never appears in
   `main.innerText()` or any API response.
9. External services: prefer the offline fixtures — `fixtures/mcp-http-server.mjs`
   (MCP: open / bearer / API-key / OAuth with consent page, `GET /__calls` log)
   and `tests/fixtures/mcp/server/server.mjs` (stdio).
10. Run your journey alone (`--project <journey> -g "<your titles>"`), then cut
   the video of only your tests: `pnpm --dir tests e2e:feature --grep "<your titles>"`.
   Watch it and put the printed absolute paths (`feature-<slug>.mp4`,
   `FEATURE-<slug>.md`, per-test `.webm`) in your final answer.
11. Missing a key/account? Use fixtures/dummies or `need()` first; ask the owner
   only if there is no other way, and never for the value in chat (see `test`).

| Journey (project) | File | Owns |
| --- | --- | --- |
| onboarding | 01 | first run, account, agent look, sign-in/out |
| provider | 02 | Admin → Models & Providers, model test, chat model |
| voice | 03 | Admin → Voice & Speech (TTS/STT engines, voice, prefs) |
| chat | 04 | rendering, web search, visualize, swarm, skills, queue, threads |
| connectors | 05 | Connectors/MCP via UI, all auth styles, tool calls |
| credentials | 06 | vault UI, composer secret guard |
| agent-hub | 07 | personality, rename, memory, workspace, superpowers |
| agent-driven | 08 | agent configures search/MCP/OAuth/voice/model/schedules via chat |
| voice-live | 09 | read-aloud, dictation, live voice room (fake mic) |
| schedules | 10 | schedules page, heartbeat |
| ux-audit | 11 | every page × desktop/phone: a11y names, h1, overflow |
| team | 12 | Team view, channels, New agent wizard, agent page, per-agent workspace |
| notifications | 13 | Bell inbox, chat replies notify only after you leave, chat-list status marks |
| channels-contacts | 14 | Channels bot check, Contacts code verification, delivery outside Amiro (offline provider stub) |

## Don't

- Don't point the suite at your real instance unless `target.mode: "external"` is intended.
- Don't use `page.waitForTimeout` to wait for state; wait on a locator/response.
  Short pauses only to let the video show a result.
- Don't commit `tests/e2e.config.json` or `tests/recordings/`.
- Unix socket paths cap at ~108 bytes: the isolated root lives in `/tmp/amx-e2e-*` for that reason.
