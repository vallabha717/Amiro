# adapter-core integration evidence (worker 1)

Date: 2026-10-14. Scope: `adapter/src/{auth,chat,jcode,models}.mjs` + `adapter/tests/integration.mjs`.
No commits. No shared daemon restart. No shared credential mutation.

## What changed

- **auth.mjs**
  - Fresh `AMIRO_HOME` seeds a single admin (`admin@local`) with a **random**
    password written once to `$AMIRO_HOME/admin-initial-password` (mode `0600`).
  - **Never resets passwords.** If an existing home contains the known-insecure
    seeded admin (`admin@local` / `admin`), startup is **refused** (exit 1) with
    a clear message; `AMIRO_ALLOW_INSECURE_ADMIN=1` only marks the deployment
    unsafe and continues (dev escape hatch).
  - Public self-registration is **disabled by default**; `POST /api/auth/register`
    returns 403 once users exist. `AMIRO_ALLOW_REGISTRATION=1` re-enables it.
    A brand-new empty home (with `AMIRO_SEED_ADMIN=0`) may still bootstrap.
  - Bearer sessions expire after `AMIRO_SESSION_TTL_DAYS` (default 7; `0`
    disables); expired tokens are dropped on boot and on use.
  - `GET /api/auth/session` re-reads `users.json` (`ctx.auth.reload()`, also
    exported) so direct writes by `routes/user.mjs` are reflected without a
    restart; password hashes are preserved when a file row omits them.
  - `GET /api/auth/status` adds `registrationEnabled` and `deploymentSafe`.
- **models.mjs**
  - Provider **mutations** (`POST /api/ai/providers`, `DELETE /api/ai/providers/:id`,
    `POST /api/ai/providers/models`) are **admin-only** (403 otherwise). Read-only
    listing stays available to any authenticated user.
  - `/api/chat/models` and `/api/ai/providers` now build from
    `getRuntimeInfo().routes` (provider-qualified) instead of bare `listModels`
    names, filtered to `AMIRO_PINNED_MODELS` when set.
- **jcode.mjs**
  - Route pinning: `resolveModel(provider, model)` -> `<provider><sep><model>`
    (`AMIRO_MODEL_ROUTE_SEP`, default `:`). `resolveChatModel` falls back to the
    **first pinned model** when the client omits one (never the daemon default).
    `assertModelAllowed` enforces the allow-list. `setModelPinned` sets the model
    and **verifies** the runtime resolved model+provider; a mismatch aborts.
- **chat.mjs / threads.mjs**
  - The chat payload's `mentions`, `allowedMcpServers`, and
    `allowedAppDefaultToolkit` are **ignored**: a client cannot widen tool access.
  - **Every** created session is configured explicitly with
    `createSession({ tools })` **and** `configureTools` before each turn, and the
    policy application is **fail-closed** (a `configureTools` failure aborts the
    turn instead of sending). Default is **no tools** (`enabled: []`, text only);
    the only escape is a trusted local operator setting BOTH
    `AMIRO_TRUSTED_OPERATOR=1` and `AMIRO_TOOL_PROFILE=full`.
  - With no tools, **all** permission modes are accepted (text-only); the
    auto/edit requirement only applies when tools are enabled.
  - Model selection has **no fallback**: a refused/unknown model, or a failed
    route pin, aborts the turn with an SSE error.
  - **Ownership** is enforced on chat, title, export, `GET/PUT/DELETE /api/thread/:id`,
    delete-all, and message delete/truncate (`ownsEntry`); mismatches 404.

## How to run

```
cd adapter
node tests/integration.mjs          # uses the dedicated preview bridge by default
# scratch bridge: JCODE_API_SOCKET=/root/.jcode/scratch/amiro-api.sock \
#   AMIRO_MODEL_ROUTE_SEP=/ node tests/integration.mjs
```

The test uses a fresh temp `AMIRO_HOME`, loopback `127.0.0.1:8797`, and the
dedicated preview bridge `/run/user/0/amiro-preview-api.sock`.

## Result: PASS (14/14)

```
PASS  server boots on loopback with fresh home
PASS  seeded admin random password in mode-0600 file
PASS  auth status: seeded user, registration disabled, deployment safe
PASS  public self-registration refused
PASS  admin login succeeds
PASS  /api/chat/models exposes only pinned, provider-qualified models
PASS  provider mutation allowed for admin
PASS  concurrent first chat + title both succeed (no unknown_session)
PASS  real streamed turn (pinned opencode-go:deepseek-v4.1-flash)
PASS  second turn on same thread succeeds with pinned default model
PASS  GET /api/thread/:id returns persisted messages  (count=4 roles=[user,assistant,user,assistant])
PASS  model outside allow-list rejected (no fallback)
PASS  antigravity:gemini-3.8-flash-tiered route-pins
PASS  explicit public tool profile exposes no tools  (before=34 after=0)
```

### Session attachment + concurrency fix (live bug)

The bridge requires `attachSession(id)` before session-scoped calls, but a
redundant attach on a just-created, not-yet-persisted session **drops it**
("Failed to restore session: No such file or directory") -- the browser fires the
first chat and the title request at the same time, so this surfaced there.
`jcode.mjs` now:
- `withSession(id, fn)` (isolated connection + attach) for EXISTING sessions
  (`get_history`, `rename`, `archive`, `rewind`, `runtime_info`);
- `attach()` is applied in chat ONLY when the thread already had a session, never
  right after `createSession`;
- `createSession()` is serialized across all connections (concurrent
  `create_session` calls race inside the bridge).

`historyFor` no longer swallows failures into `[]` (errors surface as 500), and
export history failure returns 500.

Insecure-admin guard (separate check, using the pre-existing `/tmp/amiro-smoke-home`):
`exit=1`, log: `insecure seeded admin (admin@local / admin) present; no password
reset is performed. Refusing to start.` The user record was left untouched.

## Exact remaining limits

1. **No tools at all** for the public preview (text only). `read`/`ls` were
   rejected as unsafe (credential exposure) and `webfetch` (SSRF) / `websearch`
   (out of scope) are not advertised. Needs sandbox-aware handlers before any
   tool is enabled.
2. **Separator**: `:` is the verified, installed syntax (`AMIRO_MODEL_ROUTE_SEP`
   overrides). Only the two allow-listed models were exercised.
3. **Gemini full streamed turn was not exercised** (route pin + `setModel` +
   runtime check only) to limit quota; the deepseek route carried the real turn.
4. **Non-admin user path not exercised end-to-end** because registration is
   closed. The no-tools profile applies to *all* sessions by default, so the
   policy is covered regardless of role; a real second-user round trip is
   unverified.
5. **Attachments**: only inline `data:` images become `ImageAttachment`; other
   URLs are appended to the prompt as text (no upload pipeline in core), so
   non-inline images are not delivered as images.
6. **`archiveSession` can return `unknown_session`** for throwaway sessions and
   is ignored; temp/title sessions may remain in the daemon's session list.
7. **Provider test/generate-object/generate-example** run real model calls with
   the daemon's shared credentials; they are authenticated (any user) but not
   admin-gated. They now also use the no-tools profile and pinned models.
8. **Scratch-bridge regression** against `AMIRO_MODEL_ROUTE_SEP=/` was not re-run
   after the switch to `:` default.
9. **Ownership checks are code-reviewed but not exercised with two distinct
   users** (registration is closed, so no second user was created). All chat/
   title/export/thread/message paths call `ownsEntry` and 404 on mismatch.
10. **Coordinator live-smoke** (`adapter/test/live-smoke.mjs`) must be re-run
    against the restarted private service; this core is stable and ready for it.
