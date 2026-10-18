# Settings UI simplification

This document describes the four settings areas simplified on 2026-10-18 and the
verification that accompanies them. It is written against the current source, not
against a design mock.

The four areas are:

- **Credentials** at `/admin/credentials`
- **Workspace** at `/agent/workspace`
- **Memory** at `/agent/memory`
- **Superpowers** at `/agent/superpowers`

The changes landed in:

| Commit | Area |
| --- | --- |
| `f2cb536` | Credentials redesign |
| `d95ac17` | Workspace polish |
| `24a40a8` | Memory list-first view |
| `854cf84` | Superpowers compact skill list |
| `5ea3dc7` | Settings verification scripts |

## Shared direction

Each page now leads with the thing the user came to manage. Architecture notes,
raw counters, root paths, and secondary metadata move behind a native
`<details>` disclosure. Decorative canvases are removed from the default view.
Read-only boundaries are exposed as real UI state instead of faux edit or create
affordances.

Native `<details>` is used for secondary information because it keeps keyboard
and screen-reader behavior without adding a custom disclosure widget. The pages
honor reduced motion in their transition paths.

## Credentials

Source: `src/app/(chat)/(admin)/admin/credentials/page.tsx`,
`credentials-view.tsx`, and `credentials-view-utils.ts`.

### Page structure

The page has a short header with the title, a one-line description, a refresh
icon button, and an **Add credential** button. The former upfront security
architecture card is gone. The explanation now sits in a collapsed
**How agents use credentials** `<details>` element.

When credentials exist, a compact search field filters the visible rows and
shows `N of M`. Rows show:

- a key icon and a label, or `service/field` when no label exists
- the backend-provided masked hint, for example `••••1234`
- the generated environment variable name with a copy action
- allowed domains when configured
- agent guidance when configured

The secret is never rendered. `CredentialRow` only accepts
`CredentialMetadata`. The masked hint is produced by the backend.

### Search and validation

`filterCredentials` is case-insensitive and trims the query. It matches across:

- service
- field
- `service/field`
- label
- usage description
- masked hint
- environment variable name
- allowed domains

A blank query returns every credential. A no-match state offers **Clear search**.

`validateCredentialDraft` requires a service, a field, and a secret value.
The service, field, and secret inputs are also HTML-required in the form.

### Add form and optional fields

The add dialog includes quick-start presets, required service and field inputs,
and a password-type secret input with an explicit show/hide control. A native
`<details>` labeled **Optional details** contains:

- label
- agent guidance
- allowed domains
- a live preview of the generated `$AMIRO_CRED_<SERVICE>_<FIELD>` environment
  variable

Keeping these fields collapsed makes the common add flow three fields, while
still exposing broker policy when it is needed.

### Vault and masking boundary

Source: `backend/src/credentials.rs`.

- The vault uses AES-256-GCM.
- A 32-byte master key is generated atomically on first use.
- The encrypted store keeps a nonce and ciphertext, both base64 encoded.
- The associated data is `service/field`, so a ciphertext copied to another slot
  fails authentication.
- `GET /api/credentials` returns metadata only. To build the last-four hint the
  backend decrypts server-side and returns `masked_hint` output. Plaintext is
  never part of the response.
- Decryption failures are reported as missing, tampered, or wrong-key data.
- The master key is held in a zeroizing wrapper.

The relevant public routes are `GET` and `PUT /api/credentials`,
`DELETE /api/credentials/{service}/{field}`, `POST /api/credentials/validate`,
and `POST /api/credentials/broker`.

### Delete

Delete uses an accessible `AlertDialog`, not `window.confirm`. The dialog names
the `service/field` that will be removed and states that agents lose access
immediately. Cancel closes the dialog and preserves the credential. Confirm
calls the real delete route. The row action is disabled while a delete is in
flight.

## Workspace

Source: `src/components/agent/agent-workspace-view.tsx` and the workspace routes
in `backend/src/agent.rs`.

### Page structure

The page uses a short header with a **Read-only preview** badge and the line
"Browse your agent files. Memory lives in its own view." The old duplicate quick
jumps and mixed memory affordances are removed.

The left pane contains root selection, a filename filter, and sort controls for
name or size. The right pane shows the selected file with formatted or source
view where available, a copy action, and the file preview.

Technical root metadata is behind **Root details**. Technical file metadata is
behind **File details**. Both are native `<details>` elements.

### Roots

The backend exposes exactly three roots:

| Root | Purpose |
| --- | --- |
| Runtime | Runtime files |
| Persona | The current user's agent identity and personality files |
| Project | Files in the current project |

The API returns only root id, label, description, and `allowlisted`. Host paths
stay on the server.

### Read-only boundary

The native backend is permanently display-only:

- listings return `readOnly: true`
- files return `writable: false` and `readOnly: true`
- `PUT /api/agent/workspace/file` returns `501 Not Implemented`

The UI derives `readOnly` from the response and only offers edit/save when the
file is writable, the file is not read-only, and the listing is not read-only.
Because those conditions never hold against the native backend, no edit or save
button is shown. Permission and save errors still surface if a future backend
changes the boundary.

### Path and secret protection

`resolve_contained_workspace_path` applies an allowlist, lexical traversal
checks, realpath containment, and a second allowlist check against the resolved
path. Symlink escapes are rejected.

The workspace blocklist rejects sensitive names and extensions, including env
files, key and PEM files, sockets, session stores, auth files, `users.json`,
`credentials.json`, and private tool directories. Project-root browsing is broad
but still passes through that blocklist.

Runtime `config.toml` is readable but redacted on the way out. Assignments whose
key contains key, token, secret, password, credential, auth, or passwd are
masked, as are values that look like known provider API key prefixes. The
workspace payload therefore does not leak inline provider credentials.

## Memory

Source: `src/components/agent/agent-memory-view.tsx` and the memory routes in
`backend/src/agent.rs`.

### Default map and memory cards

Memory opens in **Map**. The map replaces the anonymous rotating 3D dots with
readable memory previews grouped by actual category. Category headings explain
what facts, preferences, entities, and corrections mean. Selecting a memory
opens its full detail. Pan, zoom, fit, and neighborhood focus help explore a
larger collection without confusing the overview with individual memories.

Relationships are not invented semantic conclusions. Solid lines represent
runtime links. Shared-tag relationships are visually distinguished and labeled
as tag matches. Category grouping alone does not imply a relationship. Large
maps disclose the number shown: 20 category-balanced previews initially, expanding
to 60. Search and category filters operate on the whole collection, and Cards
can page through every result. A category jump rail stays available on mobile,
while the desktop has a mini overview. **How to read this map** and the accessible
memory list are disclosures, not duplicate upfront card walls.

**Cards** remains a plain toggle available on desktop and mobile. Its responsive
grid gives the memory text more room, with category, scope, relative update time,
a superseded marker, compact tags, and relationship counts. Search plus scope,
category, and recency filters apply to both views, with a live `N of M memories`
count. Technical metrics stay in the detail disclosure.

Design references: [Vellum's public product page](https://www.vellum.ai/product)
for personal-memory clarity and [KeyLines' public graph exploration overview](https://cambridge-intelligence.com/keylines/)
for grouping, decluttering, and focused exploration. These are design references,
not added dependencies or a claim of reproducing Vellum's authenticated memory UI.
Memory data stays in the existing Amiro API workflow.

### Pagination and detail

`LIST_PAGE_SIZE` is 24. Cards shows the first 24 matches and a **Show 24
more** button while matches remain. The settings workflow switches from Map to
Cards before testing its 35-memory pagination fixture.

`node scripts/verify-memory-map.mjs` runs the built Rust API and production export
with an isolated home/runtime, never production memories. Its fixture contains
85 entries, of which the read-only API exposes 84 active entries. On 2026-10-18
it passed at 1440px and 390px: Map default, 20-to-60 bounded previews, category
jump, pointer pan without accidental selection, zoom/fit, search beyond the
initial map window, full detail/Escape, retained neighborhood focus, no-match
state, Cards 24-to-48 pagination, map remount, light/dark, and no page overflow
or JavaScript errors. This checks real UI/API behavior using synthetic memory
content, not external-provider or memory-write functionality.

Selecting a memory opens a detail panel with `role="dialog"` and the accessible
name **Memory detail**. The panel shows content, category, scope, tags, created
and updated times, and linked memories. Focus moves into the panel and returns to
the trigger on close. Reduced motion removes the slide transition.

Trust, confidence, strength, reinforcement count, recall count, source session,
memory id, and the scope path are behind a **Technical details** `<details>`.
The main detail view stays readable without them.

### Read-only behavior

`GET /api/agent/memory` is admin-gated and returns `readOnly: true`. The mutation
routes return `501 Not Implemented`:

- `POST /api/agent/memory`
- `POST /api/agent/memory/{id}/reinforce`
- `DELETE /api/agent/memory/{id}`

The native UI treats memory as read-only unless the backend explicitly says
otherwise. It hides create, reinforce, and forget actions when read-only and
shows a read-only badge instead. The legacy writable path remains behind
confirmation dialogs for a backend that allows it.

## Superpowers

Source: `src/components/skill/skills-list.tsx`.

### Page structure

The decorative constellation canvas, the three-way view picker, the giant create
card, redundant count bars, and repeated section chrome are removed. The page is
one searchable compact grid.

Each card shows the skill name, a short description, source and scope, and the
available actions. Search matches name, description, and source. Filters are
**all**, **builtin**, **custom**, and **project**, implemented as buttons with
`aria-pressed` rather than fake tabs.

The list preserves the create flow, loading skeletons, an error state with retry,
and a calm empty state when the runtime has zero skills.

### Actions and permissions

Skill permissions are expressed per row:

- A built-in `.amiro` skill is read-only: the card shows a lock and a
  **Duplicate** action to create an editable copy.
- A writable skill is labeled editable and its source details remain available.
- **Open** navigates to the skill editor or detail route and has a per-skill
  accessible name, for example `Open clarity-skill`.
- **Use** adds the skill mention to the current thread, or stores it as a
  pending mention when no thread exists.
- **Use** is disabled when `deliverable === false` or
  `disableModelInvocation` is set, with the runtime-provided reason in the title.

The primary action styling uses the shared button foreground/background tokens
rather than hard-coded accent colors, so it stays readable across themes.

## Verification

### Unit tests

Run the settings component tests:

```bash
./node_modules/.bin/vitest run \
  'src/app/(chat)/(admin)/admin/credentials/page.test.tsx' \
  src/components/agent/agent-workspace-polish.test.ts \
  src/components/agent/agent-memory-view.test.ts \
  src/components/skill/skills-list.test.tsx
```

These cover credential filtering, validation, masked row metadata, delete
in-flight behavior, collapsed architecture details, the short header, workspace
read-only and privacy invariants, memory pagination, detail focus restoration,
reduced motion, read-only gating, skill search, filters, lock/duplicate behavior,
and disabled Use conditions.

### Isolated browser workflows

```bash
node scripts/verify-settings-workflows.mjs
```

This script:

- creates a temporary `AMIRO_HOME` and runtime home
- writes 35 synthetic memories and a small runtime `config.toml`
- starts the built `backend/target/debug/amiro-backend`
- uses the built `runtime/target/debug/amiro-runtime`
- creates a fixture owner and logs in through the real auth route
- drives Chromium with Playwright

It verifies, through the real local backend and browser:

- credential creation, masking, encrypted-vault persistence, reload, cancel, and
  confirmed deletion
- that the secret is absent from the page text and from the public credential
  response
- workspace file preview matches the public file API content
- workspace `readOnly: true`, no edit button, and `PUT` returning `501`
- workspace filtering
- memory starts at 24 rows, loads to 35, opens the detail dialog with focus
  inside and closes it with Escape, and finds an entry beyond the first page
- skill creation, search, and opening the real skill editor

It needs Playwright Chromium, the two debug binaries, and no external provider.
It does not use a real model or a third-party credential service.

### Live clarity check

```bash
AMIRO_TEST_URL=http://127.0.0.1:3000 \
node scripts/verify-settings-clarity.mjs
```

`scripts/verify-settings-clarity.mjs` uses an existing private admin session. It
reads `AMIRO_TEST_TOKEN` when supplied, otherwise it checks existing sessions in
the user's Amiro session store for an admin token. It never prints the token.

It checks that `/api/credentials`, `/api/agent/workspace`, `/api/agent/memory`,
and `/api/skills` answer `200` for the authenticated admin. It then opens each
settings page at 1440px and 390px with reduced motion, checks for browser errors
and horizontal overflow in the `after` phase, and writes screenshots plus an
`observations.json` under `$JCODE_SCRATCH_DIR` or the user's home directory.

The same script checks that the credentials architecture card is not visible,
that the add dialog opens and closes with Escape, that memory and superpowers do
not start with their canvases, that a no-match memory query can be entered and
cleared, and that superpowers search filters real rows to zero and restores them
when cleared.

### Limitations

- `verify-settings-workflows.mjs` is an isolated local acceptance test, not a
  production or external-provider test. Its credential is synthetic. Its memory
  graph is synthetic. Its skills are local fixture data.
- `verify-settings-clarity.mjs` is intentionally non-hermetic. It depends on a
  running app and an existing admin session. It observes the live instance and
  may differ with existing data.
- The scripts assume Playwright is installed and the backend and runtime debug
  binaries are built.
- The unit tests assert component source and DOM behavior. They do not replace
  the browser workflows.
- No external credential provider, model provider, or multi-owner deployment is
  exercised by these commands.
