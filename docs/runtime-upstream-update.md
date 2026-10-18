# Updating the embedded Jcode runtime safely

This is the authoritative agent runbook for updating Amiro's vendored runtime. Invoke the repository skill [`amiro-runtime-update`](../.agents/skills/amiro-runtime-update/SKILL.md), then follow this entire document. **This runbook does not perform an update automatically.** It defines the required inputs, preservation rules, staging procedure and acceptance evidence.

No process can promise that every upstream change is conflict-free. The safety rule is stricter: **an unresolved conflict, missing baseline, untested compatibility boundary or failed required test prevents release.** Never make a check green by deleting it or silently weakening its assertion.

See [runtime-update-validation.md](runtime-update-validation.md) for the commands and public skill-discovery path actually checked while authoring this procedure, including the unexecuted full-update boundaries.

## 1. Scope and current facts

| Item | Current source of truth |
| --- | --- |
| Upstream | `https://github.com/1jehuang/jcode` |
| Recorded upstream commit | `runtime/PROVENANCE.md`, currently `11952e02ac76fa1c335633e9c6113691c1cf3395` |
| Recorded upstream version | `runtime/PROVENANCE.md`, currently `0.98.1` |
| Amiro initial vendor commit | `de88011ca23601a7af49241c2e69e459d680191d` |
| Later branding commit | `4a1b9f81692725f378205c46287f49fe186376ca` |
| Current runtime | Tracked `runtime/` tree at the chosen clean Amiro revision, including all subsequent Amiro patches |
| SDK consumers | Path dependencies in `backend/Cargo.toml`: `amiro-sdk`, `amiro-config-types`, `amiro-session-types` |
| Actual runtime binary | Built `runtime/target/debug/amiro-runtime`, or a release artifact explicitly selected for deployment |
| Upstream update policy | Default off. Keep `AMIRO_ALLOW_UPSTREAM_UPDATE` unset |
| Upstream telemetry policy | Default off. Keep `AMIRO_ALLOW_UPSTREAM_TELEMETRY` unset |

`--version` reports the enclosing Amiro build's Git metadata, not necessarily the vendored upstream SHA. Use provenance to identify the upstream base.

This is a copied, renamed source tree, **not** a Git submodule or an existing `git subtree` import. Do not run `git subtree pull`, rebase all of Amiro onto Jcode, or copy upstream `runtime/` over the live tree. There is currently no verified automatic rebrand/import program in this repository.

### Authorized operations

Separate these permissions:

1. **Prepare and verify an update:** clone source, fetch the explicitly approved upstream repository/revision, author code and run isolated tests.
2. **Integrate an accepted candidate:** merge the reviewed Amiro update branch into the application repository without rewriting shared history.
3. **Deploy or roll back:** stop production processes, switch artifacts or restore state. Requires explicit operator approval and a maintenance window.

Preparing a candidate never authorizes touching production homes, replacing binaries, connecting real accounts, submitting paid model calls or enabling upstream services.

## 2. Required update inputs and STOP conditions

Before fetching or editing, record an update ticket containing:

- `AMIRO_BASE`: full commit SHA of the clean application revision to update.
- `UPSTREAM_OLD`: full upstream SHA recorded by `runtime/PROVENANCE.md` at that revision.
- `UPSTREAM_NEW`: an explicitly selected full upstream SHA. A branch name such as `main` is not a release pin.
- Why this revision is needed, upstream changes of interest and security advisories.
- Target operating systems, architectures and production build features.
- Which operator may approve integration/deployment and whether real provider tests are authorized.
- Location of a private update workspace and private evidence directory.

**STOP** if any of these holds:

- The shared workspace has uncommitted owner changes needed for the update. Coordinate with their owners. Never stash, discard, stage or commit somebody else's work.
- The old upstream SHA cannot be found in the approved repository, or provenance is inconsistent.
- The rebrand/path/exclusion mapping cannot reproduce the old baseline and account for its intentional local delta.
- A merge has unresolved conflicts, missing files, changed service identities or unexplained deletions.
- API/SDK, storage, auth, tool policy, telemetry, native search or MCP checks fail.
- An important migration or external-provider change has no authorized representative acceptance result.
- The production backup/rollback prerequisites are incomplete. This blocks deployment, not preparation.

A stopped run must report the exact blocker, evidence and last safe phase. It must not claim an update was completed.

## 3. Preserve an explicit local-delta inventory

Before import, review [`runtime-customizations.json`](runtime-customizations.json) and refresh it against the selected clean revision. It is an inventory, not an automatically applied patch set. Record every additional local runtime change since the previous accepted update, including untracked changes that an owner intends to commit later. Those later changes are outside this candidate until integrated deliberately.

Required preservation areas:

| Boundary | Preserve and prove |
| --- | --- |
| Branding and build | `amiro-runtime` executable, `amiro_runtime` library, `amiro-*` crates, valid path dependencies, build-time document/assets inputs |
| Legal/service identities | Verbatim upstream MIT notice, real upstream URLs, subscription provider IDs, release asset identities, wire identifiers intentionally kept upstream |
| Updater and telemetry | Default-deny gates and their call sites. No new ungated self-install, telemetry, discovery or transcript-upload path |
| Storage and homes | Backend app home versus runtime home, compatibility home environment names, provider credential layout, session/memory serialization and sockets |
| Search | Configured-only registry/schema, native selected-default gate, configured local fallbacks, unknown/empty/invalid fail-closed behavior, private registry |
| Conversation and SDK | Multi-segment stream ordering, reasoning/tool history, SDK event/command shapes, tool-result continuation and effective session titles |
| Titles | Shared no-inference `prompt_title`, effective metadata precedence, manual names and deleted/stale-session ownership guards |
| MCP | `McpReload` wire behavior, connection lifecycle and eager-tool cap. Preserve additional committed MCP changes found during inventory |
| Product policy | Owner auth/tool exposure and scheduled tool restrictions in the backend, credential environment/broker boundaries, provider selection and working directory checks |

Keep product-only behavior in `backend/`, `src/` or configuration where the upstream SDK supports it. Upstream general-purpose fixes when practical, but do not remove an Amiro patch until its replacement behavior is proven. A smaller maintained local delta makes future imports safer.

## 4. Isolate source and build outputs

Use a separate clone for an upstream update. This is an intentional exception to normal shared-workspace development: import/rebrand/merge changes require isolation. Do not reuse production `out/`, build directories, sockets or homes.

The following commands target the current Linux VM and assume Bash, Git, rsync, tar, GNU `realpath`, Cargo, Node and pnpm. macOS/Windows require reviewed equivalent path/copy commands and their own acceptance. Set these shell variables to the approved values before running:

```bash
set -euo pipefail
: "${AMIRO_SOURCE:?absolute path to the existing Amiro checkout}"
: "${AMIRO_BASE:?approved full Amiro commit SHA}"
: "${UPSTREAM_NEW:?approved full upstream commit SHA}"
: "${UPDATE_ROOT:?new absolute private update directory outside AMIRO_SOURCE}"
[[ "$AMIRO_BASE" =~ ^[0-9a-f]{40}$ ]]
[[ "$UPSTREAM_NEW" =~ ^[0-9a-f]{40}$ ]]
for tool in git rsync tar realpath cargo node pnpm; do command -v "$tool" >/dev/null; done
[[ "$UPDATE_ROOT" == /* && ! -e "$UPDATE_ROOT" ]]
AMIRO_SOURCE="$(realpath "$AMIRO_SOURCE")"
UPDATE_ROOT="$(realpath -m "$UPDATE_ROOT")"
case "$UPDATE_ROOT/" in "$AMIRO_SOURCE/"*) echo "STOP: update directory is inside source checkout" >&2; exit 1 ;; esac
mkdir -m 700 "$UPDATE_ROOT"
mkdir -m 700 "$UPDATE_ROOT/evidence" "$UPDATE_ROOT/scratch"
git -C "$AMIRO_SOURCE" cat-file -e "$AMIRO_BASE^{commit}"
git clone --no-hardlinks "$AMIRO_SOURCE" "$UPDATE_ROOT/amiro"
git -C "$UPDATE_ROOT/amiro" switch --detach "$AMIRO_BASE"
git -C "$UPDATE_ROOT/amiro" switch -c "runtime-update/${UPSTREAM_NEW:0:12}"
export JCODE_SCRATCH_DIR="$UPDATE_ROOT/scratch"
export CARGO_BUILD_JOBS=1
unset AMIRO_ALLOW_UPSTREAM_UPDATE AMIRO_ALLOW_UPSTREAM_TELEMETRY
```

A local clone's `origin` points to the original checkout. Do not push to it. Integration is a later reviewed step. Run source preparation only against committed data. If owners are still working, choose a stable commit and disclose which work is excluded.

After repository/source-sharing authorization, obtain the upstream history in a separate directory:

```bash
git clone https://github.com/1jehuang/jcode.git "$UPDATE_ROOT/upstream"
git -C "$UPDATE_ROOT/upstream" cat-file -e "$UPSTREAM_NEW^{commit}"
git -C "$UPDATE_ROOT/upstream" show --no-patch --format=fuller "$UPSTREAM_NEW" \
  > "$UPDATE_ROOT/evidence/upstream-new.txt"
```

Read `UPSTREAM_OLD` from the candidate's provenance. Do not hardcode the old SHA into later update runs. Verify it with `git cat-file -e`, then inspect upstream log/diff between the two full revisions, including dependency lockfiles, feature defaults, CLI, SDK, storage, auth and update/telemetry code. Do not require the new SHA to be a descendant unless that is part of the approved target policy, but flag divergent history for explicit review.

## 5. Bootstrap a reproducible normalized upstream baseline

**This phase is mandatory and is not already automated.** An agent must not invent a call to a nonexistent importer or assume a global string replacement is correct.

Produce three tracked-source snapshots, with no build output or `.git` directories:

| Directory | Required content |
| --- | --- |
| `$UPDATE_ROOT/old-normalized` | Exact old upstream snapshot after the audited vendoring exclusions and structural rebrand transform, before Amiro behavioral patches |
| `$UPDATE_ROOT/current-runtime` | Exact tracked `runtime/` snapshot from `AMIRO_BASE` |
| `$UPDATE_ROOT/new-normalized` | Exact new upstream snapshot after the **same versioned** audited transform, extended for new upstream paths only through reviewed mapping changes |

The transformer must have a versioned path mapping and content exceptions. Follow `runtime/PROVENANCE.md` for vendored/excluded build inputs. Preserve legal text, real service URLs, subscription IDs and credential/wire identities. Do not blindly replace every `jcode`, `Jcode` or `JCODE` occurrence. New upstream crates, assets and `include_*`/build-script inputs require explicit classification. Do not retain the old "88 crates" count as an invariant.

Recommended bootstrap procedure:

1. Export the original old upstream and original Amiro vendor commit into private directories.
2. Reconstruct an audited deterministic transformation from those trees. Separate renames/branding/exclusions from `fork_policy` and other behavioral additions.
3. Compare its old-normalized output to the initial vendor tree. Every difference must be classified as an intentional local delta or a transform defect, with path and explanation. If that comparison cannot be completed, **STOP before merging**.
4. Capture all later `runtime/` changes from the vendor commit through `AMIRO_BASE`. Review their interaction with the initial local delta. The current runtime snapshot is authoritative for preserving the total local delta, not a few remembered commits.
5. Check in the transformer, mapping, test fixtures and baseline comparison report on the update branch before using it on new upstream. Re-run it twice and compare tree/content hashes to prove determinism.
6. Confirm that transforming `UPSTREAM_OLD` again reproduces the recorded old-normalized hash and that applying the complete reviewed old-to-current delta yields the tracked current runtime hash exactly.

If the target upstream introduces incompatible architecture, a reviewed manual port may be necessary. Keep the same preservation and acceptance ledger. Do not call a manual rewrite an automated successful rebase.

A safe current-runtime export from the isolated Amiro clone is:

```bash
mkdir "$UPDATE_ROOT/current-export"
git -C "$UPDATE_ROOT/amiro" archive "$AMIRO_BASE" runtime \
  | tar -x -C "$UPDATE_ROOT/current-export"
mv "$UPDATE_ROOT/current-export/runtime" "$UPDATE_ROOT/current-runtime"
```

## 6. Three-way merge normalized trees, not application history

Only enter this phase after the three snapshots and hashes are accepted. Use a disposable Git repository to give the normalized old tree a real common ancestor. This procedure preserves the complete old-to-current local delta while merging the old-to-new upstream delta.

```bash
: "${UPDATE_ROOT:?}"
for tree in old-normalized current-runtime new-normalized; do
  test -d "$UPDATE_ROOT/$tree"
  test ! -e "$UPDATE_ROOT/$tree/.git"
  test ! -e "$UPDATE_ROOT/$tree/target"
done
mkdir "$UPDATE_ROOT/merge"
git -C "$UPDATE_ROOT/merge" init --initial-branch=baseline
git -C "$UPDATE_ROOT/merge" config user.name "Amiro runtime update"
git -C "$UPDATE_ROOT/merge" config user.email "runtime-update@amiro.invalid"
cp -a "$UPDATE_ROOT/old-normalized/." "$UPDATE_ROOT/merge/"
git -C "$UPDATE_ROOT/merge" add -A
git -C "$UPDATE_ROOT/merge" -c core.hooksPath=/dev/null commit -m "Normalized old upstream baseline"
git -C "$UPDATE_ROOT/merge" switch -c amiro-local
# --delete is confined to this disposable snapshot repo and never deletes .git.
rsync -a --delete --exclude=.git "$UPDATE_ROOT/current-runtime/" "$UPDATE_ROOT/merge/"
git -C "$UPDATE_ROOT/merge" add -A
git -C "$UPDATE_ROOT/merge" -c core.hooksPath=/dev/null commit --allow-empty -m "Complete Amiro runtime local delta"
git -C "$UPDATE_ROOT/merge" switch -c upstream-new baseline
rsync -a --delete --exclude=.git "$UPDATE_ROOT/new-normalized/" "$UPDATE_ROOT/merge/"
git -C "$UPDATE_ROOT/merge" add -A
git -C "$UPDATE_ROOT/merge" -c core.hooksPath=/dev/null commit --allow-empty -m "Normalized new upstream snapshot"
git -C "$UPDATE_ROOT/merge" switch amiro-local
if git -C "$UPDATE_ROOT/merge" merge --no-ff --no-commit upstream-new; then
  echo "Merge staged. Review before committing."
else
  merge_status=$?
  echo "STOP: merge requires review (exit $merge_status). No source copied or deployed." >&2
  exit "$merge_status"
fi
```

A nonzero merge exit is a **review stop**, not permission to choose all `--ours` or `--theirs`. The update agent must inspect each conflict against upstream changes and the preservation ledger. It may resolve a conflict only when the resulting behavior and its regression test are understood. Check `git ls-files -u` is empty, scan resolved files for conflict markers, and inspect a full diff before committing the temporary merge. No force-push or shared-history rewrite is involved.

After review, copy only the merged runtime tracked sources into the isolated Amiro update branch. That clone must contain no needed files under `runtime/target/` yet. Review every deletion. Then update `runtime/PROVENANCE.md`, customization inventory and the transformer version/hash report. The merge includes Amiro's old provenance file, which must be corrected to the new upstream SHA and import scope rather than left stale.

Commit the runtime import separately from backend compatibility changes. If upstream changed SDK APIs, adapt backend code in a subsequent focused commit with matching tests. Update both lockfiles only through Cargo resolution, record why they changed, then use `--locked` for acceptance. Do not silently mass-update unrelated dependencies.

## 7. Mandatory automated checks

Run from the isolated Amiro root. Store command, source SHA, exit code and full log in the private evidence directory. Do not run multiple heavy Rust builds in parallel on the shared VM. Unset production home/socket/provider variables or give every process explicit isolated values. Real credentials must never be copied into a fixture home.

### A. Source and preservation

```bash
node scripts/verify-runtime-update-contract.mjs
# A missing test/sentinel after upstream restructuring must be ported and reviewed,
# not removed from the inventory merely to pass this check.
git diff --check
```

The contract checker verifies the runbook/skill/inventory and baseline sentinel locations. It is a structural guard, **not** a proof that all behavioral patches survived. Update path sentinels only with reviewed equivalent code and tests.

### B. Runtime and SDK

```bash
CARGO_BUILD_JOBS=1 cargo check --locked --manifest-path runtime/Cargo.toml \
  --no-default-features --bin amiro-runtime
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path runtime/Cargo.toml \
  -p amiro-build-meta -p amiro-config-types -p amiro-session-types \
  -p amiro-message-types -p amiro-harness-api -p amiro-sdk -p amiro-storage
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path runtime/Cargo.toml \
  -p amiro-app-core --no-default-features
```

If a package is renamed or a test has an upstream dependency on an unavailable external service, record the exact failure. Replace a command only with a reviewed equivalent, not a smaller unrelated subset. Ignored external tests remain unexecuted until explicitly authorized. Build/test additional production features and target architectures separately, including `pdf`/`bedrock` if the actual shipped runtime enables them. No-default-features Linux checks do not validate those capabilities or other operating systems.

### C. Backend, frontend and paired build

```bash
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path backend/Cargo.toml
pnpm install --frozen-lockfile
pnpm check-types
pnpm lint
pnpm test
NODE_OPTIONS=--max-old-space-size=4096 pnpm build
CARGO_BUILD_JOBS=1 bash scripts/build-native.sh --debug
```

`pnpm lint` reports current lint debt, it does not fix it. Pre-existing failures must be captured on the old clean baseline and explicitly reviewed. Do not declare the candidate fully green if this command fails. Do not run `pnpm check` or blanket `lint:fix` because they rewrite unrelated files. A build must include the backend and runtime from the **same candidate**. The static export must also come from that candidate. In `--stage` output, `build-native.sh` names the runtime executable `amiro`, not `amiro-runtime`.

### D. Existing isolated public-interface browser acceptance

```bash
node scripts/verify-search-runtime.mjs
node scripts/verify-runtime-titles.mjs
node scripts/verify-settings-workflows.mjs
```

These scripts use built debug binaries and local fixture data. The titles/settings scripts resolve the binaries in `backend/target/debug` and `runtime/target/debug` and serve the candidate's `out/`. Search supports `AMIRO_RUNTIME_BIN`; unset any production override unless deliberately set to the candidate binary. Install Playwright Chromium if missing. Each script must finish and leave no owned backend/runtime fixture processes running. Do not kill unrelated user processes.

Required observations:

- Configured search default and fallback work, unknown/empty registry fails closed, schema exposes no secrets.
- A real browser chat through candidate backend/runtime persists the runtime title, preserves manual names and makes no cosmetic title request.
- Browser vault create/list/reload and cancel/confirm deletion work with masked public metadata.
- Workspace preview and memory data use the correct isolated homes, maintain read-only policy, pagination/search/detail behavior and skill navigation.

### E. Candidate staging and non-fixture acceptance

The fixture tests above are necessary but do not replace a candidate deployment check. Start the paired candidate against a **separate authorized staging account and staging data**, not production sessions, sockets or homes. Use a private temporary listening port. The frontend and API must be served by the candidate Rust backend, not `next dev` or a static-only file server.

Run the documented live check with the staging URL and a private staging token supplied through environment without logging it:

```bash
: "${STAGING_URL:?explicit staging backend URL}"
: "${AMIRO_TEST_TOKEN:?private authenticated staging admin token}"
AMIRO_TEST_URL="$STAGING_URL" node scripts/verify-settings-clarity.mjs
```

Do not use the check's fallback reader of production `~/.amiro/sessions.json` for a staging test. Staging auth/login and `GET /api/auth/session` must first prove the token belongs to this staging instance. Exercise desktop/mobile, normal chat, provider model listing, MCP discovery/reload and reconnect, working directory, archive/history and schedule execution. Save API statuses, event ordering and user-observable results. Run relevant real provider/OAuth tests only with explicit account and inference authorization. If such acceptance is blocked, identify the provider, cause and missing coverage. An upstream change affecting that provider is not release-approved until the operator accepts the unresolved risk or the check passes.

`verify-search-ui.mjs` currently assumes an `admin@local` user in the local home and reads existing sessions. Do not run it against production as part of unattended updating. Port this harness to explicit staging credentials in a reviewed change before using it as an automated staging gate. Theme/color acceptance mutates identity and also needs authorized staging credentials.

## 8. Storage migration and rollback gates

Before candidate code opens any existing session/memory/credential state, determine whether upstream changes serialization or migrations. Test a protected copy of the supported prior-version state under a private staging home. Use sanitized representative data where possible, including legacy session titles, bookmarks, manual renames, memory graphs, provider configuration and encrypted vault files plus their key as a matched set. Never log key material.

Required ledger:

| Check | Acceptance |
| --- | --- |
| Prior data opens | Candidate reads sessions/history/memory/config without loss or silent relocation |
| New write | Candidate writes and reopens representative data correctly |
| Mixed artifacts | Unsupported old/new SDK or binary pair is rejected or never deployed |
| Downgrade | Prove old binaries can open newly written data, or mark downgrade incompatible and require restoration of the pre-upgrade state snapshot |
| Scheduled side effects | Staging schedule tests cannot call real external actions, no unintended replay after restart |
| Rollback rehearsal | A staging switch back to previous matched artifacts and appropriate state snapshot restores the old workflow |

Do not assume swapping one runtime executable reverses a storage migration. Do not restore a pre-upgrade snapshot over ongoing writes. The operator must approve the maintenance window and any loss of writes made after that snapshot.

For real backups, use the deployment's actual `AMIRO_HOME` and `AMIRO_RUNTIME_HOME`, not guessed defaults. Identify external configuration/credential paths and all writers, including externally supervised runtime processes. Quiesce all writers before a consistent snapshot, preserve permissions, encrypt/back up outside public docs or repositories, and verify restore on staging. Keep prior backend, runtime, frontend and checksums as one release unit.

## 9. Review, integration and deployment

A merge is allowed only when the update report contains:

1. Old/new upstream SHAs, Amiro base/candidate SHAs and transformer version.
2. Vendoring/path exclusions and legal-attribution check.
3. Complete local-delta inventory with a test/equivalent behavior for each area.
4. Every conflict resolution and intentional deletion.
5. SDK/protocol/storage/credential migration notes and target features/platforms.
6. Full required check results, baseline failures, skips and blocked external acceptance.
7. Staging acceptance evidence and verified rollback plan.
8. Explicit integration approval, with deployment approval separately recorded.

Merge the accepted branch into Amiro through a normal reviewed commit. Re-run checks if the application base changed. Never force-push `main` or replay unreviewed concurrent work. Build immutable matched artifacts from the final integrated revision, verify checksums, deploy only in the approved maintenance window, then repeat production health/auth/chat/history/search/MCP/title checks. If health or acceptance fails, execute the reviewed rollback plan. Do not improvise a database edit or enable the upstream updater.

Use periodic upstream checks to propose candidate revisions, not to install them automatically. GitHub notification or scheduled agent review may prepare a report, but passing a notification check is not release approval.

## 10. Agent report format

Every run must end with these fields, including stopped runs:

```text
Status: prepared | blocked | accepted | integrated | deployed | rolled-back
Amiro base/candidate commits:
Upstream old/new commits:
Transformer and normalized-tree hashes:
Local customizations preserved/replaced and evidence:
Conflicts and intentional removals:
Required checks: command, exit code, source revision, artifact/log path
Real staging acceptance and blocked external boundaries:
Storage compatibility and rollback rehearsal:
Integration/deployment approvals:
Files changed and commits:
Remaining risks and next safe action:
```

Do not say "nothing can break". Say which behavior was observed, which boundaries passed and what was not exercised. This runbook and its companion skill were authored without importing an upstream update. A future full update requires the baseline-transform bootstrap and target-specific acceptance described above.
