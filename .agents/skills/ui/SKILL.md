---
name: ui
description: Amiro's UI standards — folder structure, surface constraints and implementation rules for anything user-facing. Covers the Next.js dashboard (which ships three ways: inside the Tauri desktop webview, served from the Go binary by `amiro serve`, and `next dev` for frontend-only work) and the Go/Bubble Tea terminal UI. Use whenever adding, moving or changing a page, route group, React component, hook, styling token, translation string, client-side data fetch or auth gate under `src/`, or a screen/component/keybinding under `backend-go/internal/tui/`. Also use when deciding where a new piece of UI belongs, or when reviewing UI work for standards compliance.
---

# Amiro UI Standards

The rules any agent must follow when implementing anything a user sees.
Scope: `src/**` (the Next.js dashboard) and `backend-go/internal/tui/**`
(the terminal UI). Backend routes, storage and provider work belong to the
`backend` skill — read that one instead when the change is server-side.

## The surfaces, and what each one implies

Amiro ships **one** React codebase to three places, plus a separate Go TUI.
Write for all of them at once; never for just the one you happen to be
running.

| Surface | How it runs | What it changes for you |
|---|---|---|
| **Desktop (Tauri)** | Rust shell spawns the Go sidecar, loads the static export into a webview, injects `window.__BACKEND_PORT__` / `__BACKEND_TOKEN__` / `__BACKEND_SESSION_TOKEN__` before first paint | API is cross-origin loopback; the shared-secret header is required |
| **Web (`amiro serve`)** | Go binary serves the same export and the API off one listener (`-tags embedui`), injects `window.__BACKEND_ORIGIN__` | API is same-origin; **no** shared secret is sent — auth is same-origin + session. Can be bound to `0.0.0.0`, so treat the caller as untrusted |
| **Frontend-only dev** | `pnpm dev` + `scripts/dev-backend.sh`, `.env.local` supplies `NEXT_PUBLIC_BACKEND_URL`/`_TOKEN` | Dev/test only. Never a code path the shipped app takes |
| **Terminal (TUI)** | `amiro` / `amiro run`, Bubble Tea over a real PTY; `amiro --serve` runs TUI + dashboard on one backend | Go, not React. Same backend, same database, same threads |

Two consequences that are not optional:

1. **The dashboard is a static export** (`output: "export"` in
   `next.config.ts`). There is no Node server at runtime, on any surface.
2. **Feature parity is expected across the three web surfaces.** A feature
   that only works because Tauri injected a global, or only works
   same-origin, is a bug. If a feature genuinely cannot exist on a surface,
   detect and degrade explicitly — never assume.

## Static export: the hard constraints

These are compile-or-runtime failures, not preferences.

| Forbidden | Use instead |
|---|---|
| `app/api/**` route handlers | A Go route (`backend` skill) + a client fetch |
| Server Actions, `"use server"` | A client call through `lib/backend/` |
| `next/headers` (`cookies()`, `headers()`) | `document.cookie` / `localStorage` client-side |
| `middleware.ts` / `proxy.ts` auth gates | `RequireAuth` / `RequireAdmin` from `@/lib/backend/auth-gate` |
| `redirect()` / `forbidden()` / `unauthorized()` | `useRouter().replace(...)` in an effect |
| Server-Component data fetching | SWR in a client component |
| A dynamic segment with no `generateStaticParams` | Query string, or a static shell that reads the id client-side |
| `experimental_ppr`, `authInterrupts` | — (no server to run them) |

Practically every interactive component in this tree starts with
`"use client"`. That is correct, not a smell.

## Folder structure — `src/`

```
src/
├── app/                      # routes only; a page is a thin shell
│   ├── (auth)/               # sign-in, sign-up — wrapped in RedirectIfAuthed
│   ├── (chat)/               # the signed-in app — layout.tsx wraps RequireAuth
│   │   └── (admin)/          # admin-only — wrapped in RequireAdmin
│   ├── (public)/             # no session required (e.g. /export/[id])
│   ├── onboarding/
│   ├── store/                # zustand: index.ts (appStore) + <domain>.store.ts
│   ├── globals.css           # Tailwind v4 entry + every design token
│   └── layout.tsx            # providers only, in the documented order
├── components/
│   ├── ui/                   # shadcn/ui primitives + icons. Generic, no domain logic
│   ├── layouts/              # sidebar, header, providers, theme
│   └── <domain>/             # skill/ artifacts/ chat/ workflow/ user/ export/ ...
├── hooks/
│   ├── queries/              # use-<thing>.ts — one SWR hook per endpoint
│   └── use-*.ts              # generic behaviour hooks
├── lib/
│   ├── backend/              # THE ONLY PLACE THAT TALKS TO THE SIDECAR
│   ├── <domain>/             # ai/ auth/ admin/ cache/ user/ validations/ ...
│   └── utils.ts              # cn(), fetcher re-export, small helpers
└── types/                    # shared TS types (imported as `app-types/*`)
```

Placement rules:

- A `page.tsx` renders a component; it does not hold logic, fetching, or JSX
  of any size. Put the real thing in `components/<domain>/`.
- Reusable and domain-free → `components/ui/`. Anything that knows about
  skills, threads, MCP or workflows → `components/<domain>/`.
- Any component reused by two or more pages moves out of the page's folder.
- One SWR hook per endpoint in `hooks/queries/`, named `use-<noun>.ts`.
  Never call `useSWR` with a raw URL inline in a component.
- A new route group only when it has a distinct auth posture.

### Import aliases (`tsconfig.json`) — use them, never deep relative paths

| Alias | Resolves to |
|---|---|
| `@/*` | `src/*` |
| `ui/*` | `src/components/ui/*` |
| `lib/*` | `src/lib/*` |
| `auth/*` | `src/lib/auth/*` |
| `app-types/*` | `src/types/*` |
| `logger` | `src/lib/logger.ts` |

## Talking to the backend

**Never call `fetch()` directly on an `/api/...` path.** The base URL and
the two auth headers differ per surface and are resolved in one place.

```ts
import { apiFetch, fetcher, backendFetch, ApiError } from "@/lib/backend/client";
```

| Need | Use |
|---|---|
| Read for a component | `useSWR<T>("/api/thing", fetcher)` inside a `hooks/queries/` hook |
| Mutation / one-off | `apiFetch("/api/thing", { method: "POST", body })` |
| AI SDK transport | `DefaultChatTransport({ api: backendUrl("/api/chat"), fetch: backendFetch })` |
| A persisted `/storage/...` URL | `rewriteStorageUrl(url)` — the loopback port changes every launch |
| A new endpoint family | Add `src/lib/backend/<domain>-api.ts` beside the existing ones |

Errors arrive as `ApiError` (`.status`, `.info`); surface them with
`handleErrorWithToast` from `ui/shared-toast`, not a bare `alert`/`console`.

## Auth and session

- Session comes from `useSession()` (`@/lib/backend/session-context`) —
  never read `localStorage` for the token yourself.
- Gate with `RequireAuth` / `RequireAdmin` / `RedirectIfAuthed` from
  `@/lib/backend/auth-gate`, applied at the **layout** level of a route group.
- These gates are UX only. The sidecar is the real enforcement point, so a
  client-side check never substitutes for a server-side one — if a new route
  needs protecting, protect it in Go too.

## Styling

- **Tailwind v4**, configured entirely in `src/app/globals.css` (there is no
  `tailwind.config`). Dark mode is the `.dark` class via the
  `@custom-variant` at the top of that file.
- **Use tokens, never raw colors.** `bg-background`, `text-foreground`,
  `border-border`, `bg-muted`, `text-muted-foreground`, `bg-primary`… A new
  color means a new `oklch(...)` token defined for **both** `:root` and
  `.dark`, plus its `@theme inline` mapping.
- Merge classes with `cn()` from `lib/utils`. Variants go through `cva`
  (see `ui/button.tsx`), never a hand-rolled ternary chain.
- shadcn/ui, `style: new-york`, `baseColor: neutral`, CSS variables on. Add
  primitives under `components/ui/`, keeping the `data-slot="…"` convention.
- Icons: **lucide-react** only. Brand marks already living in
  `components/ui/*-icon.tsx` are the exception.
- Fonts are the three `next/font/google` variables wired in
  `app/layout.tsx` (`--font-fraunces` is the sans/brand face,
  `--font-geist-mono` mono). Do not import fonts anywhere else.
- Motion: `framer-motion`, already a dependency. Respect
  `prefers-reduced-motion` and the `reduce-transparency` variant.

## i18n

Every user-visible string goes through `next-intl`.

```tsx
const t = useTranslations("Chat");
<span>{t("newThread")}</span>
```

- `messages/en.json` is the source of truth; a new key must be added to all
  seven locale files (`en es fr ja ko no zh`; `messages/language.md`
  documents them). Missing keys fall back to English via the deepmerge in
  `components/layouts/locale-provider.tsx` — a fallback is not a substitute
  for translating.
- No hardcoded English in a component, including toasts, empty states,
  `aria-label`s and error copy.

## State

| Kind | Tool |
|---|---|
| Server data | SWR (`hooks/queries/`) — it is the cache; don't mirror it into zustand |
| Cross-component client state | `appStore` (`@/app/store`), or a `<domain>.store.ts` |
| Local component state | `useState` / `useObjectState` |
| Persisted preference | `use-state-with-browserstorage` |

## Desktop-specific (Tauri)

- `src-tauri/src/lib.rs` owns sidecar lifecycle, the per-launch token and
  webview injection. Changing what the frontend receives means changing
  `lib.rs` **and** `src/lib/backend/config.ts` together.
- Never import a Tauri API into a shared component — it would break the
  served-web and dev surfaces. Feature-detect the injected globals instead.
- New Tauri permissions go in `src-tauri/capabilities/default.json`.

## Terminal UI (`backend-go/internal/tui/`)

Go + Bubble Tea + Lipgloss. Same backend, so a user-visible change to a
thread, model or permission mode must be reflected here too.

```
internal/tui/
├── app/         # the root bubbletea.Model, wiring and routing
├── page/        # full screens: chat, threads, models, settings, mentions, nav
├── component/   # reusable widgets: editor, status, toolcard, approval, todo
├── client/      # HTTP/SSE client against the backend (attach or embed)
├── config/      # .amiro/config.yaml precedence: CLI → project → user → AMIRO_* → default
├── keys/        # every keybinding — one place, no inline key literals
└── theme/       # every style/color — one place, no inline lipgloss colors
```

- Colors and styles come from `theme/theme.go`; keybindings from `keys/`.
  Inline literals in a page or component are the standard violation.
- Rendering is proven by golden tests (`charmbracelet/x/exp/golden`) with
  `testdata/*.golden` next to the page/component. Add a golden for any new
  screen state; update deliberately, and review the diff.
- Behaviour and lifecycle are proven at PTY level in `tests/suites/tui/`,
  not by duplicating golden assertions there.
- Handle narrow terminals, resize, CJK/wide runes and long lines — there is
  a `rendering` feature suite that will catch you.

## Before calling UI work done

```bash
pnpm check          # biome lint:fix + tsc --noEmit + vitest
```

For TUI changes:

```bash
cd backend-go && go build ./... && go vet ./... && go test ./internal/tui/...
```

To see it in the real surfaces: `cargo tauri dev` (desktop);
`pnpm build && ./scripts/build-ui.sh` then a `-tags embedui` build and
`amiro serve` (web). The E2E suites live in `tests/`
(`amirotest run --surface ui` / `--surface tui` / `--surface desktop`).

## Anti-patterns seen in this repo

| Don't | Do |
|---|---|
| `fetch("/api/x")` | `apiFetch("/api/x")` |
| `useSWR` with an inline URL in a component | a hook in `hooks/queries/` |
| `bg-white dark:bg-zinc-900` | `bg-background` |
| A hardcoded English string | `useTranslations` + all seven locale files |
| A page component holding fetching + JSX + handlers | a thin `page.tsx` + a `components/<domain>/` component |
| Adding a Next.js route handler | a Go route (see the `backend` skill) |
| `../../../components/ui/button` | `ui/button` |
| Inline `lipgloss.Color("…")` in a TUI page | a style in `theme/theme.go` |
