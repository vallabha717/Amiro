# adapter-core dev notes (worker 1)

Files: `adapter/package.json`, `adapter/src/{server,jcode,auth,store,chat,threads,models}.mjs`.
No commits made, nothing deleted. Smoke test passed (see bottom).

## Worker 2 contract (also documented at top of `server.mjs`)

`adapter/src/routes/index.mjs` must export `registerRoutes(app, ctx)`. The import
in `server.mjs` is dynamic + resilient so adapter-core boots before worker 2 lands.
- `app.get/post/put/delete/all(pattern, handler)`, `:param` segments supported.
- handler signature `(req, res, params)`; `req.user` set on authenticated routes.
- `ctx` = `{ config, log, store, jcode, auth, app, readJson, json, error, sse, nowIso, requireUser }`.
- `ctx.sse(res)` returns the UI-message-stream writer (`start/startStep/textStart/
  textDelta/textEnd/reasoning*/toolInput*/toolOutput*/data/error/finish/done`),
  headers already written. `finish(meta)` then `done()` emits `data: [DONE]`.
- `ctx.auth.listUsers()` / `ctx.auth.getUser(id)` are available for the admin routes.

## Guesses / unknowns (verify against the frontend + live daemon)

1. **users.json / sessions.json shape.** Guessed `{users:[{id,name,email,role,
   passwordHash:"salt:scrypthex",createdAt,image?,lastLogin?}]}` and
   `{sessions:{<token>:{userId,createdAt}}}`. Admin seeded `admin@local` / `admin`.
   Go used a DB, so these shapes are ours alone.
2. **Message ids are synthesized** (`msg_<historyIndex>_<sessionId>`) because jcode
   `HistoryMessage` has no persisted id and no timestamp. `createdAt` on history
   messages is always "now" (guess). Delete = `rewind(index)` (removes that
   message + after); truncate = `rewind(index+1)`. **Rewind index semantics
   unverified** (does it keep or drop the given index?).
3. **Role mapping**: jcode `tool` rows -> assistant text parts (history is
   text-only: `{role,content,response_stats?}`); tool *calls* are not structured
   in history, only in the live event stream.
4. **Export store** is `$AMIRO_HOME/store/exports.json`, record shape
   `{id,title,exporterId,originalThreadId,threadId,createdAt,expiresAt,messages,
   commentCount}`. `POST /api/chat/export` (chat.mjs) writes it; worker 2's
   GET/DELETE `/api/export*` must read/delete the same file. Response body is a
   **bare JSON string** id.
5. **Provider/model shape.** `/api/chat/models` groups models by the prefix before
   `/`; live `listModels` returned **bare names** (`claude-opus-5-5`, `gpt-5.6-luna`)
   so everything collapsed under provider `"default"`. `providerName`=id,
   `providerType`="jcode", `hasAPIKey`=true when auth status lists any provider.
   Provider ids from `/api/ai/providers` are `slug(provider_name)`. `setModel` is
   passed the frontend's `chatModel.model` verbatim; on failure we keep the
   session default (logged).
6. **Permission policy** (per seedling's correction): `permissionMode` `auto`/`edit`
   runs the turn; any other mode ends the stream immediately with a text part
   telling the user to switch to auto/edit. Never waits for `permission_request`
   (bridge does not advertise `permissions`).
7. **Attachments.** Inline `data:` URLs become jcode `ImageAttachment`s; other URLs
   are appended to the prompt as `[attachment: url]` (no upload pipeline in core).
8. **Streaming uses a dedicated JcodeClient per turn** (`ctx.jcode.withIsolated`),
   because the bridge attaches one session per connection. Short ops (thread
   list/history/rename/archive, setApiKey) use the shared client (`ctx.jcode.api`).
   Concurrent rename during a live stream is therefore not covered.
9. **Title generation** runs in a throwaway session, then `renameSession` on the
   real session (rename adds no transcript rows) and upserts the mapping. Title
   SSE mirrors Go's `title.go`: full UI-message stream (start/start-step/
   text-start/text-delta/text-end/finish-step/finish/[DONE]).
10. **Temporary chat** creates an ephemeral session, streams, then detach+archive.
11. **CORS** preflight + permissive headers were added (not in the contract) so the
    Next dev server on another origin can call port 8787.
12. **Static export** served from `<repo>/out` with `.html`/`index.html` fallbacks;
    if `out/` is absent the API still works. No `__BACKEND_ORIGIN__` injection.
13. **Usage readers** live in jcode.mjs: `jcodeUsage()`, `readOpenAiOauthUsage()`,
    `readModelUsageTurns()` (node:sqlite, read-only). Worker 2's usage.mjs can reuse
    them; admin stats composition is worker 2's.
14. **Streaming timeout** 15 min per turn, then the event iterator is closed and the
    stream is finished normally.
15. **Dead endpoints** from recon return 404 `{error:"..."}` — not implemented here
    and worker 2 should not implement them.

## Smoke test (passed)

Booted `AMIRO_HOME=/tmp/amiro-smoke-home AMIRO_TOKEN= AMIRO_PORT=8787 node src/server.mjs`:
- `GET /health` -> 200 `{"status":"ok"}`
- `GET /api/auth/status` -> 200 `{"isFirstUser":false}` (admin seeded)
- `GET /api/thread` (no Bearer) -> 401 `{"error":"Unauthorized"}`
- `GET /api/chat/models` (public) -> 200, live model list from the bridge
- server stopped afterwards (no process left running)
`node --check` passes on all 7 modules.

## Revision 2 (integration hardening + preview bridge)

Supersedes matching guesses above:

- **Route pinning separator is bridge-specific**: `AMIRO_MODEL_ROUTE_SEP`
  (default `:`). Preview bridge `/run/user/0/amiro-preview-api.sock` uses `:`
  (`opencode-go:deepseek-v4.1-flash` -> provider "OpenCode Go"); scratch bridge
  needs `/`. Bare ids route to the default (wrong) endpoint.
- **`/api/chat/models` + `/api/ai/providers` now use `getRuntimeInfo().routes`**
  (provider-qualified), not `listModels` bare names, filtered to
  `AMIRO_PINNED_MODELS`.
- **No model fallback**: `setModelPinned` aborts the turn on refusal or (in
  pinned mode) a runtime model/provider mismatch.
- **Tools default to none** (`enabled: []`, text assistant only) for the public
  preview; `read`/`ls`/`webfetch`/`websearch` are not advertised. Every session
  is configured explicitly at creation and again before every turn. The only
  escape is a trusted local operator with BOTH `AMIRO_TRUSTED_OPERATOR=1` and
  `AMIRO_TOOL_PROFILE=full`.
- **Chat payload tool fields ignored** (`mentions`, `allowedMcpServers`,
  `allowedAppDefaultToolkit`); they cannot re-enable tools/MCP.
- **Auth**: random admin password -> `$AMIRO_HOME/admin-initial-password`
  (0600); registration disabled by default (`AMIRO_ALLOW_REGISTRATION=1`);
  startup refused if the insecure seeded admin is present
  (`AMIRO_ALLOW_INSECURE_ADMIN=1` to override; never resets passwords).
- **Provider mutations admin-only**: POST/DELETE `/api/ai/providers*`.
- Evidence: `adapter/INTEGRATION-core.md`, test `adapter/tests/integration.mjs`.

## Revision 3 (review fixes)

- **Session TTL**: `AMIRO_SESSION_TTL_DAYS` (default 7; 0 disables). Expired
  bearer tokens are dropped on boot and on use.
- **`ctx.auth.reload()`**: re-reads `users.json` (password hash preserved when a
  row omits it); `GET /api/auth/session` reloads so routes/user.mjs direct writes
  are not stale.
- **Fail-closed tools**: `applyToolProfile` no longer swallows errors; chat aborts
  (SSE error) if `configureTools` fails.
- **Explicit pinned default**: `resolveChatModel` uses the first
  `AMIRO_PINNED_MODELS` entry when the client omits a model (never the daemon
  legacy default). Production: `AMIRO_PINNED_MODELS=opencode-go:deepseek-v4.1-flash,antigravity:gemini-3.8-flash-tiered`.
- **No-tools chats accept every `permissionMode`** (text-only). The auto/edit
  requirement applies only when tools are actually enabled (`toolsEnabled()`).
- **Ownership** on chat/title/export/thread PUT/DELETE/messages via `ownsEntry`.
- Separator `:` only; `/` claims removed.
- Evidence: `adapter/INTEGRATION-core.md` (12/12 PASS).

## Revision 4 (session attachment)

- Bridge needs `attachSession(id)` before session-scoped calls; otherwise
  `unknown_session` or empty history. Added `ctx.jcode.withSession(id, fn)` and
  `ctx.jcode.attach(client, id)`.
- Applied to `getHistory`, `renameSession`, `archiveSession`, `rewind`, and
  `getRuntimeInfo` (models catalog / test / generate), plus the chat turn (attach
  before configureTools/setModel/events) so a second turn on an existing thread
  works.
- `historyFor` no longer swallows errors into `[]`; export history failure -> 500.
- Evidence: `adapter/INTEGRATION-core.md` 13/13 incl. same-thread second turn and
  GET /api/thread/:id persisted-messages.

## Revision 5 (concurrency)

- Redundant `attachSession` on a just-created (unpersisted) session drops it
  ("Failed to restore session"). Chat now attaches ONLY when the thread already
  had a session (created flag); temporary/title/models sessions skip attach.
- `ctx.jcode.createSession(client, options)` serializes session creation across
  all connections to avoid bridge races when the browser fires the first chat and
  the title request together.
- Regression: integration fires chat+title concurrently, then a second turn on
  the same thread, then GET /api/thread/:id (14/14 PASS).

## Revision 6 (audit: fail-open ownership)

- threads.mjs message DELETE/truncate now REQUIRE a mapping AND ownership
  (`!owner || !ownsEntry` -> 404), so a guessed/unmapped session id cannot reach
  the daemon.
- ownsEntry is fail-closed: ownerless (no userId) mappings are refused.
- thread list + delete-all use ownsEntry (ownerless/other-user excluded).
- New tests/ownership.mjs: isolated temp home, 2 users, cross-user denial on
  GET/PUT/DELETE/title/export/chat/messages + fabricated unmapped id; 13/13 PASS.
- integration.mjs unchanged, 14/14 PASS after the change. No credentials touched.
