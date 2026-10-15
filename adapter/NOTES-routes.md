# Worker 2 Notes: Adapter Routes

## Files Created
- `adapter/src/usage.mjs`
- `adapter/src/routes/index.mjs`
- `adapter/src/routes/admin.mjs`
- `adapter/src/routes/archive.mjs`
- `adapter/src/routes/background-jobs.mjs`
- `adapter/src/routes/checkpoint.mjs`
- `adapter/src/routes/export.mjs`
- `adapter/src/routes/github.mjs`
- `adapter/src/routes/mcp.mjs`
- `adapter/src/routes/search-providers.mjs`
- `adapter/src/routes/skills.mjs`
- `adapter/src/routes/storage.mjs`
- `adapter/src/routes/user.mjs`
- `adapter/src/routes/workspace-trust.mjs`
- `adapter/src/routes/provider-login.mjs`

## Guesses and Implementation Decisions

1. Export share link auth:
Recon lists `GET /api/export/{id}` and `GET /api/export/{id}/comments` as optional session routes. In `auth.mjs`, `isPublic` checks `PUBLIC_ROUTES` and `/storage/*`, so unauthenticated access might be blocked at `server.mjs` level unless `auth.mjs` treats export paths as public. Handlers in `export.mjs` handle both authenticated and unauthenticated callers cleanly.

2. Usage statistics:
Calculated from `jcode usage --json`, `~/.jcode/openai_oauth_usage.json`, and `~/.jcode/model-usage-v1.sqlite3` turns table. Token counts are aggregated across days in range, and proportional usage is assigned to models present in sqlite turns. Quota limits from `jcode usage --json` are attached to `stats.limits` to power frontend quota displays.

3. Background jobs:
`POST /api/background-jobs` validates edit/auto mode, creates a job record in `background-jobs.json`, and launches a detached process with `jcode run --json` updating status to done or failed on completion.

4. Skills generation:
`POST /api/skills/generate` executes a short JSON-constrained run prompt via jcode and returns a plain text JSON object with name, description, and body. It provides a structured fallback if LLM execution is unavailable.

5. Dead routes:
Every endpoint flagged as dead in `docs/_recon-frontend-api.md` returns HTTP 404 `{ error: "removed" }` rather than being implemented.

6. Provider OAuth login:
`adapter/src/routes/provider-login.mjs` supports interactive OAuth and device code flows via `jcode login <provider> --print-auth-url --json --flow-id <flowId>`.
Supported OAuth providers: `claude`, `openai`, `gemini`, `antigravity`, `copilot`, `google`. Other providers return 400 instructing API key configuration.
Admin auth is required on all oauth routes.
Code/callback inputs are passed via stdin (`--auth-code -` or `--callback-url -`) so secrets never appear in command-line arguments.
For device code flows (`copilot`), a background process runs `jcode login copilot --complete --json --flow-id <flowId>` to poll and mark status as authorized when the user completes authorization on GitHub. Pending flows can be cancelled with `DELETE /api/providers/:id/oauth` or `POST /api/providers/:id/oauth/cancel`.
