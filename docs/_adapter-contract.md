# Adapter build contract (v1)

> Status: Retired compatibility harness. The Node adapter in `adapter/` is a retired compatibility harness kept only for running contract tests (`node --test adapter/test/*.test.mjs`). The active production backend is the native Rust backend (`backend/`, binary `amiro-backend`, axum) communicating with the vendored Rust runtime (`runtime/`, binary `amiro-runtime`). The Go backend was completely removed.

Goal: a Node HTTP server that replaces the legacy backend so the existing Next.js frontend works unchanged
against the live runtime daemon. Frontend points at the backend via `NEXT_PUBLIC_BACKEND_URL`
(default `http://127.0.0.1:8787`), sending `X-Amiro-Token` and `X-BetterChatbot-Token` headers and
`Authorization: Bearer <localStorage token>`.

Reference docs (historical context):
- `docs/_recon-frontend-api.md`: every endpoint: method, path, request/response shapes, auth, dead ones.
- `docs/_recon-jcode-sdk.md`: every SDK method, protocol frames, capabilities, usage schemas, gotchas.
- The exact SSE UI-message-stream encoding the frontend consumes (`Content-Type: text/event-stream`,
  `x-vercel-ai-ui-message-stream: v1`, frames `data: <UIMessageChunk json>`, end `data: [DONE]`).

## Fixed decisions (do not renegotiate)

- Port **8787**, bind **0.0.0.0**. Serves API under `/api/*` AND the Next static export from `out/`
  same-origin. If `out/` is absent, API still works.
- Env: `AMIRO_PORT=8787`, `AMIRO_TOKEN` (sidecar shared secret; empty = accept all, dev only),
  `AMIRO_HOME` (default `~/.amiro`; all JSON stores + storage files live here),
  `AMIRO_API_SOCKET` (default `/run/user/0/amiro-api.sock`),
  `AMIRO_RUNTIME_HOME` (default inherit `~/.jcode` so provider logins are visible).
- Auth model: (a) sidecar token header checked when `AMIRO_TOKEN` set; (b) user Bearer token checked
  for all routes except the public list below. Public (no session): `GET /api/auth/status`,
  `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/chat/models`, `GET /api/mcp/oauth/callback`,
  `GET /storage/:token`, `GET /health`. Everything else needs a valid Bearer token.
- User store: `$AMIRO_HOME/users.json`. Seed on first boot: one admin user
  (`admin@local`, name `Admin`, role `admin`, random password generated into `$AMIRO_HOME/admin-initial-password`).
  Login/register/logout/session shapes match auth requirements.
- Thread model: Amiro `threadId` <-> runtime `session_id` mapping in `$AMIRO_HOME/threads.json`
  (`{threadId: {sessionId, title, userId, createdAt, lastMessageAt}}`). Thread CRUD manipulates this
  map and runtime sessions (create/rename/archive). Message history for `GET /api/thread/:id` comes from
  session history translated to `{id, threadId, role, parts, metadata?, createdAt}[]`. Role mapping:
  `user` -> `user`, `assistant` -> `assistant`, tool calls become UI-message `dynamic-tool` parts
  (text parts + tool parts with name/input/output).
- Chat `POST /api/chat`: body (`{id, message, chatModel:{provider,model}, toolChoice,
  permissionMode, mentions, attachments, ...}`). Flow: resolve thread->session (create session
  with `workingDir: AMIRO_HOME/workspace`, `setModel(provider/model)` mapped;
  if model unset use session default), `sendMessage`, then stream events translating
  `text_delta` -> text chunks, `tool_start/input/done` -> tool parts, `token_usage` -> usage metadata.
  Terminate with `data: [DONE]`.
- Title: `POST /api/chat/title` -> short prompt "title in <=6 words", upsert thread title,
  return SSE text stream (client uses `useCompletion`).
- Temporary chat: ephemeral session, stream, then `detachSession` and `archiveSession`.
- `/api/chat/models` (PUBLIC): built from runtime status and model catalog; shape `ChatModelProvider[]`.
- AI providers: `GET /api/ai/providers` from auth status; `POST` with apiKey -> `setApiKey` then
  `notifyAuthChanged`; `DELETE` -> `clearApiKey`; `POST .../models` -> catalog filtered;
  `POST :id/test` -> short `run("Reply with exactly OK")` returning `{ok, model, latencyMs, text}`.
  `generate-object` -> structured output.
  `openai-realtime` -> HTTP 501 `{error:"not supported on this backend"}`.
- Usage: `GET /api/admin/users?limit=` -> local users list shape. `GET /api/admin/users/:id/stats?days|from|to`
  computed from runtime usage and SQLite activity database. Self-view stats fall back to session identity
  when the user ID is not found in `users.json`, preventing 404s.
- `/login` in chat: frontend-only. Adapter support: `GET /api/providers/login-status`
  plus setApiKey/notifyAuthChanged via the providers POST route.
- Everything else (MCP CRUD, archive, export, skills CRUD, workspace-trust,
  checkpoint, storage, user details/password/preferences, search providers):
  implement routes backed by JSON files under `$AMIRO_HOME/store/*.json`.
  Search providers: catalog supporting Vellum options and custom search endpoints.
- Schedules: native schedules delivered under `/api/schedules` (see `docs/SCHEDULES.md`).
  Manual background runs (`/api/background-jobs`) are removed.
- Workflows: user-authored workflows and chat workflow view are completely removed.
- Error shape everywhere: `{error: string}` with matching status codes.
- Single `adapter/src/server.mjs` entry. Structured logging to stdout, one line per request.
