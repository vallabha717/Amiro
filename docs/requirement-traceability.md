# Requirement-to-observation traceability

Audit run on October 14, 2026 after the initial delivery, over the rebuilt frontend and the hardened deployed adapter. This is a requirements matrix, not an inference from aggregate test counts. `PASS` applies only to the behavior named. A denied unauthenticated request does not establish that an authenticated mutation works.

## Explicit requests

| Request | Concrete check | Observed result | Scope / gap |
| --- | --- | --- | --- |
| Clone Amiro in Projects/Personal using gh | Repository exists at `/root/Projects/Personal/Amiro`, Git history and origin | Repository and committed changes present | Original command invocation not re-executed because recloning is unnecessary; historical gh invocation not independently proven by this audit |
| Use the existing Jcode daemon instead of another agent/Go backend | Real public `/api/chat` to bridge to daemon to provider, history GET, browser reload | Real replies and persisted history passed through HTTP and Chrome | Does not prove all former Go feature parity |
| Remove entire Go backend | Tracked backend removal commit `0e98d5a`; `pnpm start` serves Node adapter and public health/chat succeed | Node runtime serves active app; old tracked Go tree removed | Historical test fixtures retained and labeled retired |
| Keep current UI instead of using TUI | Sign-in, onboarding, chat and usage in Chrome on public IP | All tested flows work in existing UI, no TUI needed | Other legacy pages are not all end-to-end validated |
| Name application Amiro / use Jcode CLI | `./bin/amiro --version` | Delegates successfully to `jcode v0.95.0` | Upstream binary is not renamed internally; CLI wrapper itself does not enforce preview tool restrictions |
| Interactive provider login through chat | Browser types `/login`; records chat POST count | Panel opens, zero model requests for command | Dedicated authorization panel, not secrets in ordinary chat messages |
| Provider login through UI | Connect-provider button, actual Antigravity OAuth start, cancel, panel reset | Authorization initiation and cancellation passed without credential exchange | User consent/code exchange and API-key saving not executed; those would change credentials |
| Users can connect their own provider accounts | Credential ownership audit | Shared operator credential home, admin-only changes | NOT delivered as isolated per-user BYOK. Separate daemon/credential isolation remains |
| Map usage page to Jcode | Public stats API compared directly to real OpenAI daily buckets; browser visits usage page | Prompt/completion/total tokens and known cost match; shared-account disclaimer visible; range errors return 400 | Other-provider billing and per-user/model token attribution unavailable |
| Restrict harness | Actual SDK tool list after profile application; model allowlist rejection; cross-user HTTP tests; public unsupported endpoints | Tools reduced 34 to 0, disallowed model refused, ownership denied, unsupported execution 501 | Text-only preview policy is an assumption. No OS sandbox or final custom tool policy |
| Do not implement search | Public registered search interfaces | Authenticated endpoints return 501, model tools disabled | Legacy UI catalog compatibility remains; no active search execution |
| Use only requested swarm models | Worker routing metadata and reports | DeepSeek V4.1 Flash and Antigravity Gemini 3.8 Flash workers used | Not a claim about every pre-existing daemon session's model |
| Start server accessible by public IP | HTTPS Chrome and Node fetch against `194.238.18.234:8787` | Real sign-in, chat, OAuth begin/cancel, history and usage work; services active/enabled | Tested from this host; independent external-network reachability and trusted TLS not proven |
| Desktop application | Tauri local-launcher changes, actual attempted Cargo check | Full build blocked by missing host pkg-config/GTK/glib/WebKit dependencies | Portable installer and Windows executable NOT completed |
| Explain exact architecture with diagram | `docs/AMIRO-RUNTIME.md` and focused architecture panel | Mermaid diagram and transport/login/storage explanation delivered | Diagram includes local desktop path as an implementation path, not proof of a packaged installer |
| Implement everything | Explicit gap review above and route matrix below | Working owner-operated web preview delivered | Whole product is NOT complete. Do not present preview acceptance as complete legacy feature parity |

## Changed visible outputs and acceptance behavior

| Output | Check and observed result |
| --- | --- |
| `/sign-in`, sign-in component and auth-status hook | Real owner sign-in works; browser verifies sign-up link absent while registration disabled; wrong default password gets 401 |
| `/onboarding` | Real browser sees server-side/shared-runtime notice and reusable provider panel, skip reaches chat |
| Chat toolbar, empty greeting and `/login` panel | Toolbar button and `/login` command verified. Empty-greeting connection button and API-key submission are not independently exercised; same component is used, which is inspection evidence only |
| Chat streaming and title API | Real simultaneous first chat/title passed; UI renders exact assistant text; same-thread follow-up stays on same thread; both replies remain after reload |
| Provider OAuth panel and route family | Real start/cancel via Chrome passed; route authentication checked. Full callback/consent, successful credential replacement and device-code provider completion remain unverified |
| Usage page and user-statistics card | Public API equals actual Jcode daily buckets, no model-token allocation, valid default period, invalid ranges 400; usage-page disclaimer visible. Other user-detail navigation not separately exercised |
| Thread/message APIs | Persisted owner history passed. Isolated two-user HTTP test denied other-owner read/rename/delete/chat/title/export/message mutation, lists hid other owner's thread, delete-all preserved other owner's thread. Unmapped message mutation returns 404 before daemon call |
| Static server/proxy and CORS | `/`, sign-in, onboarding and usage each return 200 HTML with same-origin backend injection and one nosniff header. localhost:3210 allowed, unrelated origin 403. Duplicate proxy header found and fixed during this audit |
| Storage | Invalid capabilities and traversal 404, remote URL ingestion 501, anonymous upload-url 401. Successful upload/download, size-limit boundary, expiration timing and actual multimodal model delivery remain unverified |
| CLI and launch scripts | Branded CLI version executed successfully; static build passes and active service runs Node. Missing-binary failure was checked earlier. Windows .cmd launcher and clean-machine installers not executed |
| Tauri launcher | Earlier std-only helper tests exercised ephemeral port/readiness/timeout; complete desktop build attempted but blocked. No full desktop launch acceptance claim |
| Admin/archive/export/GitHub/MCP/skills/workflow/workspace-trust compatibility APIs | Each literal registered route's anonymous auth boundary and each GET's read smoke were exercised in `route-boundaries.mjs`; specific results in `route-observations.md`. Successful mutation feature parity remains unverified unless explicitly named above |
| README, launch instructions, architecture/verification and retired test/skill documents | Paths and evidence references reviewed; actual build/CLI/public workflow run. Fresh clean-machine quickstart and every historical document link not fully tested |

## Representative checks re-run over final implementation

- `pnpm exec tsc --noEmit && pnpm build`: passed, regenerated static UI. `pnpm exec vitest run --maxWorkers=2`: 363/363 baseline tests passed, useful regression evidence but not product acceptance by itself.
- `npm --prefix adapter test`: 4 usage cases passed, covering exact totals, invalid ranges, default range and unrelated-thread exclusion.
- `adapter/tests/integration.mjs`: 14 live-daemon assertions passed, including concurrent first chat/title, explicit/default pinned models, follow-up history, allowlist rejection, runtime route pin and disabled tools. Ran once at commit 4955620 and again after ownership hardening.
 - `adapter/tests/ownership.mjs`: 13 isolated two-user HTTP assertions passed after correcting unmapped/ownerless-session fail-opens. No preview users or passwords were changed.
- `adapter/tests/password.mjs`: 10 isolated password assertions passed after fixing the stale in-memory credential bug (5 of them failed before the fix). The live preview then served a real browser sign-in 9/9 with the owner-chosen shorter password.
- `adapter/test/public-contract.mjs` against public HTTPS: 12 requirement-specific checks passed, including real source parity rather than merely labeled mock data.
- `adapter/test/live-smoke.mjs` against public HTTPS: 13 API workflow assertions passed, real model reply, history and test archival included.
- `adapter/test/browser-smoke.mjs` against public HTTPS: 9 browser workflow checkpoints passed, same-thread follow-up and two-reply reload included; no page runtime errors or API 500s occurred.
- `adapter/test/route-boundaries.mjs`: 117 literal registered method/path entries mapped to HTTP observations. This is auth-boundary/read coverage, not 117 successful complete workflows.

Evidence artifacts: `/root/.jcode/scratch/amiro-route-acceptance.json` and `/root/.jcode/scratch/amiro-usage.png`. Test processes deliberately bypassed only the preview's self-signed certificate verification. Application TLS was not disabled.

## Why the result is concretely better

The earlier full UI failed on an unknown fresh session and could not show a model reply. The rebuilt public UI now renders real first and follow-up replies and restores both after reload. The ownership audit also identified a reachable fail-open: unmapped synthetic message IDs could reach the shared daemon. They now return HTTP 404, and a second user's reads/writes cannot change the first user's thread. Public usage now has observed numerical parity with the real Jcode source instead of unsupported per-model allocation. These are observable improvements, not source inspection alone.

The feedback loop is closed for the specifically tested web-preview workflows. It remains partial for the whole original product request because provider credential isolation, authorization completion, portable desktop delivery and other compatibility mutations are not complete or not exercised.
