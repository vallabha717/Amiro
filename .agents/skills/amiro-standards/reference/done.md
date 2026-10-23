# Definition of done

A change is done when every applicable line below was **run** and its result
reported (pass, fail with output, or "not run because …").

| Changed | Run | Notes |
| --- | --- | --- |
| Anything | `git diff --check` | no whitespace errors, no conflict markers |
| `clients/web/src/`, `clients/web/messages/`, `tests/e2e/` | `pnpm check-types` · `pnpm lint` · `pnpm test` | type-check also compiles the E2E specs |
| `clients/web/messages/` | `pnpm check:i18n` | en/hi keys + placeholders match |
| `backend/` | `cargo test --manifest-path backend/Cargo.toml` | re-run alone if a readiness timeout flakes |
| `runtime/` | `pnpm runtime:check` (+ targeted `cargo test -p amiro-…`) | record patch in `docs/runtime-customizations.json` |
| Anything user-visible | `pnpm build` then `pnpm --dir tests e2e --project <journey>` | watch `tests/recordings/<stamp>/suites/<journey>.mp4` |
| Release-affecting | full `pnpm test:e2e` | hand `REVIEW.md` + `full-run.mp4` to a reviewer |

Commit: Conventional Commits, one concern per commit, body explains *why*.
Never commit `tests/e2e.config.json`, recordings, build output or secrets.

Report format (end of task): what changed (files), what was run and the
result, what was not run and why, known risks / follow-ups.
