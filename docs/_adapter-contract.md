# Adapter build contract (v1)

Goal: a Node HTTP server that replaces `backend-go` so the existing Next.js frontend works unchanged
against the live jcode daemon. Frontend already points at any backend via `NEXT_PUBLIC_BACKEND_URL`
(default `http://127.0.0.1:8787`), sending `X-Amiro-Token` + `X-BetterChatbot-Token` headers and
`Authorization: Bearer <localStorage token>`.

Reference docs (read these first):
- `docs/_recon-frontend-api.md` — every endpoint: method, path, request/response shapes, auth, dead ones.
- `docs/_recon-jcode-sdk.md` — every SDK method, protocol frames, capabilities, usage schemas, gotchas.
- `backend-go/internal/api/chat/handler.go` + `parts.go` — the exact SSE UI-message-stream encoding the
  frontend consumes (`Content-Type: text/event-stream`, `x-vercel-ai-ui-message-stream: v1`, frames
  `data: <UIMessageChunk json>`, end `data: [DONE]`). Mirror this byte-shape.

## Fixed decisions (do not renegotiate)

- Port **8787**, bind **0.0.0.0**. Serves API under `/api/*` AND the Next static export from `out/`
  same-origin (mirrors the Go binary; frontend then uses the `__BACKEND_ORIGIN__` path, no rebuild
  needed for URL changes). If `out/` is absent, API still works.
- Env: `AMIRO_PORT=8787`, `AMIRO_TOKEN` (sidecar shared secret; empty = accept all, dev only),
  `AMIRO_HOME` (default `~/.amiro`; all JSON stores + storage files live here),
  `JCODE_API_SOCKET` (default `/root/.jcode/scratch/amiro-api.sock`; bridge already running there),
  `AMIRO_JCODE_HOME` (pass through; default inherit `~/.jcode` so provider logins are visible).
- Auth model: (a) sidecar token header checked when `AMIRO_TOKEN` set; (b) user Bearer token checked
  for all routes except the public list below. Public (no session): `GET /api/auth/status`,
  `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/chat/models`, `GET /api/mcp/oauth/callback`,
  `GET /storage/:token`, `GET /health`. Everything else needs a valid Bearer token.
- User store: `$AMIRO_HOME/users.json`. Seed on first boot: one admin user
  (`admin@local`, name `Admin`, role `admin`, password `admin` — log a warning to change it).
  Login/register/logout/session shapes EXACTLY per `_recon-frontend-api.md` Auth section.
- Thread model: Amiro `threadId` <-> jcode `session_id` mapping in `$AMIRO_HOME/threads.json`
  (`{threadId: {sessionId, title, userId, createdAt, lastMessageAt}}`). Thread CRUD manipulates this
  map + jcode sessions (create/rename/archive). Message history for `GET /api/thread/:id` comes from
  `getHistory()` translated to `{id, threadId, role, parts, metadata?, createdAt}[]`. Role mapping:
  jcode `user`->`user`, `assistant`->`assistant`, tool calls become UI-message `dynamic-tool` parts
  (read `parts.go` for the part shapes; keep it simple: text parts + tool parts with name/input/output).
- Chat `POST /api/chat`: body per recon (`{id, message, chatModel:{provider,model}, toolChoice,
  permissionMode, mentions, attachments, ...}`). Flow: resolve thread->session (create jcode session
  with `workingDir: AMIRO_HOME/workspace`, `setModel(provider/model)` mapped — provider `openai` etc;
  if model unset use session default), `sendMessage`, then stream SDK `events(sessionId)` translating
  `text_delta`->text chunks, `tool_start/input/done`->tool parts, `token_usage`->usage metadata,
  `permission_request`->auto-allow when `permissionMode` is auto/edit, else end stream with a
  pending-approval marker part (frontend re-POSTs tool results; support that by treating a body with
  tool-result parts as `submitToolResult` + resume streaming). Terminate with `data: [DONE]`.
- Title: `POST /api/chat/title` -> jcode `run` short prompt "title in <=6 words", upsert thread title,
  return SSE text stream (client uses `useCompletion`; plain text deltas + [DONE] is fine).
- Temporary chat: ephemeral session, stream, then `detachSession` + `archiveSession`.
- `/api/chat/models` (PUBLIC): from `jcode auth status --json` (shell out, cache 60s) + `listModels`;
  shape `ChatModelProvider[]` per recon; `hasAPIKey` from auth status.
- AI providers: `GET /api/ai/providers` from auth status; `POST` with apiKey -> `setApiKey` then
  `notifyAuthChanged`; `DELETE` -> `clearApiKey`; `POST .../models` -> `listModels` filtered;
  `POST :id/test` -> short `run("Reply with exactly OK")` returning `{ok, model, latencyMs, text}`.
  `generate-object` -> `runStructured`; `generate-example-tool-schema` -> `run` + JSON parse attempt.
  `openai-realtime` -> HTTP 501 `{error:"not supported on jcode backend"}`.
- Usage: `GET /api/admin/users?limit=` -> local users list shape. `GET /api/admin/users/:id/stats?days|from|to`
  computed from: `jcode usage --json` (limits/extra_info), `~/.jcode/openai_oauth_usage.json`
  (lifetime + days buckets -> totalTokens/promptTokens/completionTokens/TotalCost/dailyUsage),
  `model-usage-v1.sqlite3` turns table (modelStats by model/provider + counts in range),
  `listSessions` count (threadCount), turns-in-range count (messageCount proxy). Period string same
  rules as Go (`Today`, `Last N Days`, `From..`/range). Cost = `known_usd`, note unpriced count.
- `/login` in chat: frontend-only (worker 3). Adapter support: `GET /api/providers/login-status`
  (NEW endpoint, extra — returns auth-status providers array) + reuse setApiKey/notifyAuthChanged
  via the providers POST route.
- Everything else (MCP CRUD, archive, export+comments, skills CRUD, workspace-trust,
  github, checkpoint, storage, user details/password/preferences, search providers):
  implement routes with EXACT recon shapes backed by JSON files under `$AMIRO_HOME/store/*.json`,
  except: `mcp/.../call`, `.../test`, `checkpoint/restore`, `storage/ingest` (implement: fetch URL,
  strip tags, return text), skills/generate (jcode `run` short prompt). Storage files under `$AMIRO_HOME/storage/<random-token>` served at `/storage/:token`.
  Search-provider routes: static catalog + empty providers store (search is out of scope).
- Dead endpoints from recon: implement as 404 `{error:"removed"}` (do NOT implement dead routes).
- Error shape everywhere: `{error: string}` with matching status codes. Mutations the client ignores
  may return 204/empty.
- No TypeScript, no framework: plain Node 22+, `node:http`, `npm i @1jehuang/jcode-sdk` only.
  Single `adapter/src/server.mjs` entry. Structured logging to stdout, one line per request.

## File ownership (do not touch other workers' files, do not commit, do not delete backend-go)

- Worker 1 (adapter-core): `adapter/package.json`, `adapter/src/server.mjs`, `adapter/src/jcode.mjs`
  (shared SDK client + reconnect + auth-status cache + usage readers), `adapter/src/auth.mjs`
  (token middleware + users.json + public-route list), `adapter/src/store.mjs` (JSON file helper),
  `adapter/src/chat.mjs` (POST /api/chat, /temporary, /title, /export, openai-realtime 501),
  `adapter/src/threads.mjs` (all /api/thread* incl. messages delete/truncate via rewind/clear+replay
  where needed — simplest correct: truncate unsupported -> replay remaining history into new session),
  `adapter/src/models.mjs` (/api/chat/models + all /api/ai/*).
- Worker 2 (adapter-routes): `adapter/src/routes/*.mjs` (mcp, archive, export, skills,
  workspace-trust, github, checkpoint, storage, user, admin, search-providers) +
  `adapter/src/usage.mjs` + wire-up function `registerRoutes(app, ctx)` imported by server.mjs
  (coordinate the exact export name with worker 1 via a comment at top of server.mjs — worker 1
  creates server.mjs FIRST with a placeholder import, worker 2 matches it).
- Worker 3 (frontend): login panel + `/login` intercept + usage-page check + `pnpm install` +
  `next build` + `out/` verification. No backend-client rewiring expected (shapes preserved); only
  adjust if a shape provably differs.
