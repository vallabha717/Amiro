---
name: backend
description: Amiro's backend standards for the native Rust HTTP backend in backend/ (axum, binary amiro-backend, library crate `backend`). Covers folder structure, where a route/module goes, AppState, auth (AuthUser, owner/admin checks), errors (ApiError), JSON persistence under AMIRO_HOME/store, the encrypted credential vault, the runtime bridge, agent tools in agent_mcp.rs, and how backend code is tested. Use whenever adding or changing an /api route, request/response shape, persisted setting, credential/secret handling, agent tool the model can call, or anything under backend/**, whenever a UI feature needs a new endpoint, and when reviewing backend work.
---

# Amiro backend standards

One Rust crate, `backend/` → binary `amiro-backend`. It serves the static UI
(`clients/web/out/`) and the JSON API on one port, authenticates users, stores product
state as JSON under `AMIRO_HOME`, keeps secrets in an encrypted vault, and
supervises/bridges the `amiro-runtime` agent engine over a Unix socket. It does
**not** run the agent loop (that is `runtime/`). There is no database, no Go,
and `adapter/` (Node) is retired — never build on it.

## Folder structure

```
backend/
├── Cargo.toml            edition 2021; add deps only with a reason in the PR
├── src/
│   ├── main.rs           router assembly (.merge(...)), static UI, /health
│   ├── lib.rs            module list (library crate `backend`, used by tests)
│   ├── state.rs          AppState, AuthUser, ApiError, read_json/write_json, now_iso
│   ├── auth.rs           /api/auth/* (setup, login, session, logout)
│   ├── routes.rs         `pub fn router()` merging every routes/<area>::routes()
│   ├── routes/<area>.rs  feature APIs: voice, mcp, connectors, credentials,
│   │                     schedules, skills, search_providers, admin, user…
│   ├── <domain>.rs       larger domains at top level: chat, threads, models,
│   │                     agent, agent_mcp (agent tools), onboarding, heartbeat,
│   │                     swarm, runtime (bridge/supervisor), credentials (vault)
│   └── …
└── tests/<area>.rs       integration tests against the real router (see below)
```

**Where does it go?** New feature API → `src/routes/<area>.rs` with
`pub fn routes() -> Router<AppState>`, then add `pub mod <area>;` and
`.merge(<area>::routes())` in `src/routes.rs`. A big cross-cutting domain
(several route groups + background work) → top-level `src/<domain>.rs` with
`pub fn router()` merged in `main.rs`. Helpers used by one area stay private
in that file.

## Rules

| Topic | Standard |
| --- | --- |
| Paths | `/api/<area>/<resource>`; JSON in/out; camelCase JSON keys (the UI reads them as-is) |
| Auth | Take `user: AuthUser` in every handler that is not public. Owner-only: `if user.0["role"] != "admin" { return Err(ApiError(StatusCode::FORBIDDEN, …)) }` (copy the local `require_admin` helper pattern) |
| Errors | Return `Result<Json<Value>, ApiError>`; `ApiError(StatusCode, "human message")`. `?` works for io/serde/anyhow. Messages are shown to users: say what to do, never leak secrets or paths with tokens |
| Persistence | `state.home.join("store").join("<area>.json")` via `read_json(path, fallback)` / `write_json`. Hold `let _guard = state.store.lock().await;` across read-modify-write. Per-user data is keyed by user id |
| Secrets | Never in plain JSON, logs, responses or tool arguments. Store via the credential vault (`credentials.rs`, env names `AMIRO_CRED_*`); return metadata only (name, masked, updatedAt) |
| Agent tools | Add to the tool list in `agent_mcp.rs` as `<area>_<verb>` with a description that says when to use it; implement by calling the **same function the HTTP route uses**. Need a secret → return the SECRET_PROMPT / connector setup card; OAuth → OAUTH_CONNECT card |
| Runtime | Talk to the engine only through `runtime.rs` / the SDK crates (`amiro-sdk`, `amiro-config-types`, `amiro-session-types`). Engine behaviour changes belong in `runtime/` (see `amiro-runtime-update`) |
| Config | Env `AMIRO_*` and `amiro.toml` (`config.rs`); new settings need a sane default and an entry in `amiro.example.toml` / `.env.example` |
| Style | rustfmt defaults; document public items; no `unwrap()` on request data; no blocking IO in async handlers (use tokio fs) |
| Contract | The UI (`clients/web/src/lib/backend/<area>-api.ts`) and agent tools both call your route — changing a shape means updating both in the same change |

## Test it (required)

- **Integration** — `backend/tests/<area>.rs`: build a temp `AppState` fixture
  (temp `home`/`runtime_home`, seeded `users.json` + `sessions.json` with a
  token), `router().with_state(state)`, call with `tower::ServiceExt::oneshot`
  and assert status + JSON. Copy the fixture from `tests/voice.rs`. Cover:
  happy path, 401 without token, 403 for non-owner (if owner-only), bad input → 400.
- **Unit** — `#[cfg(test)] mod tests` at the bottom of the module for pure logic.
- **Agent tool** — a test in `agent_mcp.rs`'s test module calling the tool.
- Run: `cargo test --manifest-path backend/Cargo.toml` (re-run alone if a
  readiness timeout flakes under load).
- User-visible? Also an E2E journey step — see the `test` and `e2e-journeys` skills.

## Done checklist

- [ ] Route in the right file and merged; auth + owner check where needed
- [ ] Secrets only via the vault; nothing sensitive in logs/responses
- [ ] UI client and/or agent tool updated for any shape change
- [ ] Integration test(s) added and `cargo test` passing
- [ ] Docs touched if behaviour is documented (`docs/*.md`, `README.md`)

History: this skill previously described a Go backend (`backend-go/`) and then
a Node adapter. Both are gone; ignore those references in older docs.
