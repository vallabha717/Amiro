# 03: Authoring, generation, and safety

Settled here: the API shape, what "writable" means, what a valid skill is,
how "Generate with AI" works, and the failure modes that matter because a
skill is model-facing instructions read off disk.

## API

Route family, following the precedent in `internal/httpserver/router.go`
where every id-scoped MCP operation nests under a literal `servers` segment.
Go's `ServeMux` statically rejects wildcard-then-literal against
literal-then-wildcard at the same position; nesting name-scoped routes under
`items` makes that class of conflict impossible as this family grows:

| Route | Guard | Does |
|---|---|---|
| `GET /api/skills` | session | List, deduped, with `source`, `scope`, `path`, `shadows`, diagnostics. Optional `?project=<abs>` adds project scope |
| `POST /api/skills` | session | Create under `~/.agents/skills/<name>/SKILL.md` |
| `GET /api/skills/items/{name}` | session | One skill: frontmatter, body, resource listing, `writable` |
| `PUT /api/skills/items/{name}` | session | Update: **409 unless the resolved skill is the writable one** |
| `DELETE /api/skills/items/{name}` | session | Delete: same rule |
| `POST /api/skills/generate` | session | Streaming object: a drafted skill. Writes nothing |

All session-guarded, all reached through `src/lib/backend/skills-api.ts` on
the frontend (never a bare `fetch()` on an `/api/...` path; the static
export has no server to serve one). `GET /api/skills` is the only route the
`/` palette needs.

## Writable means exactly one directory

`~/.agents/skills/`. Everything else in the eight-row discovery table is
read-only, and the API says so per skill (`writable: false`) rather than
letting the UI infer it from the path.

- The editor opens a read-only skill with its source labelled ("managed by
  Claude Code") and a **Duplicate to my skills** action that copies it into
  `~/.agents/skills/`: the escape hatch, so read-only is not a dead end.
- Enforcement is a resolved-path check, not a string prefix check: resolve
  the target, resolve the writable root, require containment. A `name` of
  `../../.claude/skills/evil` must fail that check, not merely fail a
  regex.
- A `suites/meta/` guard asserts that every write path in
  `internal/api/skills` resolves under the writable root. This is the
  contract most likely to erode as the package grows.

## Validation

Enforced on write, per the spec: stricter than the lenient reader in
[01](01-discovery-and-precedence.md), because Amiro authors these:

| Field | Rule |
|---|---|
| `name` | 1–64 chars, `[a-z0-9-]`, no leading/trailing hyphen, no `--`, equals the directory name |
| `description` | 1–1024 chars, non-empty |
| body | ≤ 1 MiB; a warning (not a rejection) over ~500 lines, per the spec's own guidance |
| frontmatter | only the six spec fields plus `disable-model-invocation`; anything else is rejected with the offending key named |

Two portability notes worth surfacing in the form as hints rather than
hard errors, because they are other products' rules and not the spec's:
the Claude API and claude.ai reject a `name` containing `anthropic` or
`claude`, and reject any non-spec frontmatter key outright. A skill Amiro
writes should upload cleanly to both.

Writes are atomic: temp file in the target directory, `fsync`, rename. A
half-written `SKILL.md` is a skill that loads with corrupt instructions,
which is worse than one that does not load.

## Generate with AI

Mirrors the mechanism `generate-agent-dialog.tsx` already uses: the one
piece of the Agents UI that transfers almost unchanged. `experimental_useObject`
against a streaming object endpoint, with the schema shared between
`src/types/skill.ts` and the Go handler:

```
{ name: string, description: string, body: string }
```

- The model **drafts**; it never writes. The dialog fills the editor form,
  the user reviews, and the ordinary `POST /api/skills` does the write.
  There is no path from a generation to a file on disk that skips the
  validator.
- The prompt tells the model the spec: the name charset, the
  "what it does *and* when to use it" requirement for `description`
  (the single field discovery quality depends on), and the progressive-
  disclosure shape: a body under ~500 lines that pushes exhaustive detail
  into `references/`.
- Validation runs on the generated object before it reaches the form, so an
  invalid generated name surfaces as a field error rather than a 400 on save.
- Tested against the harness's fake provider, so no key and no network.

## Safety

The threat is not exotic: a `SKILL.md` is instructions that go to a model,
and project-scoped ones come from whatever repository is open.

| Risk | Mitigation |
|---|---|
| **Prompt injection from a project skill** | Project scope is limited to the directory the user explicitly selected in the picker. Skill bodies are wrapped in `<skill_content>` tags so they are identifiable as data, never spliced anonymously into the system prompt. The catalog shows the user what is loaded, and the UI labels each skill's source |
| **Path traversal on `name`** | Charset validation *and* a resolved-containment check. Both, because either alone has been enough to fail elsewhere |
| **Symlink escape** | Resolve real paths before the containment check; a symlink out of the writable root fails the write and loads once on read |
| **Runaway scan** | Depth/count/size bounds from [01](01-discovery-and-precedence.md), every trip reported |
| **Secrets in a skill body** | Skill text flows into artifacts and logs. It goes through the existing `harness/logging/redact.go` path on the test side and the backend's existing redaction on the product side: a skill body is never written to a log verbatim |
| **A skill claiming tools it should not have** | `allowed-tools` is parsed and **not honoured** in v1. Recorded as a non-goal, not silently half-implemented: a field that looks like it grants permissions and does nothing is worse than an absent one |
