# Amiro E2E journeys

Recorded Playwright journeys through the whole product, from a first run to
the agent configuring itself. Each run boots a brand-new isolated Amiro, uses
the real model you configure, and produces a captioned video plus a review
report another agent can act on.

## Quick start

```bash
pnpm --dir tests install
pnpm --dir tests install-browsers
cp tests/e2e.config.example.json tests/e2e.config.json   # then fill in keys
pnpm test:e2e                                             # everything
```

Run one journey (its onboarding/provider prerequisites run first, on a fresh instance):

```bash
pnpm --dir tests e2e --project connectors
```

Recording of only what you built (for the owner to verify):

```bash
pnpm --dir tests e2e:feature --grep "<your test titles>"
```

It prints `recordings/<stamp>/feature-<slug>.mp4` (only the matching tests),
`FEATURE-<slug>.md` (timestamped steps) and each test's own video.

Projects: `onboarding`, `provider`, `voice`, `chat`, `connectors`,
`credentials`, `agent-hub`, `agent-driven`, `voice-live`, `schedules`,
`ux-audit`. Add `--headed` to watch.

## Configuration (`tests/e2e.config.json`, gitignored)

| Key | Used by | Notes |
| --- | --- | --- |
| `provider.label/id/apiKey/model` | everything after onboarding | e.g. OpenCode Go / `opencode-go` / `muse-spark-1.2-contributor` |
| `provider.fallbackModel` | everything | used automatically if `model` is not offered (e.g. `deepseek-v4.1-flash`) |
| `voice.ttsApiKey` (+ `ttsVoiceId`, `sttApiKey`) | voice, voice-live | ElevenLabs. Also used to speak the fake-mic question |
| `search.braveApiKey` | agent-driven | optional; a dummy key is used to exercise the secure card otherwise |
| `composio.apiKey` | connectors | optional |
| `mcp.*` | connectors, agent-driven | tokens the offline MCP fixture expects |
| `target.mode` | all | `isolated` (default) or `external` with `target.baseUrl` |
| `recording.*` | all | video on/off, headless, slowMo, viewport, captions, stitching |

Every key has an `AMIRO_E2E_*` env override (see `support/config.ts`), e.g.
`AMIRO_E2E_ELEVENLABS_API_KEY=… pnpm test:e2e`. A journey that needs a value
you left empty is **skipped with the reason**, not failed.

## Output (`tests/recordings/<timestamp>/`, gitignored)

| File | What |
| --- | --- |
| `full-run.mp4` | every test back to back, a status title card before each, MP4 chapters per test |
| `suites/<journey>.mp4` | one video per journey |
| `videos/NN-<journey>--<test>.webm` | raw per-test recordings |
| `REVIEW.md` / `review.json` | steps with timestamps into `full-run.mp4`, errors, console errors, failed API calls, UX notes, and instructions for a reviewing agent |
| `html/` | Playwright HTML report (traces for failures) |
| `backend.log`, `mcp-fixture.log` | logs of the isolated instance and the MCP fixture |

## Layout

```
tests/
  playwright.config.ts          projects = journeys; video, captions, reporters
  e2e.config.example.json       committed template for e2e.config.json
  e2e/
    specs/NN-<journey>.spec.ts  the journeys
    support/
      config.ts                 config + env overrides
      global-setup.ts           MCP fixture + isolated backend/runtime + fake-mic audio
      global-teardown.ts        stops and deletes the isolated instance
      fixtures.ts               test/step/note/need, captions, diagnostics, api()
      chat.ts                   newChat/selectModel/send/ask/waitForReply
      review-reporter.ts        videos → full-run.mp4 + REVIEW.md
    fixtures/mcp-http-server.mjs  offline MCP: open | bearer | apikey | oauth
  fixtures/mcp/server/server.mjs  offline stdio MCP
```

Adding tests: follow `.agents/skills/e2e-journeys/SKILL.md`.
