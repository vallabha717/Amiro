---
name: ui
description: Amiro's UI standards for the Next.js frontend in src/ (statically exported to out/ and served by the Rust backend and the Tauri desktop shell). Covers folder structure, where a page/component/hook/API client goes, the static-export rules, data fetching via src/lib/backend/<area>-api.ts and SWR, state (zustand), styling tokens and shadcn ui/ primitives, English+Hindi i18n with next-intl, accessibility and test ids, and secret handling in the composer. Use whenever adding or changing a page, route, React component, hook, form, toast, translation string, client-side API call or anything under src/** or messages/**, when deciding where UI belongs, and when reviewing UI work.
---

# Amiro UI standards

`src/` is a Next.js App Router app, **statically exported** (`output: "export"`
in `next.config.ts`) to `out/`. The Rust backend serves `out/` and the API on
the same origin; the Tauri desktop shell loads the same build. Everything runs
in the browser: no server components fetching data, no Next API routes, no
server actions, nothing that needs a Node server at runtime.

## Folder structure

```
src/
├── app/
│   ├── (auth)/setup, (auth)/sign-in     first-run account + sign-in
│   ├── onboarding/                      first-run wizard
│   ├── (chat)/                          signed-in shell (sidebar layout)
│   │   ├── page.tsx                     chat home
│   │   ├── connectors/ schedules/ agent/… feature pages
│   │   └── (admin)/admin/<section>/     admin pages (providers, voice, search…)
│   ├── (public)/export/                 public share pages
│   └── store/                           global zustand stores
├── components/
│   ├── <feature>/                       feature components (connectors/,
│   │                                    credentials/, voice-room/, onboarding/…)
│   ├── layouts/                         sidebar, header, theme + locale providers
│   └── ui/                              shadcn/Radix primitives — reuse, don't fork
├── lib/
│   ├── backend/<area>-api.ts            the ONLY place that calls the API
│   └── <domain>/                        hooks, helpers, stores (voice/, chat/, security/…)
├── i18n/                                locale resolution (cookie → browser → en)
└── types/                               shared types (alias app-types/*)
messages/en.json, messages/hi.json       the only two UI languages
```

**Where does it go?** New page → `src/app/(chat)/<route>/page.tsx` (admin:
`(chat)/(admin)/admin/<section>/page.tsx`) that stays thin: `"use client"`,
session guard, render `<FeaturePage />` from `src/components/<feature>/`.
Reusable widget → `src/components/<feature>/`; generic primitive → already in
`components/ui/` (add there only if truly generic). API calls →
`src/lib/backend/<area>-api.ts`. Cross-page state → `src/app/store` or
`src/lib/<domain>/*-store.ts` (zustand).

## Rules

| Topic | Standard |
| --- | --- |
| Data | Wrap endpoints as typed functions using `apiJson<T>()` from `lib/backend/client`; read with `useSWR` + `mutate` after writes, like neighbouring pages. Never `fetch("/api/…")` inline in a component |
| Auth | Pages render nothing until `useSession()` has a session (pattern in `app/(chat)/connectors/page.tsx`). Owner-only UI checks the role and the backend enforces it too |
| Text | `const t = useTranslations("Section")`; every string in **both** `messages/en.json` and `messages/hi.json` (same key, same `{placeholders}`). No new hardcoded English in translated components. No other locales |
| Style | Tailwind with theme tokens (`bg-background`, `text-muted-foreground`, `border`, `bg-card`, `text-primary`…) from `globals.css`; light + dark must both work. Icons: `lucide-react`. Feedback: `toast` from `sonner` |
| Components | Compose `ui/*` (Button, Dialog, Select, Switch, Tooltip…). File names kebab-case, components PascalCase, one feature per folder. Imports via aliases `ui/*`, `lib/*`, `@/*` |
| A11y | Every icon-only button has `aria-label`; inputs have labels; one non-empty `<h1>` per page; keyboard reachable; no colour-only meaning. The `ux-audit` E2E journey checks this |
| Test ids | Add `data-testid="<area>-<thing>"` to controls an E2E step drives (`composer-store-securely`, `provider-card`) |
| Secrets | Never render a stored key back. Key inputs are `type="password"` with a show toggle; prefer the vault/secret card flows. The composer guard (`components/credentials/composer-secret-guard.tsx`) must keep catching pasted keys |
| Honesty | No UI for capabilities that do not exist; disabled states explain why; errors from `ApiError` are shown, not swallowed |
| Size | Keep page files thin; split components over ~300 lines; co-locate small helpers |

## Test it (required)

- **Unit/component** — Vitest, co-located `*.test.ts(x)` next to the file
  (`src/components/search-provider-ui.test.tsx`, `src/lib/**/x.test.ts`).
  Run `pnpm test`.
- **Types + lint** — `pnpm check-types` (also compiles the E2E specs) and `pnpm lint`.
- **E2E** — any user-visible change gets a `step(...)` in the owning journey in
  `tests/e2e/specs/` (see the `test` and `e2e-journeys` skills). Run
  `pnpm build` first so `out/` contains your change.

## Done checklist

- [ ] Page thin, logic in `components/<feature>/`, API calls in `lib/backend/`
- [ ] Strings in en.json **and** hi.json; light/dark checked
- [ ] aria-labels, labels, test ids on new controls
- [ ] `pnpm check-types && pnpm lint && pnpm test` green
- [ ] E2E journey step added and its video watched

History: this skill used to also cover a Go/Bubble Tea terminal UI under
`backend-go/`. That is gone; the runtime's own TUI lives in `runtime/` and is
upstream code.
