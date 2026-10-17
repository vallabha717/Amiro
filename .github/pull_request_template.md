<!--
Keep this short. Delete sections that do not apply.
-->

## What changed

<!-- One paragraph. Explain the problem and the change, not just the diff. -->

## Why

<!-- Link the issue this resolves, for example "Closes #123". -->

## How it was verified

<!--
Paste the commands you actually ran and the result. Do not claim a check you did
not run.
-->

- [ ] `pnpm check-types`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `cargo test --manifest-path backend/Cargo.toml` (if `backend/` changed)
- [ ] `cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features` (if `runtime/` changed)

## Checklist

- [ ] The branch is focused on one logical change.
- [ ] Commits follow the Conventional Commits style in `CONTRIBUTING.md`.
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` if this is user-visible.
- [ ] No secrets, API keys, tokens, or personal data are included.
- [ ] Documentation and UI copy describe only what actually works.
- [ ] I did not build new product features on top of the retired `adapter/` harness.
- [ ] `THIRD-PARTY-NOTICES.md` is updated if I added a dependency.
- [ ] I have read `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

## Notes for reviewers

<!-- Anything you are unsure about, any follow-up work, any known limitation. -->
