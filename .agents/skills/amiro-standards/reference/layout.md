# Amiro folder structure and naming

```
Amiro/
├── AGENTS.md                 rules every agent follows (points here)
├── CONTRIBUTING.md           human contributor guide: checks, commits, PR flow
├── .agents/skills/           repo skills: develop-feature, amiro-standards (this),
│                             backend, ui, test, e2e-journeys, amiro-runtime-update,
│                             plan, implement
├── src/                      Next.js app, statically exported to out/
│   ├── app/                  routes (App Router). (chat)/ = signed-in shell,
│   │                         (chat)/(admin)/admin/* = admin pages,
│   │                         (auth)/ = setup + sign-in, onboarding/ = wizard
│   ├── components/           feature folders (connectors/, credentials/,
│   │                         voice-room/, onboarding/…) + ui/ (shadcn primitives)
│   ├── lib/backend/          one <area>-api.ts per backend area, all via apiJson
│   ├── lib/                  domain helpers (ai/, chat/, voice/, security/…)
│   ├── i18n/                 locale resolution (cookie → navigator → "en")
│   └── types/                shared TS types (alias app-types/*)
├── messages/                 en.json + hi.json ONLY (language.md explains)
├── backend/                  Rust axum backend, binary amiro-backend
│   ├── src/main.rs           router assembly: .merge(<module>::router())
│   ├── src/routes.rs         merges every routes/<area>::routes()
│   ├── src/routes/<area>.rs  feature routes (voice, mcp, connectors, credentials…)
│   ├── src/agent_mcp.rs      tools the agent calls to configure Amiro
│   ├── src/state.rs          AppState, AuthUser, ApiError, read_json/write_json
│   └── tests/                integration tests on the real router (temp home)
├── runtime/                  vendored jcode fork (amiro-* crates); PROVENANCE.md
├── src-tauri/                desktop shell; binaries/ = sidecars (ignored)
├── tests/
│   ├── e2e/                  recorded Playwright journeys (see e2e-journeys)
│   ├── rust/                 std-only testkit
│   └── fixtures/             MCP/skills/workspace fixtures
├── scripts/                  build + verification entrypoints
│   └── runtime-update/       versioned jcode→Amiro normalizer for upstream updates
└── docs/                     design docs; several are history, README is truth
```

Detailed standards per layer: `backend`, `ui`, `test` skills; the end-to-end
workflow for a feature: `develop-feature`.

## Naming

| Thing | Convention | Example |
| --- | --- | --- |
| Route folder | kebab-case under `src/app/(chat)/…` | `admin/voice/page.tsx` |
| Component file | kebab-case `.tsx`, PascalCase export | `secret-prompt-card.tsx` → `SecretPromptCard` |
| API client | `src/lib/backend/<area>-api.ts` | `connectors-api.ts` |
| i18n key | `Section.camelCaseKey`, same in en + hi | `Providers.runTestHint` |
| Test id | `data-testid="<area>-<thing>"` kebab | `composer-store-securely` |
| Backend module | snake_case `.rs`; `routes/<area>.rs` exposes `pub fn routes()`, top-level domains `pub fn router()` | `routes/voice.rs` |
| HTTP path | `/api/<area>/<resource>` | `/api/connectors/custom` |
| Agent tool | `<area>_<verb>` snake_case | `search_provider_configure` |
| Env var | `AMIRO_*`; secrets `AMIRO_CRED_*` | `AMIRO_CRED_SEARCH_BRAVE_API_KEY` |
| E2E spec | `tests/e2e/specs/NN-<journey>.spec.ts` | `05-connectors.spec.ts` |
| Skill | `.agents/skills/<kebab>/SKILL.md`, `name:` = folder | `amiro-standards` |
| Commit | `type(scope): imperative summary` | `feat(i18n): add Hindi` |

## Import aliases (tsconfig)

`ui/*` → `src/components/ui/*`, `lib/*` → `src/lib/*`, `app-types/*` →
`src/types/*`, `auth/*`, `logger`, `@/*` → `src/*`. Prefer the alias the
surrounding file already uses.
