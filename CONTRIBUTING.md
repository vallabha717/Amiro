# Contributing to Amiro

Thanks for taking the time to help. This document covers how to file issues, how
to propose changes, how to run the checks that a pull request must pass, and
where each part of the codebase lives.

Upstream: <https://github.com/vallabha717/Amiro>

## Before you start

- Read `README.md` for what Amiro is today. Several files under `docs/` are
  design history rather than a description of the current build.
- For anything larger than a bug fix, open an issue first and describe the
  approach. It is cheaper to agree on a direction before you write code.
- Never commit secrets, tokens, or recordings of live provider traffic.

## Repository layout

| Path | What it is | Language |
| --- | --- | --- |
| `src/` | Statically exported Next.js frontend, builds to `out/` | TypeScript / React |
| `src-tauri/` | Tauri 2 desktop shell, product name `Amiro` | Rust |
| `backend/` | Native HTTP backend, binary `amiro-backend`, library crate `backend` | Rust (axum) |
| `runtime/` | Vendored Amiro-owned runtime, binary `amiro-runtime` | Rust |
| `tests/rust/` | Std-only contract test harness, `amiro-testkit` | Rust |
| `tests/e2e/` | Recorded Playwright journeys (video + review report) | TypeScript |
| `adapter/` | Retired compatibility harness, see below | Node / ESM |
| `scripts/` | Build and verification entrypoints | Bash / Node |
| `messages/` | UI translations: `en.json` and `hi.json` only | JSON |
| `.agents/skills/` | Agent skills; start with `amiro-standards` | Markdown |

### `adapter/` is a retired compatibility harness, not the backend

The Node adapter in `adapter/` is **not** the Amiro backend and it is not part
of the shipped product. Nothing starts it in production. The backend is the
Rust `amiro-backend` crate in `backend/`, which serves the built UI and the API
and owns the runtime bridge.

The adapter is kept in-tree for contract tests and historical reference only. It
still depends on the separately installed upstream `@1jehuang/jcode-sdk` package,
which is not bundled with Amiro. Changes to `adapter/` are accepted only when
they keep those contract tests meaningful. Do not present `adapter/` output,
routes, or behaviour as the product's behaviour, and do not build new product
features on top of it.

There is no Go in this repository. The Go backend was retired and removed.

## Filing issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`:

- **Bug report** for something that is broken or regressed.
- **Feature request** for something you want Amiro to do.

For open-ended questions, ideas, or design discussion, open an issue with the
feature template and mark it clearly as discussion.

A good bug report includes the Amiro version (`package.json`,
`src-tauri/tauri.conf.json`), your OS and architecture, how you launched Amiro
(desktop shell, local dev, or the preview server), exact steps to reproduce, and
what you expected versus what you saw. Include the relevant log lines, but
redact API keys, tokens, email addresses, and file paths that identify you.

Do **not** file security vulnerabilities as public issues. See `SECURITY.md`.

## Proposing changes

1. Fork the repository (maintainers: just branch) and branch from `main`, for
   example `feat/voice-barge-in` or `fix/schedule-timezone`.
2. Keep the branch focused. One logical change per pull request is much easier
   to review than a mixed bag.
3. Make the change, then run the pre-PR checks below.
4. Push the branch and open a pull request against `main`:

   ```sh
   git push -u origin feat/voice-barge-in
   gh pr create --fill          # or open it on GitHub; the template guides you
   ```

5. Add a note under `## [Unreleased]` in `CHANGELOG.md` when your change is
   user-visible.

Commit as you go. Force-pushing your own feature branch during review is fine.

## How `main` is protected and how PRs merge

`main` is guarded by repository rulesets (Settings → Rules → Rulesets):

| Ruleset | What it enforces | Bypass |
| --- | --- | --- |
| main: no force-push or deletion | `main` can't be deleted or force-pushed, and history stays linear | nobody |
| main: changes via PR with green CI | changes land through a pull request; the **All required checks passed** CI job must be green; open review threads must be resolved | repository admins |
| release tags are immutable | `v*` tags can't be moved or deleted | repository admins (release recovery only) |

What that means in practice:

- **Contributors and bots (including Dependabot)** open a PR. Once CI shows
  *All required checks passed*, a maintainer merges it with **Squash and
  merge** (default) or **Rebase and merge**. Merge commits are disabled, and
  the branch is deleted after merging.
- **Approvals:** none required (0 approving reviews), so a maintainer can
  merge their own PR as soon as CI is green. Turn on **auto-merge**
  (`gh pr merge --auto --squash`) to merge the moment checks pass.
- **Maintainers (repo admins)** may push small, already-checked changes
  straight to `main`; GitHub records it as a bypass ("Bypassed rule
  violations"). Prefer a PR for anything non-trivial, so CI runs before the
  change lands rather than after.
- **Required check:** only *All required checks passed* (the `required` job
  in `ci.yml`). To make another job required, add it to that job's `needs`
  list; the ruleset doesn't need editing.

Typical maintainer flow:

```sh
git switch -c fix/something
# …change, commit…
git push -u origin fix/something
gh pr create --fill
gh pr merge --auto --squash      # merges by itself when CI is green
```

Other workflows run on PRs only when relevant files change: **Desktop app**
(`src-tauri/`), **Install smoke** (`install.sh`, `packaging/`) and
**Workflow lint** (`.github/workflows/`, shell scripts). They are not
required checks, but don't merge while one of them is red.

## Releasing

Releases are cut by maintainers from `main` (see [docs/SETUP.md](docs/SETUP.md#releases-cicd)):

```sh
gh workflow run release.yml -f version=v1.27.0   # or: git tag v1.27.0 && git push origin v1.27.0
```

`release.yml` builds the server archives and desktop installers, publishes
the release with `SHA256SUMS`, provenance attestations and release notes, and
then test-installs it on Linux and macOS.

## Commit conventions

Amiro uses Conventional Commits. The subject line is
`type(scope): imperative summary`, for example
`fix(schedules): honor saved models` or `feat(agent): synchronize mascot colors
with sidebar themes`.

Types in use: `feat`, `fix`, `test`, `docs`, `build`, `style`, `refactor`,
`perf`, `security`, `a11y`, `chore`.

Scopes in use: `backend`, `runtime`, `agent`, `agent-ui`, `schedules`, `search`,
`providers`, `sidebar`, `usage`, `adapter`, `amiro`, `test`, `docs`.

Rules of thumb:

- Keep the subject under about 72 characters and do not end it with a period.
- Use the imperative mood ("fix the leak", not "fixed the leak").
- Explain *why* in the body when the change is not self-evident.
- Split unrelated changes into separate commits.

## Pre-PR checks (required)

Run these before opening a pull request. They are the same commands CI runs in
`.github/workflows/ci.yml`.

### Frontend

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm lint
pnpm test
```

`pnpm check-types` is `tsc --noEmit`. `pnpm lint` is `biome lint`. `pnpm test`
is `vitest run`. Use the frozen lockfile install so you notice a stale
`pnpm-lock.yaml` locally rather than in CI.

Auto-fixers, if you wrote code that fails the two checks above:

```sh
pnpm format
pnpm lint:fix
```

`pnpm format` is `biome format --write`. `pnpm lint:fix` is
`biome lint --write --unsafe`. Review the diff these produce: `--unsafe` can
change behaviour. A convenience script, `pnpm check`, runs
`pnpm lint:fix && pnpm check-types && pnpm test`, but it does not cover the Rust
surfaces, so it is not a substitute for this list.

### Rust

```sh
cargo test --manifest-path backend/Cargo.toml
cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features
```

The first command is also `pnpm native:test` and `pnpm test:native-backend`. The
second is also `pnpm runtime:check` and must stay in sync with the `runtime:check`
script in `package.json`.

Run the runtime check whenever you touch `runtime/`, because the backend links
against it and a runtime-only build break would otherwise reach `main`.

Rust formatting follows rustfmt defaults. There is no `rustfmt.toml` in this
repository, and the existing tree is not uniformly rustfmt-formatted. Do not run
`cargo fmt` across `backend/` or `runtime/` in a feature pull request, because it
would produce a large diff unrelated to your change. Format the code you write
close to rustfmt defaults and consistent with the file you are editing.

## Running the test suites

| Suite | Command | Notes |
| --- | --- | --- |
| Frontend unit (Vitest) | `pnpm test` | Excludes `tests/**`, `adapter/**`, and `node_modules` via `vitest.config.ts` |
| Frontend unit, watch | `pnpm test:watch` | Interactive |
| Types | `pnpm check-types` | `tsc --noEmit` |
| Lint | `pnpm lint` | Biome, config in `biome.json` |
| Native backend | `cargo test --manifest-path backend/Cargo.toml` | Integration tests live in `backend/tests/` |
| Runtime check | `cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features` | Must match `pnpm runtime:check` |
| Vendored runtime suite | `cd runtime && cargo test` | Large. The vendored tree has its own `runtime/CONTRIBUTING.md` |
| Rust testkit | `cd tests/rust && cargo test --offline` | Std-only, no network |
| Tauri shell check | `cd src-tauri && cargo check --offline` | Shell only |
| E2E journeys (recorded) | `pnpm --dir tests install-browsers` then `pnpm test:e2e` | Playwright. Boots an isolated Amiro, records video. See `tests/e2e/README.md` |
| Native UI verification | `pnpm verify:native-ui` | `scripts/start-native-ui-check.sh` |
| Schedules UI verification | `pnpm verify:schedules-ui` | `scripts/verify-schedules-ui.mjs` |
| Adapter contract tests | `pnpm --dir adapter install` then `node --test adapter/test/*.test.mjs` | Retired harness. Not part of the required pre-PR checks |

### E2E journeys: every user-facing change adds a step

`tests/e2e/` holds recorded Playwright journeys covering the whole product:
onboarding, providers, voice, chat (tables, web search, visualize, swarm,
skills), connectors/MCP with every auth style including OAuth, the secret
vault, the agent hub, the agent configuring Amiro from chat, live voice,
schedules and a UX audit. Each run boots a fresh isolated Amiro (it never
touches `~/.amiro`) and writes `tests/recordings/<stamp>/full-run.mp4`,
per-journey videos and a `REVIEW.md` (all gitignored).

```sh
cp tests/e2e.config.example.json tests/e2e.config.json   # add your keys; gitignored
pnpm test:e2e                                             # all journeys
pnpm --dir tests e2e --project connectors                 # one journey
```

**If your pull request adds or changes anything a user can see or trigger,
add or update the matching journey step in the same pull request** and attach
the journey's video (or say why you could not run it). Values a user must
supply (API keys, models, URLs) go in `tests/e2e.config.example.json`, never
in a spec. The how-to, including which journey owns which surface, is
`.agents/skills/e2e-journeys/SKILL.md`. The suite needs real provider keys, so
CI does not run it; it is not part of the required pre-PR checks.

Some native tests exercise a real runtime over its bridge and are skipped or
degenerate without one. If a native test fails only on your machine, say so in
the pull request and include the command you ran and its output.

## Code style

**TypeScript, JavaScript, JSON, CSS, and YAML** are handled by Biome 1.9.4,
configured in `biome.json`:

- 2-space indentation, LF line endings, 80-column line width.
- Double quotes.
- Import organization is enabled.
- The linter runs with `recommended: false` plus an explicit rule set, so
  `pnpm lint` is a narrow check. Passing it does not mean the file is otherwise
  clean. Match the style of the surrounding code.

**Rust** uses rustfmt defaults, edition 2021 for `backend/`, `src-tauri/`, and
`tests/rust/`, and edition 2024 for the vendored `runtime/` workspace. Keep
public items documented and avoid adding dependencies to `backend/` or
`runtime/` without saying why in the pull request.

Staged files are formatted and lint-fixed by the `lint-staged` configuration in
`package.json` when the Husky hooks are installed (`prepare` runs `husky`). The
hooks are scaffolding only in a fresh checkout, so do not rely on them. Run the
pre-PR checks yourself.

Do not commit build output. `out/`, `node_modules`, `*.tsbuildinfo`,
`backend/target/`, `runtime/target/`, `src-tauri/target/`, and
`src-tauri/binaries/` are ignored.

## Scope and product honesty

Amiro is a thin product layer over the vendored runtime. A few rules keep
documentation and UI honest:

- Do not add UI for runtime capabilities that do not exist. A control that
  cannot do anything is a bug, not a placeholder.
- Do not claim a feature works in a document before it is implemented and
  verified end to end.
- Say which engine a behaviour comes from when it is delegated to the runtime
  rather than implemented in Amiro.
- Preview restrictions, approval prompts, and workspace read-only modes are
  policy enforced by Amiro and the runtime. They are not an operating system
  sandbox. Do not describe them as one.

## Licensing

Amiro is MIT-licensed. The full text is in the root `LICENSE`, and the same
license is declared in `package.json` and the crate manifests. By contributing
you agree that your contributions are licensed under the same terms. The vendored
runtime keeps its own MIT license and copyright notice at `runtime/LICENSE`, and
third-party attribution is recorded in `THIRD-PARTY-NOTICES.md`. Do not remove or
reword those files. If you add a dependency, add its attribution there.

## Reporting security issues

Follow `SECURITY.md`. Use GitHub's private vulnerability reporting rather than a
public issue.

## Code of conduct

Participation is covered by `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1).
