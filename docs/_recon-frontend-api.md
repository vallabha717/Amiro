# Frontend → backend API inventory (recon)

Scope: every backend HTTP call the Next.js frontend in `src/` makes, so a replacement
backend can implement the same surface. Cross-checked against `backend-go/internal/httpserver/router.go`
(the current reference implementation).

Base URL: `backendUrl(path)` → `window.__BACKEND_ORIGIN__` (same-origin when the Go binary serves the
page) → `window.__BACKEND_PORT__` (`http://127.0.0.1:<port>`) → `NEXT_PUBLIC_BACKEND_URL` →
`http://127.0.0.1:8787`. Storage URLs (`/storage/<signed-token>`) are rewritten to the live origin by
`rewriteStorageUrl`.

## Transport helpers (`src/lib/backend/client.ts`)

| helper | use |
| --- | --- |
| `apiFetch(path, init)` | raw fetch + auth headers, absolute sidecar URL, `cache: "no-store"`, `redirect: "follow"` |
| `backendFetch` | fetch-compatible, headers only (for AI SDK `api: backendUrl(...)` transports) |
| `fetcher(path, init)` | SWR reader, `res.json()`, throws `ApiError(status, info)` on !ok |
| `apiJson<T>(path, init)` | POST/PUT/DELETE; 204 / empty body → `undefined` |

`ApiError.message` = `payload.error ?? payload.message ?? "An error occurred…"`; `.info` = parsed payload.

## Auth (column meanings)

- `token` = sidecar shared secret `X-Amiro-Token` **and** `X-BetterChatbot-Token` (both sent, same
  value from `__BACKEND_TOKEN__` / `NEXT_PUBLIC_BACKEND_TOKEN`). Omitted entirely when
  `isSameOriginBackend()` (the Go binary injected `__BACKEND_ORIGIN__`); that path authenticates
  structurally via `Sec-Fetch-Site` + session instead.
- `session` = `Authorization: Bearer <token>` from `localStorage["amiro.session-token"]`
  (legacy key `betterchatbot.session-token`), skipped when absent.
- Every request through the helpers above carries `token` + `session` when available. Public routes
  tolerate an absent session; `GET /api/export/{id}` and `GET /api/export/{id}/comments` are the
  optional-session surface.

Server-side guards: `auth.RequireSession` (most routes), `auth.OptionalSession` (export read +
comments list), none on `GET /api/auth/status|register|login`, `GET /api/chat/models`,
`GET /api/mcp/oauth/callback`, `GET|PUT /storage/{token}`.

Client-side gates (`src/lib/backend/auth-gate.tsx`, UX only, no real enforcement):
`RequireAuth` (redirect `/sign-in`), `RedirectIfAuthed`, `RequireAdmin` (`session.user.role === "admin"`).

Sign-in/sign-up shapes:
- `POST /api/auth/login` body `{email, password}` → `{user, token}`; token stored, user in store.
- `POST /api/auth/register` body `{name, email, password}` → `{user, token}`.
- `POST /api/auth/logout` no body; local token cleared in `finally`.
- `GET /api/auth/session` → `user` object directly (not wrapped); 401 clears the stored token.
- Desktop launch may inject `__BACKEND_SESSION_TOKEN__`, adopted unconditionally on boot.

## Streaming protocol (one line)

All model output is the Vercel AI SDK **UI Message Stream over SSE**: `Content-Type: text/event-stream`,
`x-vercel-ai-ui-message-stream: v1`, frames `data: <UIMessageChunk json>\n\n` flushed per frame,
terminated by `data: [DONE]`; consumed by `fetch`-based AI SDK transports (`useChat` /
`useCompletion` / `experimental_useObject`), **no EventSource, no reconnect, no resume**.

Exceptions to that:
- `POST /api/workflow/{id}/execute` — chunked `WF_EVENT`-framed JSON **lines** read off a raw
  `response.body` reader (custom NDJSON-ish framing, event types `WORKFLOW_START`, `NODE_START`,
  `NODE_END`, `WORKFLOW_END`), aborted via `AbortController`.
- `POST /api/skills/generate` — plain `text/plain` JSON *text* body (not SSE), partially parsed by
  `experimental_useObject` against `SkillGenerateSchema`.

## Endpoints

### Auth

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/auth/status` | GET | `hooks/queries/use-auth-status.ts`, `components/auth/sign-in.tsx` | – | `{isFirstUser: boolean}` | public | gates the first-user sign-up CTA |
| `/api/auth/login` | POST | `lib/backend/session-context.tsx`, `components/auth/sign-in.tsx` (via `authClient`) | `{email, password}` | `{user: {id,name,email,role}, token}` | public | token → localStorage |
| `/api/auth/register` | POST | `lib/backend/session-context.tsx`, `components/auth/email-sign-up.tsx` | `{name, email, password}` | `{user, token}` | public | same store update as login |
| `/api/auth/logout` | POST | `components/layouts/app-sidebar-user.tsx` | – | – | session | local token cleared regardless |
| `/api/auth/session` | GET | `lib/backend/session-context.tsx` | – | `{id,name,email,role}` | session | 401 clears token; runs once per page load |

### Chat

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/chat` | POST | `components/chat-bot.tsx` | `ChatApiSchemaRequestBody`: `{id, message: UIMessage, chatModel:{provider,model}, toolChoice:"auto"\|"none"\|"manual", permissionMode?:"plan"\|"manual"\|"interactive"\|"edit"\|"auto", workspaceRoot?, mentions?: ChatMention[], imageTool?:{model?}, allowedMcpServers?, allowedAppDefaultToolkit?:string[], attachments: {type:"file"\|"source-url", url, mediaType?, filename?}[]}` | SSE UI-message stream | token+session | approvals answered by re-POSTing the tool result part (`addToolResult`); `experimental_throttle:100`; abort = `stop()` |
| `/api/chat/temporary` | POST | `components/chat-bot-temporary.tsx` | `{chatModel, instructions, messages: UIMessage[]}` | SSE UI-message stream | token+session | nothing persisted |
| `/api/chat/title` | POST | `hooks/queries/use-generate-thread-title.ts` (`useCompletion`) | `{message, threadId, chatModel}` | SSE UI-message stream (text deltas) | token+session | server upserts title on finish; client then `mutate("/api/thread")` |
| `/api/chat/export` | POST | `components/export/chat-export-popup.tsx` → `chat-api.exportChat` | `{threadId, expiresAt?}` | **bare export id string** | token+session | do not wrap in an object |
| `/api/chat/openai-realtime` | POST | `lib/ai/speech/open-ai/use-voice-chat.openai.ts` | query `?model=&voice=`; body `{model, voice, mentions?}` | session JSON (`client_secret` etc.) | token+session | used with OpenAI Realtime WebRTC |
| `/api/chat/models` | GET | `hooks/queries/use-chat-models.ts`, `components/provider-card.tsx`, `components/provider-editor.tsx`, `user-statistics-card.tsx` | – | `ChatModelProvider[] = {provider, providerName, providerType, hasAPIKey, models:[{name, isToolCallUnsupported?, isImageInputUnsupported?, supportedFileMimeTypes?}]}[]` | **public** (no session guard) | filters to providers with a stored key |

### Threads

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/thread` | GET | `app-sidebar-threads.tsx`, `archive/page.tsx`, `chat-bot.tsx` (mutate), `thread-dropdown.tsx` (mutate), `use-generate-thread-title.ts` (mutate) | – | `{id,title,userId,createdAt,lastMessageAt}[]` | token+session | SWR key mutated after thread changes |
| `/api/thread/{id}` | GET | `app/(chat)/page.tsx` | – | `{id,title,userId,createdAt,messages: {id,threadId,role,parts,metadata?,createdAt}[]}` | token+session | `messages` seeds `initialMessages`; 404 → redirect `/` |
| `/api/thread/{id}` | PUT | `components/thread-dropdown.tsx` → `chat-api.updateThread` | `{title}` | thread | token+session | only title sent |
| `/api/thread/{id}` | DELETE | `chat-bot.tsx`, `thread-dropdown.tsx` → `chat-api.deleteThread` | – | – | token+session | |
| `/api/thread` | DELETE | `app-sidebar-threads.tsx` → `chat-api.deleteAllThreads` | – | – | token+session | |
| `/api/thread?scope=unarchived` | DELETE | `app-sidebar-threads.tsx` → `chat-api.deleteUnarchivedThreads` | query `scope=unarchived` | – | token+session | deletes every non-archived thread |
| `/api/thread/messages/{id}` | DELETE | `components/message-parts.tsx` → `chat-api.deleteMessage` | – | – | token+session | |
| `/api/thread/messages/{id}/truncate` | POST | `components/message-editor.tsx` → `chat-api.deleteMessagesAfter` | – (no body) | – | token+session | deletes messages after the given one |

### MCP

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/mcp/list` | GET | `hooks/queries/use-mcp-list.ts`, `mcp-editor.tsx`, `mcp-card.tsx`, `tool-select-dropdown.tsx`, `chat-preferences-content.tsx` | – | `MCPServerInfo[]` (has `id`, `name`, `toolInfo[]`, `error?`) | token+session | `existMcpClientByServerName` resolved client-side from this list |
| `/api/mcp` | POST | `components/mcp-editor.tsx` (raw `fetcher`) | `{name, config, id?}` | saved server | token+session | `saveMcpClient()` wrapper exists but is unused |
| `/api/mcp/servers/{id}` | GET | `app/(chat)/mcp/modify/page.tsx`, `lib/ai/mcp/oauth-redirect.ts` (poll for `status === "connected"`) | – | server info incl. `status` | token+session | |
| `/api/mcp/servers/{id}` | DELETE | `components/mcp-card.tsx` → `removeMcpClient` | – | – | token+session | then `mutate("/api/mcp/list")` |
| `/api/mcp/servers/{id}/refresh` | POST | `components/mcp-card.tsx` → `refreshMcpClient` | – | – | token+session | |
| `/api/mcp/servers/{id}/share` | POST | `components/mcp-card.tsx` → `shareMcpServer` | `{visibility: "public" \| "private"}` | – | token+session | |
| `/api/mcp/servers/{id}/tools/{tool}/call` | POST | `app/(chat)/mcp/test/page.tsx`, `use-voice-chat.openai.ts` → `callMcpTool(B)` | raw tool input JSON (body **is** the arguments) | tool result | token+session | by-server-name variant lists servers then calls by id |
| `/api/mcp/servers/{id}/oauth/authorize` | POST | `lib/ai/mcp/oauth-redirect.ts` | – | `{authorizationUrl}` | token+session | opens popup; completion signalled by `postMessage` + polling |
| `/api/mcp/server-customizations/{server}` | GET/POST/DELETE | `components/mcp-customization-popup.tsx` | POST `{prompt: string(1..3000)}` | `{id, prompt} \| null` | token+session | |
| `/api/mcp/tool-customizations/{server}` | GET | `components/mcp-customization-popup.tsx` | – | `McpToolCustomization[]` | token+session | |
| `/api/mcp/tool-customizations/{server}/{tool}` | GET/POST/DELETE | `components/tool-detail-popup.tsx` | POST `{prompt: string(1..1000)}` | `{id, prompt} \| null` | token+session | |
| `/api/mcp/oauth/callback` | GET | none (browser redirect target) | query from the auth server | HTML/redirect | **public, token-exempt** | never fetched by the SPA |

### AI providers / generation

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/ai/providers` | GET | `admin/providers/page.tsx`, `admin/providers/modify`, `user-statistics-card.tsx`, `app/onboarding/page.tsx` | – | `{id,name,provider,configured,apiKey?,baseUrl?,models?}[]` | token+session (admin routes additionally gated in UI) | |
| `/api/ai/providers` | POST | `components/provider-editor.tsx`, `app/onboarding/page.tsx` | `{id?, name, provider, apiKey, baseUrl, models?}` | `{id}` | token+session | empty `apiKey` on update = keep stored |
| `/api/ai/providers/{id}` | DELETE | `components/provider-card.tsx` → `removeProvider` | – | – | token+session | then `mutate("/api/chat/models")` |
| `/api/ai/providers/models` | POST | `components/provider-editor.tsx` → `fetchProviderModels` | `{id?, provider?, apiKey?, baseUrl?}` | `{models: string[]}` | token+session | unsaved-connection model list |
| `/api/ai/providers/{id}/test` | POST | `admin/providers/test/page.tsx` → `testProviderModel` | `{model}` | `{ok, model, provider, latencyMs, text, usage?:{PromptTokens,CompletionTokens,TotalTokens}, toolCall?:{supported,name?,arguments?,error?}, note?, error?}` | token+session | Go field names are capitalized (`bifrostai.Usage` has no json tags) |
| `/api/ai/generate-object` | POST | `workflow/node-config/execute-tab.tsx`, `workflow/output-schema-editor.tsx` → `chat-api.generateObject` | `{model?: ChatModel, prompt:{system?, user?}, schema}` | generated object | token+session | |
| `/api/ai/generate-example-tool-schema` | POST | `app/(chat)/mcp/test/page.tsx` → `chat-api.generateExampleToolSchema` | `{model?: ChatModel, toolInfo:{name,description,inputSchema?}, prompt?}` | schema object | token+session | |

### Search providers

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/search/active` | GET | `components/tool-select-dropdown.tsx`, `components/tool-invocation/web-search.tsx` | – | `{configured, provider?, label?, extracts?}` | token+session | readable by any signed-in user |
| `/api/search/catalog` | GET | `components/search-provider-editor.tsx` | – | `{kind,label,extracts,freeTier,docs}[]` | token+session | |
| `/api/search/providers` | GET | `search-provider-card.tsx`, `admin/search/*` pages | – | `{id,name,provider,configured,apiKeyHint?,isActive,extracts}[]` | token+session | key is masked, never returned |
| `/api/search/providers` | POST | `components/search-provider-editor.tsx` | `{id?, name, provider, apiKey}` | `{id}` | token+session | empty `apiKey` = keep stored |
| `/api/search/providers/{id}` | DELETE | `components/search-provider-card.tsx` | – | – | token+session | |
| `/api/search/providers/{id}/activate` | POST | `components/search-provider-card.tsx` | – | – | token+session | |
| `/api/search/providers/{id}/test` | POST | `admin/search/test/page.tsx` | – | `{ok, provider, latencyMs, count, error?}` | token+session | |

### Workflow

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/workflow` | GET | `components/workflow/workflow-list-page.tsx` | – | workflow list | token+session | |
| `/api/workflow` | POST | `edit-workflow-popup.tsx`, `workflow-list-page.tsx` | workflow body (`{...workflow, noGenerateInputNode?, isPublished?}`) | `DBWorkflow` | token+session | example workflow creation then posts its structure |
| `/api/workflow/tools` | GET | `hooks/queries/use-workflow-tool-list.ts` | – | tool list → `appStore.workflowToolList` | token+session | |
| `/api/workflow/{id}` | GET | `components/workflow/workflow.tsx` | – | `DBWorkflow` | token+session | |
| `/api/workflow/{id}` | PUT | `workflow-panel.tsx` (`{visibility}` / `{isPublished}`), `workflow-list-page.tsx` (`{visibility}`) | partial update | workflow | token+session | |
| `/api/workflow/{id}` | DELETE | `workflow-list-page.tsx`, `workflow-context-menu.tsx` | – | – | token+session | then `mutate("/api/workflow")` |
| `/api/workflow/{id}/structure` | GET | `app/(chat)/workflow/edit/page.tsx` | – | `{nodes, edges, userId, visibility}` | token+session | `hasEditAccess` computed client-side from `userId`/`visibility` |
| `/api/workflow/{id}/structure` | POST | `workflow.tsx`, `workflow-list-page.tsx` | `{nodes, edges, deleteNodes?: string[], deleteEdges?: string[]}` | – | token+session | diff-based save |
| `/api/workflow/{id}/execute` | POST | `workflow/node-config/execute-tab.tsx` | `{query}` | chunked `WF_EVENT`-framed JSON lines | token+session | aborted via `AbortController.signal` |

### Archive

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/archive` | GET | `hooks/queries/use-archives.tsx` | – | `Archive & {itemCount}[]` | token+session | |
| `/api/archive` | POST | `components/archive-dialog.tsx`, `lib/backend/archive-api.ts` | `{name, description?}` | archive | token+session | |
| `/api/archive/{id}` | GET | `app/(chat)/archive/page.tsx` | – | `{id,name,description,userId,createdAt,updatedAt}` | token+session | ownership-checked server-side |
| `/api/archive/{id}` | PUT | `archive-dialog.tsx`, `archive-api.updateArchive` | `{name?, description?}` | archive | token+session | |
| `/api/archive/{id}` | DELETE | `archive-actions-client.tsx` → `deleteArchive` | – | – | token+session | |
| `/api/archive/{id}/items` | POST | `thread-dropdown.tsx` → `addItemToArchive` | `{itemId}` | archive item | token+session | |
| `/api/archive/{id}/items` | GET | – | – | – | – | **dead** (no caller) |
| `/api/archive/{id}/items/{itemId}` | DELETE | – | – | – | – | **dead** (`removeItemFromArchive` unused) |

### Export / share links

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/export` | GET | `components/chat-preferences-content.tsx` | – | `ChatExportSummary[]` (`{id,title,exporterId,originalThreadId?,commentCount,exportedAt,…}`) | token+session | |
| `/api/export/{id}` | GET | `app/(public)/export/page.tsx` | – | exported thread + `isExpired` | **optional session** | public share link |
| `/api/export/{id}` | DELETE | `components/chat-preferences-content.tsx` | – | – | token+session | |
| `/api/export/{id}/comments` | GET | `components/export/comments.tsx` | – | `ChatExportCommentWithUser[]` (nested `replies`, `isOwner`) | **optional session** | only fetched when signed in |
| `/api/export/{id}/comments` | POST | `components/export/comment-form.tsx` (raw `apiFetch`) | `{content: TipTapMentionJsonContent, parentId?}` | created comment | token+session | client `mutate`s the comments SWR key after |
| `/api/export/{id}/comments/{commentId}` | DELETE | `components/export/comment.tsx` (raw `apiFetch`) | – | – | token+session | |

### User / profile

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/user/details` | GET | `chat-greeting.tsx`, `app-sidebar-user.tsx`, `user-detail-content.tsx` | – | `BasicUser = {id,name,email,role?,preferences?,image?,…}` | token+session | |
| `/api/user/details` | PUT | `components/user/user-detail/user-detail-content.tsx` | `{name?, image?}` | `BasicUser` | token+session | SWR cache written directly, no revalidate |
| `/api/user/password` | PUT | `user-detail-content.tsx` (PasswordCard) | `{currentPassword, newPassword}` | – | token+session | then `mutate("/api/user/auth-methods")` |
| `/api/user/auth-methods` | GET | `user-detail-content.tsx` | – | `{hasPassword: boolean}` | token+session | |
| `/api/user/preferences` | GET/PUT | `components/chat-preferences-content.tsx` | PUT `UserPreferences = {displayName?, profession?, responseStyleExample?, botName?}` | `UserPreferences` | token+session | |
| `/api/user/stats` | GET | – | – | – | – | **dead** |
| `/api/user/details/{id}` | GET | – | – | – | – | **dead** |

### Admin

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/admin/users?limit=100` | GET | `app/(chat)/(admin)/admin/usage/page.tsx` | query `limit` | `{users: {id,name,email,role}[]}` | token+session | user switcher; handler enforces admin |
| `/api/admin/users/{id}/stats` | GET | `admin/usage/page.tsx` | query `days=1\|7\|30\|90` **or** `from`+`to` (ISO) | `{user: {id,name,email,image?,role,banned?,banReason?,createdAt,lastLogin?}, stats: {threadCount, messageCount, modelStats[], totalTokens, promptTokens, completionTokens, dailyUsage[], period}}` | token+session | |
| `/api/admin/users/{id}`, `/{id}/role`, `/{id}/ban`, `DELETE /{id}` | GET/PUT/PUT/DELETE | – | – | – | – | **dead** (admin UI was collapsed to redirects into `/admin/usage`) |

### Skills

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/skills[?project=]` | GET | `hooks/queries/use-skills.ts` | query `project?` | `{items: SkillSummary[], diagnostics: [], truncated: boolean}` | token+session | `items` omits body/resources |
| `/api/skills/items/{name}[?project=]` | GET | `hooks/queries/use-skills.ts`, `app/(chat)/skill/page.tsx`, `components/skill/edit-skill.tsx` | query `project?` | `Skill` (full, incl. `body`, `resources`) | token+session | name URL-encoded |
| `/api/skills` | POST | `edit-skill.tsx` → `createSkill` | `SkillWriteRequest {name, description, body, frontmatter?}` | `{skill, warnings?}` | token+session | 400 → `.info.errors` = `SkillFieldError[]` |
| `/api/skills/items/{name}` | PUT | `edit-skill.tsx` → `updateSkill` | `SkillWriteRequest` | `{skill, warnings?}` | token+session | 409 if read-only |
| `/api/skills/items/{name}[?force=true]` | DELETE | `edit-skill.tsx` → `deleteSkill` | query `force?` | – | token+session | 422 naming unexpected files without force |
| `/api/skills/items/{name}/duplicate[?project=]` | POST | `edit-skill.tsx` → `duplicateSkill` | query `project?` | `{skill, warnings?}` | token+session | |
| `/api/skills/generate` | POST | `components/skill/generate-skill-dialog.tsx` (`experimental_useObject`) | `{message, chatModel}` | `text/plain` JSON text, partially streamed: `{name, description, body}` | token+session | **not** SSE |

### Workspace trust

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/workspace-trust` | GET | `hooks/queries/use-workspace-trust.ts`, `trust-settings-card.tsx` | – | `{grants: {resolvedRoot, grantedAt, grantedVia:"prompt"\|"env"}[]}` | token+session | |
| `/api/workspace-trust/status?root=` | GET | `use-workspace-trust.ts`, `trust-prompt-dialog.tsx` (mutate) | query `root` (URL-encoded) | `{trusted, resolvedRoot}` | token+session | key `null` until a root exists |
| `/api/workspace-trust/grant` | POST | `trust-prompt-dialog.tsx` → `grantWorkspaceTrust` | `{root}` | `{trusted, resolvedRoot}` | token+session | |
| `/api/workspace-trust/revoke` | POST | `trust-settings-card.tsx` → `revokeWorkspaceTrust` | `{root}` | – | token+session | forward-only |

### GitHub

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/github/status` | GET | `hooks/queries/use-github.ts`, `components/github/github-connect-card.tsx` | – | `{connected: boolean}` | token+session | token value never returned |
| `/api/github/connect` | POST | `github-connect-card.tsx` → `connectGitHub` | `{token}` | `{connected}` | token+session | |
| `/api/github/disconnect` | POST | `github-connect-card.tsx` → `disconnectGitHub` | – | – | token+session | |

### Checkpoint / rewind

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/checkpoint/files?threadId=&turnId=` | GET | `hooks/queries/use-checkpoint.ts` (raw SWR key), `checkpoint/rewind-confirm-dialog.tsx` | query `threadId`, `turnId` (encoded) | `{turnId, files: {path, existedBefore}[]}` | token+session | only fetched from the rewind dialog |
| `/api/checkpoint/restore` | POST | `checkpoint/rewind-confirm-dialog.tsx` → `restoreCheckpoint` | `{threadId, turnId}` | `{turnId, files: {path, existedBefore, restored, error?}[]}` | token+session | |
| `/api/checkpoint/latest` | GET | – | – | – | – | **dead** |

### Background agent runs

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/background-jobs` | GET | `hooks/queries/use-background-jobs.ts` (SWR, 5s poll) | – | `{jobs: BackgroundJob[]}`; `BackgroundJob = {id,threadId,workspaceRoot,prompt,mode,status:"running"\|"suspended"\|"done"\|"failed"\|"interrupted",autoPr,error?,startedAt,finishedAt?}` | token+session | polling, no push channel |
| `/api/background-jobs` | POST | `components/background-jobs/background-jobs-list.tsx` → `createBackgroundJob` | `{prompt, mode:"edit"\|"auto", workspaceRoot?, autoPr?}` | `BackgroundJob` | token+session | |
| `/api/background-jobs/{id}` | GET | – | – | – | – | **dead** (`selectBackgroundJob` unused) |

### Storage

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/storage/upload-url` | POST | `hooks/use-presigned-upload.ts` (thread files, avatars, profile image) | `{filename, contentType}` | `{key, url, method?, headers?, sourceUrl?}` | token+session | |
| `<presigned url>` (`/storage/{token}` or S3) | PUT | `hooks/use-presigned-upload.ts` (plain `fetch`, **no auth headers**) | raw file body | – | **token signed in the URL** | not suffixed with the sidecar base URL |
| `/storage/{token}` | GET | implicit: every persisted `file.url` rendered in chat/messages (`rewriteStorageUrl` rewrites stale host:port) | – | file bytes | token in path | |
| `/api/storage/ingest` | POST | `components/prompt-input.tsx` | `{url}` | `{text}` (shows `error` on failure) | token+session | "Summarize" button appends `text` to the composer |
| `/api/storage/upload` | POST | – | – | – | – | **dead** (multipart path unused) |

### Other

| endpoint | method | caller file(s) | request shape | response shape | auth | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `/health` | GET | – | – | `{status:"ok"}` | public | liveness; no frontend caller |
| `/api/sandbox/status` | GET | – | – | – | – | **dead** from the frontend (sandbox state arrives inside tool result parts) |
| `/api/bookmark` | POST/DELETE | – | – | – | – | **dead**; `shared/` bookmark button is inert (`onBookmarkToggle` never passed) |

## Ambiguous / dead

- **Dead from the frontend** (routes exist server-side, zero callers in `src/`): `GET /api/user/stats`,
  `GET /api/user/details/{id}`, all admin user CRUD (`GET /api/admin/users/{id}`, `PUT .../role`,
  `PUT .../ban`, `DELETE .../{id}`), `POST /api/bookmark`, `DELETE /api/bookmark`,
  `GET /api/sandbox/status`, `GET /api/checkpoint/latest`, `GET /api/background-jobs/{id}`,
  `GET /api/archive/{id}/items`, `DELETE /api/archive/{id}/items/{itemId}`,
  `POST /api/ai/providers/{id}/sync-models`, `POST /api/storage/upload` (multipart).
- **Wrappers with no call site**: `chat-api.exportChat` *is* used (via popup), but
  `ai/providers.syncProviderModels`, `mcp-api.saveMcpClient`, `background-jobs-api.selectBackgroundJob`,
  `workspace-trust-api.selectWorkspaceTrustGrants`, `checkpoint-api.selectCheckpointFiles`,
  `archive-api.removeItemFromArchive` are unused — the last four are re-implemented inline as raw SWR
  keys / raw `fetcher` calls in components.
- **`GET /api/chat/models` has no session guard** even though it returns per-user provider
  availability; it is the one model-listing route reachable with the shared secret alone.
- **`/api/mcp/{id}` vs `/api/mcp/servers/{id}`**: frontend uses only the `servers/` nesting (the Go
  rewrite's deliberate deviation from the old TS `[id]` route).
- **`GET /api/user/preferences` fallback is `{}`** (`fallback: {}`, not `fallbackData`), so the
  preferences form can render before data arrives.
- `exportChat` must return a bare JSON string id, not `{"message": ...}` — the popup uses the body
  directly as the id.
- Responses for mutations are frequently discarded (`apiJson` → `undefined` on 204/empty); a
  replacement backend only needs status codes for those.
