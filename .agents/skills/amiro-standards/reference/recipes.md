# Recipes

## Add a page or UI feature

1. Route under `src/app/(chat)/…/page.tsx` (`"use client"`; the app is a
   static export — no server actions, no Next API routes, no `fetch` at build).
2. Components in the matching `src/components/<feature>/` folder; primitives
   from `ui/*`. Match existing tokens/classes; no new design system.
3. Data: add/extend `src/lib/backend/<area>-api.ts` (`apiJson`), use SWR like
   neighbouring pages.
4. Strings: `const t = useTranslations("Section")`; add keys to **both**
   `messages/en.json` and `messages/hi.json`.
5. Accessibility: every icon-only button gets `aria-label`; interactive
   things the E2E suite drives get a `data-testid`.
6. E2E: add a `step(...)` in the owning journey; run it; watch the video.

## Add a backend route

1. `backend/src/routes/<area>.rs` with `pub fn routes() -> Router<AppState>`;
   add `pub mod <area>;` and `.merge(<area>::routes())` in `src/routes.rs`
   (big top-level domains use `pub fn router()` merged in `main.rs`).
2. Auth via the `AuthUser` extractor; owner-only actions check
   `user.0["role"] == "admin"`; errors as `ApiError(StatusCode, msg)`.
3. Persist under `state.home.join("store")` with `read_json`/`write_json`.
   Secrets go to the credential vault (`credentials.rs`), never plain JSON.
4. Test in `backend/tests/<area>.rs` (real router, temp home). Keep the route
   contract stable — the UI and agent tools both call it.

## Add an agent tool (agent configures Amiro from chat)

1. Add the JSON schema entry to the tool list in `backend/src/agent_mcp.rs`
   (`<area>_<verb>`, clear description saying when to use it).
2. Implement by calling the same internal function the HTTP route uses — one
   code path for UI and agent.
3. Needs a secret? Return the SECRET_PROMPT / connector setup card; never
   accept the value as a tool argument. OAuth? Return an OAUTH_CONNECT card.
4. Add a test in `agent_mcp.rs` tests and an `agent-driven` E2E step that
   asks for it in plain language and asserts the resulting state.

## Add or change a translation

- Keys identical in `en.json` and `hi.json`; same `{placeholders}`; ICU
  plurals may be simplified in Hindi but must keep the variable names.
- Check: `pnpm check:i18n` — the E2E `agent-hub` journey also switches the
  UI to Hindi and back.
- Do not add other locales without an explicit product decision.

## Change the runtime

Small local patch: edit `runtime/`, add an entry to
`docs/runtime-customizations.json`, run `pnpm runtime:check`. Upstream
update: `amiro-runtime-update` skill + `scripts/runtime-update/`.

## Add a skill

Copy `.agents/skills/_template/SKILL.md`; `name:` equals the folder; one dense
`description` with trigger phrases; body under ~100 lines; detail in
`reference/`. Add it to the table in `.agents/skills/README.md`.
