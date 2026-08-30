# Phase 5 — The Skills section, and Generate with AI

**Status:** ✅ Complete (9/9 criteria MET)
**Date:** 2026-08-22
**Verification Log:** [verification-log-phase-05.md](verification-log-phase-05.md)

---

## 1. What Shipped

The Agents section of the dashboard is replaced by a Skills section on all
three web surfaces (`amiro serve`, the Tauri desktop webview, and
frontend-only dev): a list page grouping **My skills** (writable) and
**Discovered** (read-only) with source badges and a lock icon, a detail
page that creates/edits/deletes a writable skill or opens a read-only one
disabled with a **Duplicate to my skills** escape hatch, and a **Generate
with AI** dialog that drafts a `SKILL.md` for review without ever writing
it itself. The backend gained one new route,
`POST /api/skills/generate`, a streaming-object handler in the same shape
as `POST /api/agent/ai`. The three "Create Agent" entry points named in
the phase doc — `create-agent-button`, `create-agent-card`, and the
sidebar's Agents item — are gone from the UI; the agent backend and the
still-reachable agent detail view (`/agent?id=`) are untouched, per the
phase's stated scope.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Skills list page** | `src/app/(chat)/skills/page.tsx`, `.../skills/loading.tsx`, `src/components/skill/skills-list.tsx` | Replaces `agents/page.tsx`; My skills / Discovered sections, source + scope badges, lock icon on read-only cards |
| **Skill detail page** | `src/app/(chat)/skill/page.tsx`, `.../skill/loading.tsx`, `src/components/skill/edit-skill.tsx` | Replaces `agent/page.tsx`; name/description/body form, field errors, live portability hints, delete, duplicate |
| **Generate Skill dialog** | `src/components/skill/generate-skill-dialog.tsx` | `experimental_useObject` against `/api/skills/generate`, same shape as `generate-agent-dialog.tsx` |
| **Sidebar Skills section** | `src/components/layouts/app-sidebar-skills.tsx` | Replaces `app-sidebar-agents.tsx`; My skills list, click-to-mention into the active thread |
| **Skills API client additions** | `src/lib/backend/skills-api.ts`, `src/types/skill.ts` | `createSkill`/`updateSkill`/`deleteSkill`/`duplicateSkill`, `SkillGenerateSchema`, client-side name/description validators mirroring `internal/skills/validate.go` |
| **`useMutateSkills`** | `src/hooks/queries/use-skills.ts` | Invalidates every cached `/api/skills*` list after a write, so the Skills page and the composer's `/` palette agree without a reload |
| **`POST /api/skills/generate`** | `backend-go/internal/api/skills/generate.go` | Streaming-object handler; `Engine` interface narrowed to `GenerateObject`, same non-streaming-body contract as `agent/ai.go` |
| **`BuildSkillGenerationPrompt`** | `backend-go/internal/ai/prompts/prompts.go` | System prompt encoding the name-charset, what-and-when description, and ~500-line body rules from `internal/skills/validate.go` |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend (Go unit) | `backend-go/internal/api/skills/generate_test.go` | 4 | `Generate` handler: unauthorized, success against a fake engine, malformed-response clean error, no-engine-configured clean error |
| backend (harness) | `tests/suites/backend/skills/generate_test.go` | 3 | Streams a valid object against the fake provider; a malformed model reply is a clean 500, not a panic; the route writes nothing to `$HOME/.agents/skills` (scanned before/after) |
| desktop | `tests/suites/desktop/skills/desktop_skills_test.go` | +1 | `POST /api/skills` through the untagged sidecar writes under *that sidecar's* isolated `$HOME` and is listed immediately by `GET /api/skills` |
| cross | `tests/suites/cross/skills/skills_test.go` | +1 | A skill created through the dashboard's **authoring** API (not a planted fixture file) reaches the TUI's `/` palette in the same run |
| web (Playwright) | `tests/ui/specs/skills/skills-page.spec.ts` | 9 | List sections + badges; create→list→palette without reload; bad name and over-long description field errors (verified via `GET /api/skills`, not the DOM); read-only skill disabled + Duplicate → editable copy; delete confirms then removes; Generate populates the form without saving (scripted fake-provider reply); a generated invalid name shows a field error; `create-agent-button`/`create-agent-card` match zero elements |
| meta | `tests/suites/meta/route_coverage_test.go` | auto | Picked up `POST /api/skills/generate` with zero waivers needed (108/108 routes covered) |

**Not covered, and why:** Editing bundled `scripts/`/`references/`/`assets/`
from the UI, and skill sharing/visibility/bookmarking — both stated
non-goals in the phase doc, not gaps. TUI authoring is out of scope by
Decision 9 in `docs/skills/README.md`.

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `backend-go/internal/api/skills/handler.go` | `NewHandler` takes an `Engine`; **fixed a real bug** — `toListResponse` returned a `nil` (→ JSON `null`) `items`/`diagnostics` slice for an empty list instead of `[]` | +23 / -6 |
| `backend-go/internal/api/skills/route_test.go`, `backend-go/internal/httpserver/skills_routes_test.go` | Updated `NewHandler(...)` call sites for the new `engine` parameter | +16 / -16 |
| `backend-go/internal/appwiring/wiring.go` | Wires `bifrostClient` into `skillsapi.NewHandler` | +1 / -1 |
| `backend-go/internal/httpserver/router.go` | Registers `POST /api/skills/generate` | +1 |
| `src/components/agent/edit-agent.tsx` | Post save/delete redirects `/agents` → `/` (the `/agents` route no longer exists) | +3 / -3 |
| `src/components/chat/skill-palette.tsx` | Flips the Phase-2 `ENABLE_CREATE_SKILL_LINK` flag on now that `/skill?name=new` exists; empty-state "create one" is a real `Link` | +9 / -5 |
| `src/components/layouts/app-sidebar.tsx` | `AppSidebarAgents` → `AppSidebarSkills`; drops the now-unused `userRole` | +2 / -3 |
| `tests/harness/apiclient/skills.go` | `GenerateSkill` client method | +20 |
| `tests/ui/pages/index.ts` | Removes `AgentsPage` (its route is gone); adds `SkillsPage`, `SkillDetailPage`, `GenerateSkillDialog` | +85 / -18 |
| `tests/ui/specs/agents/agent-detail.spec.ts` | Post-create assertion follows the `/` redirect instead of the deleted `/agents` list | +3 / -2 |
| `tests/ui/specs/dashboard/fallback.spec.ts` | SPA-fallback deep-link probe moved from `/agents` to `/skills` | +5 / -4 |
| `tests/ui/support/fixtures.ts` | Adds a `fakeReply` test option, threaded into `amirotest backend start --fake-reply`, so a spec can script a JSON reply for an `experimental_useObject` flow | +23 / -3 |

**Deleted** (no remaining callers once the sidebar/list entry points were
gone — see divergence 1): `src/app/(chat)/agents/page.tsx`,
`src/app/(chat)/agents/loading.tsx`, `src/components/agent/agents-list.tsx`,
`src/components/agent/agent-dropdown.tsx`,
`src/components/layouts/app-sidebar-agents.tsx`,
`tests/ui/specs/agents/agents.spec.ts`.

---

## 2. What Diverged from the Plan, and Why

1. **`agents/page.tsx` itself was deleted, not just its create button and
   card.** The phase doc's "Entry points removed here" list named exactly
   three things (`create-agent-button`, `create-agent-card`, the sidebar's
   Agents item) and didn't say to delete the `/agents` route. But once the
   sidebar no longer links to it and its own create affordances are gone,
   `agents/page.tsx` has no path to it left in the UI and would 404-adjacent
   dead code sitting behind a URL nobody can reach by clicking. Deleted it,
   `agents-list.tsx` (its only consumer), and `agent-dropdown.tsx` (used
   only by the now-deleted sidebar component) along with it. `agent/page.tsx`
   (`?id=`, the detail/edit view) is untouched and still reachable — the
   Risks section's mitigation ("this phase updates those specs to the
   extent the agent detail view still exists") assumes exactly this split.
   This forced two follow-on fixes: `edit-agent.tsx`'s post-save/delete
   `router.push("/agents")` now goes to `/` (nothing to return to), and
   `tests/ui/specs/dashboard/fallback.spec.ts`'s SPA-deep-link probe, which
   hard-refreshed `/agents` and asserted `agents-title`, was repointed at
   `/skills`/`skills-title` — caught by the full `amirotest run`, not by
   `pnpm check` (a Playwright spec isn't type-checked against runtime DOM
   state).
2. **`agent-icon-picker.tsx` and `agent-tool-selector.tsx` were *not*
   deleted**, despite the phase doc's mapping table listing them alongside
   `agent-dropdown.tsx` as "not carried over" / "deleted". `edit-agent.tsx`
   (the still-live detail view, divergence 1) imports both directly; only
   `agent-dropdown.tsx` had zero remaining callers once
   `app-sidebar-agents.tsx` was gone. Recorded in `04-surfaces.md` as well,
   since it made a table entry there wrong.
3. **A real pre-existing bug, found and fixed because Phase 5 was the
   first caller that couldn't tolerate it:**
   `internal/api/skills/handler.go`'s `toListResponse` built `items`/
   `diagnostics` with `var items []SkillSummaryDTO` — a nil slice, which
   `encoding/json` serializes as `null`, not `[]`, whenever a list is
   empty. Phase 0–4's only consumers (`skill-palette.tsx`,
   `use-skills.ts`'s read hook) happened to guard every read with `?? []`,
   so this never surfaced. Phase 5's `useMutateSkills` cache updater and
   this phase's own Playwright helper (`apiGetSkills`) did not, and hit
   `Cannot read properties of null (reading 'findIndex'/'map')` on the
   very first empty-state run. Fixed at the source (`items :=
   []SkillSummaryDTO{}`) rather than patched around at every call site —
   the frontend guards were *also* hardened defensively (belt-and-suspenders,
   `cached.items ?? []`), but the real fix is that `GET /api/skills` now
   always returns a JSON array.
4. **Duplicating a read-only skill with no name collision left the page
   showing stale read-only data.** `service.go`'s `Duplicate` (Phase 4)
   only appends a `-copy` suffix on an actual collision in the writable
   root; the common case (nothing there yet) lands under the *identical*
   name. `edit-skill.tsx`'s `router.push(`/skill?name=${created.name}`)`
   then navigates to a URL that is byte-identical to the one already
   showing, so the `useSWR('/api/skills/items/<name>', ...)` key never
   changes and SWR serves the cached (stale, read-only) response instead of
   refetching. Fixed by explicitly calling `mutate(key, created, {revalidate:
   true})` on that specific item-detail key in the `duplicate()` success
   handler, ahead of the (no-op-looking) `router.push`.
5. **Testing "Generate fills the form" needed a new, reusable piece of test
   infrastructure**, not something the plan anticipated. The UI harness's
   fake provider (`amirotest backend start`) always returns one fixed,
   non-JSON canned sentence (`fakeprovider_cmd.go`), which
   `GenerateObject`'s `json.Valid` check correctly rejects — there was
   simply no way to make `experimental_useObject` resolve to a real object
   in a Playwright spec before this phase. Added a `fakeReply` test option
   to `tests/ui/support/fixtures.ts`, threaded through the already-existing
   (but previously unused by any spec) `amirotest backend start
   --fake-reply` flag. This is now available to any future UI spec that
   needs to test a `useObject`/schema-constrained flow, not just this one.

---

## 3. Exit Criteria (Verbatim from `phases/phase-05-skills-ui.md`)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | "`amirotest run --surface ui --feature skills` passes in under 2 minutes." | ✅ MET | `PASSED · 20 passed · 0 failed · 0 skipped · 1m 44s` — the run's own headline duration (matching Playwright's own `20 passed (1.7m)`) is under budget; see the verification log's note on this run's per-surface table row reporting a longer `2m 55s`. |
| 2 | "A spec creates a skill through the form and asserts it appears in the list **and** in the `/` palette without a page reload." | ✅ MET | `ui/skills/create → appears in the list → appears in the '/' palette without a reload` — passes; the spec never calls `page.reload()`. |
| 3 | "A spec asserts a read-only `.claude` skill opens disabled, names `.claude`, and that Duplicate yields an editable copy under **My skills**." | ✅ MET | `ui/skills/a read-only skill opens disabled, names its owner, and Duplicate yields an editable copy` — passes. |
| 4 | "A spec asserts a bad name produces a field-level error and that no skill was created (verified through `GET /api/skills`, not through the DOM)." | ✅ MET | `ui/skills/a bad name produces a field-level error and creates nothing` — passes; asserts via an in-page `fetch('/api/skills', ...)`, not a DOM query. |
| 5 | "A spec asserts Generate populates the form and that nothing is written until Save is pressed." | ✅ MET | `ui/skills — generate with AI/Generate populates the form and nothing is written until Save is pressed` — passes, using the new `fakeReply` fixture option (divergence 5). |
| 6 | "A spec asserts `[data-testid=\"create-agent-button\"]` and `[data-testid=\"create-agent-card\"]` match zero elements anywhere in the app." | ✅ MET | `ui/skills/\`create-agent-button\` and \`create-agent-card\` match zero elements anywhere in the app` — passes on both `/skills` and `/`. |
| 7 | "`amirotest run --surface cross --feature skills` asserts a dashboard-created skill reaches the TUI palette." | ✅ MET | `PASSED · 2 passed · 0 failed · 0 skipped · 2.2s` — includes the new `TestCrossSurface_SkillCreatedInDashboardReachesTUISlashPalette`. |
| 8 | "`pnpm check` is clean; all seven locale files carry the new keys." | ✅ MET | `pnpm check` — biome 0 fixes, `tsc --noEmit` clean, 354/354 vitest tests pass. All seven `messages/*.json` files parse and carry the `Skill` namespace plus `Layout.skills`/`Common.generating`/`Common.send`. |
| 9 | "`amirotest run` is green overall, `suites/meta` included, with every skip reasoned." | ✅ MET | `PASSED · 332 passed · 0 failed · 18 skipped · 5m 12s`. All 18 skips pre-date this phase (11 `slow`/`live`-tagged, 4 missing-`cargo` desktop, 2 resilience PARTIAL/NOT MET, 1 deliberate expected-fail probe); `suites/meta` 17/17. |

---

## 4. Standards Compliance

- **`ui`:** Tokens throughout (no raw colors); `cn()` for conditional
  classes; lucide-react icons only; `data-testid` on every element a spec
  touches; SWR (`hooks/queries/`) for every read; `handleErrorWithToast`
  on every write failure; `apiJson`/`apiFetch` — no bare `fetch` in the
  app code (the Playwright spec's `page.evaluate(fetch(...))` is test
  code, not app code, and deliberately mirrors what `apiFetch` does for a
  same-origin backend); static export constraints respected (no route
  handlers, no server actions, no `next/headers`) — proven by `next build`
  succeeding and `/skill`, `/skills` appearing as prerendered static
  routes.
- **`backend`:** New route follows the four-step pattern (handler → 
  `router.go` → wired in `appwiring` → typed TS client); depends on the
  narrow `Engine` interface, not `*bifrostai.Client`, matching
  `internal/api/agent`'s existing pattern; `httpjson` used throughout;
  Go build clean both with and without `-tags embedui`.
- **`test`:** Every surface the phase reaches has a test (backend ×2 forms,
  desktop, cross, web); `suites/meta`'s route-coverage guard picked up the
  new route automatically (108/108, 0 waivers); no `time.Sleep` or
  `page.waitForTimeout` introduced; the new UI spec's locators live in
  `tests/ui/pages/index.ts` as page objects, per the `test` skill.

---

## 5. Known Scope Boundaries & Follow-ups

- **`src/lib/auth/client-permissions.ts`'s `canCreateAgent` is now
  unreferenced.** It was used only by the now-deleted `agents-list.tsx`
  and `app-sidebar-agents.tsx`. Left in place rather than deleted — it's a
  shared permissions-module export, not Skills-feature code, and cleaning
  it up belongs to Phase 6 (Decommission agents), which will already be
  auditing every remaining agent-only code path.
- **The Skills page's "My skills" / "Discovered" split is home-scope
  only** in the sense that `Create` always writes to `$HOME/.agents/skills`
  (Phase 4's `WritableRoot`) — there is no project-scope authoring in v1,
  matching the phase doc's Decision 5. The Skills list and sidebar both
  read with `?project=<active projectDirectory>` so project-scope
  *discovered* skills still show up (read-only, same as any other source),
  they just can't be created there.
- **A large body in a plain `<textarea>`**, per the phase doc's own stated
  risk — v1 ships a monospace textarea with a live line count; a richer
  markdown editor is a deliberate non-goal here, not an oversight.
- **The `ui/skills — generate with AI` describe blocks use `test.use({
  fakeReply })` at the file's outer scope**, meaning every test in that
  block shares one scripted reply. A future spec needing two different
  generated payloads in the same file will need either a second file or a
  nested `test.describe` with its own `test.use` — both already supported
  by the fixture as built, just not exercised yet.
