# Phase 4 — The authoring API

**Depends on:** 0 · **Blocks:** 5 · **Size:** M

**Surfaces touched:** backend

This phase will let a skill be created, edited and deleted through the API —
inside `~/.agents/skills/` and nowhere else. It adds spec validation on the
write path, atomic writes, the read-only refusal for skills another tool
owns, a duplicate-into-my-skills action, and the `suites/meta/` guard that
keeps the writable root from creeping.

## What already exists

- `internal/skills` (Phase 0) with `Sources` marking exactly one root
  writable, and `Invalidate()` waiting for a caller.
- `internal/api/skills/` with the two read routes and the `items/{name}`
  shape that leaves room for write verbs without a `ServeMux` ambiguity.
- `internal/api/httpjson` for responses; `auth.UserFromContext` for the
  caller. Every existing handler validates in the handler and keeps I/O out
  of it — the shape to follow.
- The spec's own constraints, recorded in
  [`../reference/agent-skills-standard.md`](../reference/agent-skills-standard.md);
  the Amiro-side rules in [`../03-authoring-and-safety.md`](../03-authoring-and-safety.md).
- No skill has ever been written by Amiro, so there is no legacy on-disk
  shape to stay compatible with.

## Deliverables

### 1. Write routes

| Route | Behaviour |
|---|---|
| `POST /api/skills` | Create `~/.agents/skills/<name>/SKILL.md`; 409 if the name already exists in the writable root |
| `PUT /api/skills/items/{name}` | Update; **409 with the owning source named** unless the resolved skill is the writable one |
| `DELETE /api/skills/items/{name}` | Delete the skill directory; same rule; refuses if the directory holds files Amiro did not write unless `force` is set, and says which |
| `POST /api/skills/items/{name}/duplicate` | Copy a read-only skill (including `scripts/`, `references/`, `assets/`) into `~/.agents/skills/`, name-collision-suffixed |

Every one invalidates the discovery cache, so a create is visible to the very
next `GET /api/skills` — the guarantee that replaces a filesystem watcher.

### 2. Validation

- `internal/skills/validate.go`: the name rules (1–64, `[a-z0-9-]`, no
  leading/trailing hyphen, no `--`, equal to the directory), `description`
  1–1024, body ≤1 MiB, frontmatter restricted to the six spec fields plus
  `disable-model-invocation`, unknown keys rejected **with the offending key
  named**.
- Portability warnings, not errors, returned alongside a successful write:
  a name containing `claude`/`anthropic` and a body over ~500 lines both
  upload badly elsewhere but are legal here.
- Errors are field-scoped so a form can attach them to inputs.

### 3. Containment and atomicity

- Resolve the target, resolve the writable root, require containment —
  after symlink resolution, not by string prefix. A `name` of
  `../../.claude/skills/evil` fails containment even if it somehow passed the
  charset check.
- Write to a temp file in the destination directory, `fsync`, rename. Never a
  partially written `SKILL.md`, which would load as corrupt instructions.
- Frontmatter is **serialised, not string-formatted**: a description
  containing a colon must round-trip, since that is the exact malformation
  the reader has a retry for.

### 4. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/skills/` (extended) | Create then list shows it immediately (cache invalidation) · create writes frontmatter `name` equal to the directory name · duplicate name is 409 · every invalid name shape is rejected, including `../` traversal, an absolute path, a symlink target outside the root, uppercase, `--`, 65 chars · over-long description rejected · unknown frontmatter key rejected with the key named · a colon-containing description round-trips through write→read · `PUT` on a `.claude` skill is 409 naming the source · `DELETE` on a `.claude` skill is 409 · duplicate-into-my-skills copies bundled resources and suffixes a collision · an interrupted write leaves no partial file · portability warnings returned for a `claude`-containing name · unauthenticated write is 401 |
| backend | `tests/suites/backend/security/` (extended) | Traversal and symlink-escape as security checks, not just validation cases — they belong in the suite a reviewer reads for that |
| meta | `tests/suites/meta/` | **The writable-root guard**: every filesystem write in `internal/api/skills` and `internal/skills` goes through the single containment-checked helper. AST-parsed, like `route_coverage_test.go`, with a waiver file for a deliberate exception. Proven non-vacuous |

**Deliberately not covered:** concurrent writes to the same skill from two
sessions — last-writer-wins, no locking, no revision field. Stated because
the alternative is pretending an untested contract exists; a follow-up if two
clients ever edit the same skill in practice.

### 5. Docs

`docs/skills/03-authoring-and-safety.md` shipped note; the route table in
`docs/skills/03` and `backend-go`'s route docs.

## Exit criteria

1. `amirotest run --surface backend --feature skills` passes in under 60s.
2. A test asserts `POST /api/skills` then `GET /api/skills` returns the new
   skill in the same test, with no sleep and no cache flush call.
3. A test table asserts **every** invalid name shape is rejected, traversal
   and symlink escape included, and that a rejection never creates a
   directory.
4. A test asserts `PUT` on a skill discovered in `~/.claude/skills/` returns
   409 with `.claude` named in the body, and that the file on disk is
   byte-identical afterwards.
5. A test asserts a description containing a colon survives write→read
   unchanged.
6. `go test ./suites/meta/... -v` passes with the writable-root guard, and a
   mutation test proves the guard fails when a write bypasses the helper.
7. `amirotest run` is green overall, `suites/meta` included, with every skip
   reasoned.

## Risks

- **The containment check is the whole security boundary of this phase.**
  Mitigation: two independent layers (charset + resolved containment), a
  security-suite home for the traversal cases, and a meta guard that fails
  the build when a new write path skips the helper.
- **Deleting a directory Amiro did not fully create** could destroy a user's
  bundled scripts. Mitigation: `DELETE` enumerates unexpected files and
  refuses without `force`, naming them.
- **`$HOME` may not be writable** in a packaged desktop or a sandboxed
  container. Mitigation: a create attempt returns a specific, actionable
  error rather than a generic 500, and a test asserts it with a read-only
  `HOME`.

## Open questions

None.
