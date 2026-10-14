# Amiro verification report

Verified on October 14, 2026. This report describes a working owner-operated web preview, not a completed multi-tenant product or portable desktop installer.

## Request and implementation assumptions

The requested direction is to retain Amiro's UI, remove its Go backend, use the existing Jcode daemon and CLI, expose provider login through chat and UI, map usage to Jcode, omit search, and start a public preview. The requested model routes were also used for swarm work and are the preview's allowlist.

Because final tool policies and credential tenancy were not specified, the implementation conservatively assumes one owner, shared operator-managed provider credentials, closed registration, and text-only sessions with no enabled tools. These are safety assumptions, not a claim that per-user provider accounts or a general-purpose assistant sandbox have been implemented.

## Observed acceptance checks

| Check | Observed result |
| --- | --- |
| Static frontend build and TypeScript | Workers ran `pnpm build` and TypeScript checks successfully; exported chat, onboarding, sign-in and usage pages exist |
| Frontend regression suite | `pnpm exec vitest run --maxWorkers=2`: 30 files and 363 tests passed |
| Adapter usage unit tests | `npm --prefix adapter test`: 4 passed, 0 failed |
| Real daemon integration | Worker ran `node adapter/tests/integration.mjs` against the real bridge in a temporary app home: 14/14 passed, including concurrent first chat/title, a follow-up turn, four persisted user/assistant messages, explicit model restrictions and no-tools configuration |
| Deployed API smoke | `node adapter/test/live-smoke.mjs`: 13/13 passed after final restart, including authenticated real provider streaming, history round trip, test archival, usage scope, rejected execution and invalid uploads |
| Public browser acceptance | Chrome visited `https://194.238.18.234:8787`: 8/8 passed, including owner sign-in, shared-runtime onboarding notice, visible provider panel, real OAuth initiation/cancel, `/login` interception without a chat request, real assistant text rendered, history after reload, and usage disclaimer |
| Services | `amiro.service`, `amiro-bridge.service`, nginx active; both Amiro services enabled; public HTTPS `/health` returns `{"status":"ok"}` |
| Source hygiene | Entire tracked Go backend retired in commit `0e98d5a`; `git diff --check` passes; adapter JavaScript syntax checked before final commit |

Browser screenshot: `/root/.jcode/scratch/amiro-usage.png`. Tests read the owner password locally without printing it. OAuth tests deliberately did not exchange authorization credentials or replace existing provider credentials. Test chats create small real provider usage.

## Weak points found and corrected

- Remote HTML originally pointed at localhost. Served HTML now selects the same-origin adapter.
- SDK session operations on a new connection require attachment to existing sessions. Chat/history/export/rename/rewind now use scoped attached connections.
- Attaching immediately after creating a fresh session can discard an unpersisted session. Fresh sessions are no longer redundantly attached; create operations are serialized. Concurrent first chat and title plus follow-up history have regression coverage.
- Missing model arguments originally risked a legacy default. Every turn now resolves an explicit permitted provider-qualified model; unavailable or disallowed models do not silently fall back.
- Tool configuration is fail-closed and applied before turns. Browser tool lists cannot widen runtime permissions.
- Usage cannot honestly allocate account-wide tokens and cost per model or user. The page exposes its shared-account, OpenAI-only coverage instead of fabricating allocations.
- Storage validates issued expiring capabilities, size and paths; remote URL ingestion is disabled.
- A default public password is not used. A generated owner secret is stored in a mode-0600 file, registration defaults closed, sign-in is rate-limited, and existing passwords were not reset.

## Remaining limitations and blockers

1. **Provider credentials are shared operator credentials.** Multiple untrusted users need isolated credential homes/daemons and per-user provider selection. Current provider mutation is admin-only.
2. **Desktop is not a portable distribution.** Tauri's launch path points at the local Node adapter. Bundled Node/dependencies, Jcode lifecycle and platform-specific launchers remain. Full Cargo validation is blocked by missing host `pkg-config` and GTK/glib/WebKit development dependencies. Installing a large system package upgrade on a host running another application was intentionally avoided.
3. **OAuth completion needs the user.** Actual provider initiation and cancellation were tested. Completing provider consent/code exchange was not tested because that would change the owner's credentials.
4. **Search and agent execution are not enabled.** Text chat works. Workflow execution, background execution, MCP execution/authorization, checkpoint restore and legacy skill generation return unsupported errors in this preview. The no-tools policy is not an OS sandbox.
5. **Usage coverage is incomplete by design.** OpenAI OAuth daily account totals and Jcode quota/activity data are surfaced. Other providers' billing and per-user token/cost attribution are not available from those sources.
6. **Attachments are not a verified multimodal workflow.** Safe storage endpoints do not prove images/files are delivered to the model.
7. **Preview TLS is self-signed.** A valid domain certificate, external network vantage-point test and production deployment hardening remain. Public-IP checks were performed from this host and Chrome on this host.

## Access and architecture

See [AMIRO-RUNTIME.md](AMIRO-RUNTIME.md) for the rendered architecture diagram, service layout, login instructions and CLI commands. The initial owner email is `admin@local`; read its generated password from `/root/.amiro-preview/admin-initial-password` on the server. That file and TLS private keys are outside the repository and must not be published.
