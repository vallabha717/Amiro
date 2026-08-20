# Phase 0 — Discovery core and the read API

> **Shipped 2026-08-20.** See the [Phase 0 progress record](../progress/phase-00-discovery.md) and its [verification log](../progress/verification-log-phase-00.md).

**Depends on:** — · **Blocks:** 1, 2, 3, 4 · **Size:** M

**Surfaces touched:** backend

This phase will make Amiro able to answer "what skills exist on this
machine, for this user, in this project?" — once, correctly, and with no
duplicates. It will add a `skills` package that scans the eight directories
in [01](../01-discovery-and-precedence.md), parses each `SKILL.md`
leniently, resolves collisions deterministically, and exposes the result as
a session-guarded read API. Nothing consumes it yet; that is Phase 1's job.

## What already exists

- `backend-go/internal/config/config.go:43` defines `WorkspaceRoot`, the
  single directory tree the file tools may touch. A chat request already
  carries `workspaceRoot` (`internal/api/chat/route.go:52`) from the
  dashboard's project picker (`src/components/chat/project-selector.tsx`,
  `appStore.projectDirectory`) and from `cmd/amiro`'s resolution in the TUI.
  That value is this phase's `<project>`; no new plumbing is needed to
  obtain it.
- `internal/api/httpjson` is the only JSON write path; handlers read the
  caller from `auth.UserFromContext`. `internal/httpserver/router.go` wires
  every route and documents the `ServeMux` wildcard/literal ambiguity that
  forced `/api/mcp/servers/{id}` — the reason this family nests under
  `items`.
- `tests/harness` already gives each test its own `HOME`, workspace and
  backend, which is what makes user-scope discovery testable without
  touching the developer's real `~/.claude`.
- The repo's own `.agents/skills/` (five skills: `ui`, `backend`, `test`,
  `plan`, `implement`) is a real, non-synthetic project-scope fixture.
- Nothing about skills exists in `backend-go/` today. `internal/agent` is a
  different concept (a DB-backed persona) and is left alone until Phase 6.

## Deliverables

### 1. `backend-go/internal/skills/`

- `sources.go` — the eight scan roots as an ordered, exported list
  (`Sources`), each with scope, relative path, and a `Writable` flag. One
  place, because four surfaces and one doc all describe this table.
- `scan.go` — walk each existing root, find subdirectories containing
  `SKILL.md`, apply the depth/count/size bounds, skip `.git`/`node_modules`
  and dot-directories, resolve real paths.
- `parse.go` — frontmatter split, YAML parse with the quoted-scalar retry,
  the lenient rules table from [01](../01-discovery-and-precedence.md),
  diagnostics as return values.
- `resolve.go` — precedence (project over user, then source order), dedup by
  normalised name and by real path, `shadows`/`shadowedBy` bookkeeping.
- `service.go` — `List(ctx, home, project)` and `Get(ctx, home, project, name)`,
  with the in-process cache keyed on `(home, project)` and an
  `Invalidate()` the authoring phase will call.
- Pure Go, no cgo, no new dependency beyond `gopkg.in/yaml.v3`, which the
  test module already uses and the backend can take. Compiles in an untagged
  build.

### 2. `backend-go/internal/api/skills/`

| Item | Covers |
|---|---|
| `handler.go` | `Handler` holding the service; `auth.UserFromContext` for the caller; `httpjson` for every response |
| `route.go` | `GET /api/skills` (optional `?project=<abs>`), `GET /api/skills/items/{name}` |
| Registration | `Handlers.Skills` in `internal/httpserver/router.go`, session-guarded, plus wiring in `internal/appwiring` and every entrypoint (`cmd/server`, `cmd/amiro`) |
| DTO | `name`, `description`, `scope`, `source`, `path`, `writable`, `shadows[]`, `disableModelInvocation`, `resources[]`, plus a top-level `diagnostics[]` and `truncated` |

No database, no migration: skills are files. This is the phase's most
consequential design decision and the reason there are no `0024_*.sql`
files here.

### 3. `src/lib/backend/skills-api.ts`

The typed client, and `src/types/skill.ts` for the shared shape. Added now,
unused until Phase 2, so the palette phase does not also have to invent the
transport. Goes through `apiFetch`/`fetcher` — never a bare `fetch()` on an
`/api/...` path.

### 4. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/skills/` | Empty machine returns an empty list with no error · a skill in each of the eight roots is found · project beats user for the same name · source order breaks a same-scope tie · a symlinked duplicate appears once · a missing `description` is skipped with a reason · an unparseable `SKILL.md` is skipped with a reason · a colon-in-description skill loads via the retry · name/dir mismatch loads with a warning · bounds trip and are reported · `?project=` outside the caller's selection is rejected · unauthenticated request is 401 |
| desktop | `tests/suites/desktop/skills/` | The untagged sidecar build serves `GET /api/skills` and resolves `$HOME` for user scope |
| meta | `tests/suites/meta/` | A guard asserting `skills.Sources` matches the eight-row table documented in `docs/skills/01-discovery-and-precedence.md`, so the doc and the code cannot drift. Route coverage is automatic via `route_coverage_test.go` |

Fixture work: `tests/fixtures/skills/` gets a tree with `.agents`, `.amiro`,
`.claude` and `.codex` skill directories, a symlinked duplicate, a
description-less skill, a malformed-YAML skill and a colon-in-description
skill. The harness plants it into the per-test `HOME` and workspace.

**Deliberately not covered:** a filesystem watcher (there isn't one — the
cache is invalidated explicitly, and Phase 4 tests that); Windows path
semantics beyond the existing `GOOS=windows` compile check, since no Windows
machine runs the suite here; `.gitignore` honouring, which is optional in the
guide and not implemented.

### 5. Docs

`docs/skills/progress/phase-00-discovery.md` and its verification log
(written by `implement`, not now); `tests/README.md`'s suite list.

## Exit criteria

1. `amirotest run --surface backend --feature skills` passes in under 30s.
2. A test asserts that a skill present in **all four** user-scope
   directories appears exactly once in `GET /api/skills`, with
   `source: ".agents"` and three entries in `shadows`.
3. A test asserts a project-scope skill named `code-review` wins over a
   user-scope skill of the same name, and that the user-scope one is
   reported as shadowed rather than dropped silently.
4. A test asserts a skill whose `SKILL.md` has no `description` is absent
   from the list **and** present in `diagnostics` with a reason string.
5. `go test ./suites/meta/... -v` passes, including the new sources-table
   guard, and the guard is proven non-vacuous by a test that fails it on a
   mutated table.
6. `cd backend-go && go build ./... && go build -tags embedui ./...` both
   succeed; `GOOS=windows go build ./...` still succeeds.
7. `amirotest run` is green overall, `suites/meta` included, with every skip
   reasoned.

## Risks

- **The scan is on the request path.** A cold scan of eight roots on a large
  home directory could be slow enough to make the palette feel broken.
  Mitigation: the bounds are hard, the cache is per `(home, project)`, and
  a `slow`-tagged perf test in `suites/backend/perf/` records the budget for
  a 200-skill tree rather than leaving it to be discovered in the UI.
- **`?project=` is attacker-controlled path input.** A caller could point it
  at `/etc`. Mitigation: absolute-path requirement, resolve before use, and
  it only ever *reads* `<dir>/.{agents,amiro,claude,codex}/skills` — the
  same trust level `workspaceRoot` already has for the file tools, which is
  worth stating rather than assuming.
- **`yaml.v3` in the backend is a new dependency for `backend-go`.**
  Mitigation: it is pure Go, already vendored in the test module, and the
  alternative (hand-rolling a YAML subset) fails on the malformed real-world
  files the leniency rules exist for.

## Open questions

None. The eight roots, the precedence order and the writable root were
settled in [`../README.md`](../README.md)'s decisions section.
