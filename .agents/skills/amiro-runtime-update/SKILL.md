---
name: amiro-runtime-update
description: Safely prepare and verify updates to Amiro's embedded vendored Jcode runtime without losing Amiro customizations. Use when asked to update, sync, rebase, upgrade or maintain the embedded runtime from upstream Jcode, or to audit compatibility and rollback readiness. Requires a pinned upstream commit, isolated source and data, a proven normalized baseline, preservation tests and separate deployment approval. Never performs an unattended upstream self-update.
---

# Amiro runtime upstream update

This skill prepares a reviewed candidate, not an automatic production upgrade. It does not grant permission to replace binaries, restore production state, connect accounts, use paid inference or rewrite shared history.

## Read first

1. [Full runbook](../../../docs/runtime-upstream-update.md). Read every phase before executing commands.
2. [Customization inventory](../../../docs/runtime-customizations.json).
3. [Upstream provenance](../../../runtime/PROVENANCE.md) and [fork/build guide](../../../docs/RUST-RUNTIME.md).
4. `backend/Cargo.toml`, `.github/workflows/ci.yml` and the candidate's current runtime-related commit history.

Run `node scripts/verify-runtime-update-contract.mjs` from the Amiro root before preparation and after any candidate import. This is structural validation only, not migration or behavior acceptance.

## Required inputs

Record full `AMIRO_BASE`, `UPSTREAM_OLD` from provenance, approved full `UPSTREAM_NEW`, target platforms/features, private workspace/evidence directory and authorization scope. Missing inputs mean **STOP**. A moving branch name is not a release pin.

## Execute in order

| Phase | Gate |
| --- | --- |
| Inventory | Account for all initial and subsequent Amiro runtime patches. Coordinate uncommitted owner work rather than stashing or overwriting it. |
| Isolation | Separate clone/build outputs, homes, sockets and ports. Never use live `clients/web/out/` or production credentials. |
| Normalize | Bootstrap a versioned deterministic rebrand/exclusion transform. Prove old baseline and complete local delta match the current tracked runtime exactly. No importer is already provided. |
| Merge | Three-way merge old-normalized/current-runtime/new-normalized in a disposable snapshot repository. Review each conflict/deletion. Never choose wholesale ours/theirs. |
| Compatibility | Preserve legal/service identities, default-deny updater/telemetry, homes/storage, configured search, streaming/titles, SDK and MCP. Adapt backend consumers deliberately. |
| Tests | Run every required command in runbook section 7. Capture exit codes/logs, skips and baseline failures. Do not remove tests to obtain green. |
| Staging | Verify the paired backend/runtime/frontend and supported old data on authorized staging, including real public browser paths, MCP and migration/rollback rehearsal. Fixture-only success cannot release. |
| Integrate | Reviewed commit only after acceptance. Revalidate if Amiro base changed. |
| Deploy | Separate explicit maintenance-window approval, consistent protected backups and matched immutable artifacts. Restore state when downgrades are incompatible. |

## Non-negotiable rules

- Keep `AMIRO_ALLOW_UPSTREAM_UPDATE` and `AMIRO_ALLOW_UPSTREAM_TELEMETRY` unset. Never use the runtime self-updater to update this fork.
- Do not rebase all of Amiro `main` onto Jcode or use `git subtree pull` on this copied tree.
- Do not blindly replace every jcode/Jcode/JCODE string. Legal notices, real URLs, subscription identities and intentional credential/wire names remain upstream.
- No unresolved conflict, unexplained deletion or untested important migration may proceed to release.
- No production state/token fallback in staging scripts. `verify-search-ui.mjs` has an admin@local/local-session assumption and needs a staging-safe port before unattended use.
- Unavailable target-specific provider or platform checks must be reported as blocked, not claimed passed.
- Upstream changes may require a manual reviewed port. The runbook is precise about this stop condition, not a guarantee of zero conflicts.

## Report

Use runbook section 10 verbatim: status, old/new/base/candidate SHAs, transform/tree hashes, local-delta evidence, conflicts, checks and logs, staging and blocked boundaries, migrations/rollback, approvals, files/commits and next safe action. Distinguish prepared, accepted, integrated and deployed. Never claim an update occurred when only docs or tests were run.
