# Runtime update runbook validation, 2026-10-18

This records validation of [runtime-upstream-update.md](runtime-upstream-update.md), the [agent skill](../.agents/skills/amiro-runtime-update/SKILL.md) and [customization inventory](runtime-customizations.json). No upstream update or production deployment was performed.

## Observed results

| Check | Observed result |
| --- | --- |
| `node scripts/verify-runtime-update-contract.mjs` | Passed: six preservation areas, 21 source sentinels, 12 acceptance-file targets and runbook/skill relative links |
| `pnpm exec vitest run src/lib/runtime-update-contract.test.ts` | Six tests passed: actual inventory accepted, moving/invalid pin rejected, missing updater gate rejected, missing acceptance script rejected, shell blocks parse, documented Git merge preserves local changes plus upstream additions and stops on conflicts |
| Documented snapshot merge | Exact Bash block exercised with Git and rsync in temporary repositories. A non-conflicting upstream addition kept the local edit. A conflicting edit left unmerged index entries and exited with the explicit STOP message. This uses synthetic snapshot files and is not a Jcode import rehearsal |
| Cargo package targets | `cargo metadata --locked --no-deps` confirmed all eight named runtime packages exist |
| Seven-package runtime/SDK gate | Exact runbook command passed: 253 tests including doctests, three ignored tests. Packages: build-meta, config-types, session-types, message-types, harness-api, sdk and storage |
| `pnpm check-types` | Passed after adding the test file |
| Scoped Biome lint | Passed for the new checker and contract test |
| Live skills API | Existing authenticated production `/api/skills?project=<Amiro checkout>` and `/api/skills/items/amiro-runtime-update?project=<Amiro checkout>` returned 200. Skill discovered as project scope, `.agents` source, read-only, with full body and STOP rules. No private token was printed |

## Defects caught and corrected

- `runtime/PROVENANCE.md` contained a 39-character SHA missing its leading `1`. `THIRD-PARTY-NOTICES.md` already recorded the full `11952e02ac76fa1c335633e9c6113691c1cf3395`. The public upstream `Cargo.toml` at that full immutable revision was fetched successfully and reports `jcode` version `0.98.1`. Provenance and the inventory now agree. This is a metadata correction, not a source import.
- The exact runtime gate caught two message-types fixtures with a query `jcode` but an expected display string `amiro`, and a session-types fixture with an `amiro` directory but a `jcode` query. The expected/query fixtures were aligned to their actual inputs. Production behavior was unchanged, the assertions were retained, and the complete seven-package command passed afterward.
- Independent OpenCode Go review prompted an explicit merge-conflict STOP branch and directory-isolation guards. Staging-token guards were retained to avoid reading production sessions.

## Not claimed or executed

- The first post-commit whole frontend run observed 648 passing tests and one popup-shell contract failure from concurrent connector redirects. The owner corrected the regression to assert the redirect explicitly. The repeated whole suite passed 650 tests on 2026-10-18 at 13:34, along with the update contract checker. This result includes shared working-tree connector changes not all committed at this checkpoint, so a future clean update candidate must repeat the full suite on its own exact revision.
- Public skill API discovery passed when the project path was supplied explicitly. Opening `/skill?name=amiro-runtime-update&project=...` in the current production browser did not show the editor: this route currently ignores `project` and resolves details using the server's default project context. Invoke the repository skill through an agent working in this checkout, or use the explicit-project API for inspection. Browser skill-editor access in a differently rooted server is not verified.
- No normalized upstream transformer exists yet. The runbook requires a deterministic baseline bootstrap and exact old-to-current local-delta proof before an import.
- No new upstream SHA was selected or imported. No real old/new Jcode merge, storage migration or production rollback was rehearsed.
- The broad app-core suite, full backend suite, lint/build, all three browser fixtures, target-platform builds and authorized real staging acceptance remain mandatory for an actual future candidate. They were not all rerun for this documentation/skill task.
- Three runtime SDK tests were ignored by the normal Cargo invocation. They were not silently counted as passed.
- A green structural checker does not prove behavioral preservation or approve release. New upstream paths and local patches still require inventory review.
- macOS/Windows portability and external provider/OAuth operation were not exercised. The command recipes target the current Linux environment.

The repository CI now invokes the structural checker, and the contract test is included in the normal frontend unit suite. Neither replaces the candidate update report or separate deployment approval.
