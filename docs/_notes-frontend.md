# Frontend notes (worker 3) — /login panel, usage page, build

Scope: frontend only. No changes to `adapter/` or `backend-go/`, nothing committed.

## Files changed / created

- **Created** `src/components/chat/login-panel.tsx` — the inline provider panel.
- **Changed** `src/components/chat-bot.tsx` — intercepts `/login` in the composer
  (`handleComposerSend`, wraps `sendMessageAnsweringPlan`), owns
  `isLoginPanelOpen`, renders `<LoginPanel>` above the composer.
- **Changed** `src/app/(chat)/(admin)/admin/usage/page.tsx` — added a defensively
  hidden Quota & Limits section; existing stats fields left untouched.

## /login intercept (task 1)

- The real submit lives in `src/components/prompt-input.tsx` (`submit()` →
  `sendMessage(...)`); chat-bot passes the send function down. Interception is
  therefore in chat-bot's wrapper so it runs **before** `useChat` appends the
  message — the command never enters the transcript and is never POSTed to
  `/api/chat`.
- Match is exact, trimmed, case-insensitive `/login` on a single text part.
  `/login foo`, `/login` + attachments, or `/login` embedded in prose fall
  through to the model unchanged.
- Panel: provider picker → masked key input (reveal toggle) → Save → success /
  error alert. Key is local component state only, cleared on success, never
  toasted/logged/messaged. OAuth providers show `jcode login <id>` terminal
  instructions instead of a key field.
- Save calls the existing `saveProvider` (`POST /api/ai/providers`), reusing an
  existing connection id when one matches, then revalidates login-status,
  `PROVIDERS_KEY`, and `/api/chat/models`.

## Guesses the adapter must match

- `GET /api/providers/login-status` mirrors `jcode auth status --json`. Verified
  live shape: `{ any_available, providers: [{ id, display_name, status, method,
  auth_kind, recommended, ... }] }`. The panel accepts **either** that object or
  a bare `providers` array. `auth_kind` containing "oauth" ⇒ terminal login;
  anything else ⇒ key field. `status === "available"` ⇒ "Connected".
- Fallback when login-status fails: `GET /api/ai/providers` (`ProviderConfig[]`,
  mapped to `{id: provider, display_name: name, auth_kind: "API key"}`).
- Provider POST uses `{ id?, name, provider: <login-status id>, apiKey, baseUrl,
  models }` — i.e. `provider` is the jcode auth id (e.g. `anthropic-api`), which
  the adapter must map to a provider type for `setApiKey`.

## Usage page (task 2)

- Contract `GET /api/admin/users/:id/stats` shape = `{ user, stats: { threadCount,
  messageCount, modelStats[], totalTokens, promptTokens, completionTokens,
  dailyUsage[], period } }`. Verified field-for-field against
  `UserStatsData` in `user-statistics-card.tsx`: **no differences, no field
  changes made.**
- Limits: the contract does not require limits in the stats payload, so the
  section is *additive and hidden by default*. It reads `stats.limits` or
  `stats.providerLimits` (array of `{name, usage_percent, resets_at?, reset_in?,
  provider?}` — names from `jcode usage --json`). If the adapter names the field
  differently, the section simply stays hidden; nothing breaks.

## Build (task 3)

- `pnpm install` → ok (ignored build scripts for @google/genai, @parcel/watcher,
  @swc/core, protobufjs — none block the export).
- `pnpm build` (`next build`, static export) → **pass**, exit 0, 31 static
  routes generated, no code changes needed to unblock it.
- Verified `out/index.html` (20,762 bytes), `out/admin/usage.html`,
  `out/_next/` all present. No server started.

## OAuth round 2 (interactive provider login)

Contract confirmed against `adapter/src/routes/provider-login.mjs` (chipmunk),
registered in `adapter/src/routes/index.mjs`:

- `POST /api/providers/:id/oauth/start` → `{ flow, authorizationUrl, userCode?,
  verificationUri?, interval?, expiresIn, flowId }`; `:id` is the jcode auth id
  (`claude`, `openai`, `gemini`, `antigravity`, `copilot`, `google` only; other
  providers 400 with "configure with an API key").
- `GET /api/providers/:id/oauth/status` → `{ status: pending|authorized|error|
  expired, error? }` (404 when no flow exists).
- `POST /api/providers/:id/oauth/callback` → body `{ code | callbackUrl | url }`,
  response `{ status: authorized|error, error? }`.
- `DELETE /api/providers/:id/oauth` (and `POST .../oauth/cancel`) cancel.
- `interval` is in **seconds** for device flows; the panel normalizes
  (`<1000` ⇒ ×1000, clamped 1–10 s). `expiresIn` is seconds (default 300 s).
- Frontend sends `callbackUrl+url+code` for URL-looking input and `code+authCode`
  for a bare code; adapter reads `code || callbackUrl || url`, so both land.
- Flows requiring admin: a non-admin gets 403, shown as the error message.

Panel behavior: OAuth providers get "Sign in with X" → start → auth-URL button
and/or device code with copy → code/callback input → status polling → success /
error / cancel / "Start again". Terminal `jcode login <provider>` remains as a
collapsed fallback. Secrets (key, auth URL, device/user code, callback URL) stay
in component state only; never logged, toasted, or sent to `/api/chat`.
Success is only shown after the backend reports `authorized`/`status: success`.

## usageNotice (from seedling)

- `UserStatsData.usageNotice?: string` added; whenever supplied it renders as an
  `Alert` (`data-testid="usage-notice"`) at the top of `UserStatisticsCard`,
  which is the single stats surface used by the admin usage page. Backend usage
  file untouched.

## Build (round 2)

- `npx tsc --noEmit` → clean. `pnpm build` → **pass**, exit 0.
- Verified `out/index.html` and `out/admin/usage.html` present. No server started.

## Visible UI entry points + onboarding (round 3)

- Chat composer toolbar: `Connect provider` ghost button, `data-testid="connect-provider-button"`.
- Chat empty state (ChatGreeting): `Connect provider` outline button,
  `data-testid="connect-provider-empty-button"`. Both open the same `LoginPanel`.
- Login panel selectors: `login-panel` (root), `login-panel-close`,
  `login-provider-select`, `login-api-key`, `login-api-key-save`,
  `login-oauth-start`, `login-oauth-code`, `login-oauth-submit`,
  `login-oauth-cancel`.
- Onboarding (`src/app/onboarding/page.tsx`) rewritten: bespoke hardcoded
  provider list + OS-keychain claim removed; now shows a shared-runtime notice
  (`data-testid="onboarding-runtime-notice"`) and embeds `LoginPanel`; footer
  `onboarding-skip-button` + `onboarding-continue-button` (step 1),
  `onboarding-finish-button` (step 2). Old `onboarding-provider-*`,
  `onboarding-api-key-input`, `onboarding-base-url-input`, `onboarding-save-button`
  are gone.
- `useAuthStatus` typed with `registrationEnabled?: boolean`; sign-in hides the
  "no account? sign up" link when it is `false` (adapter already sends it).

## Build (round 3)

- `npx tsc --noEmit` clean; `pnpm build` PASS exit 0; `out/index.html`,
  `out/onboarding.html`, `out/sign-in.html`, `out/admin/usage.html` verified.
