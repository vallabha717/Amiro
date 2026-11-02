# Amiro runtime: upstream provenance

`runtime/` is a vendored, rebranded fork of an upstream open-source project.
This file records exactly what it came from and what was changed, so the
attribution stays auditable.

## Upstream source

| Field | Value |
|---|---|
| Project | jcode |
| Repository | https://github.com/1jehuang/jcode |
| Commit vendored | `48aa83e919e235d6cca87b7ce42858a9bd8e1f26` (updated from `11952e02ac76fa1c335633e9c6113691c1cf3395`) |
| Version | `0.99.0` + 54 commits on `master` (root `Cargo.toml` `[package].version`) |
| Licence | MIT: Copyright (c) 2025 Jeremy Huang |
| Licence text | `runtime/LICENSE`, copied verbatim from the upstream checkout |

The MIT licence and copyright notice are **unmodified**. The vendored tree
carries package names, paths, environment variables and user-facing strings that
say "Amiro", but the licence, the copyright holder, and every upstream URL and
service identity are intact. `runtime/LICENSE` is the licence that governs
`runtime/`.

## What is vendored

Copied from the upstream checkout at the commit above:

- `Cargo.toml`, `Cargo.lock`: workspace root package plus 88 member crates
- `crates/**`: all workspace crates (Rust sources, manifests, tests, prompt
  assets, fixtures)
- `src/**`: the root crate: CLI, TUI wiring, `src/bin/*`
- `tests/**`: the root crate's integration and end-to-end tests
- `docs/*.md`: top-level documentation. `crates/amiro-app-core/build.rs`
  compiles this corpus plus `README.md` into the binary, so it is a build input,
  not just prose.
- `README.md`, `OAUTH.md`, `TELEMETRY.md`, `CONTRIBUTING.md`, `AGENTS.md`,
  `CLAUDE.md`
- `changelog/**`: release-note data
- `assets/app-icons/**`, `assets/brand/**`: build/UI assets (the macOS launcher
  icon is an `include_bytes!` input)
- `scripts/rustc-parallel-frontend`, `scripts/dev_cargo.sh`,
  `scripts/cargo_exec.sh`: local build tooling
- `.cargo/config.toml`: each setting is commented with why it exists

## What is deliberately not vendored

Excluded because nothing in `cargo check`/`cargo build` reads it, or because it
is media rather than source:

- `.git/`: provenance is recorded here instead
- `assets/readme/**`, `assets/demos/**`, `assets/niri-screenshot.png`,
  `docs/images/**`, `docs/*.png`: README and demo media (screenshots/video)
- `docs/audits/`, `docs/dev/`, `docs/plans/`, `docs/proposals/`,
  `docs/sponsors/`, `docs/discovery-baselines/`: internal design notes;
  `amiro-app-core`'s build script only reads top-level `docs/*.md`
- `sdk/**`: the TypeScript SDK. Upstream explicitly supports builds without it
  (`amiro-sdk/src/sdk_tests/parity.rs` treats a missing `sdk/` tree as a
  vendored build and skips the cross-language parity assertions).
- `telemetry-worker/`, `ios/`, `packaging/`, `.github/`, `.claude/`,
  `flake.nix`, `flake.lock`: separate apps, CI, and dev-environment files
- `scripts/**` beyond the three build tools listed above (benchmarks,
  screenshots, release helpers)
- assorted scratch files (`fork-prompt-*.json`, `score_shard.py`,
  `indian-man-portrait.svg`)

## How the fork differs from upstream

Recorded in full in `../docs/RUST-RUNTIME.md`. In short:

1. **Rebrand.** `jcode`/`Jcode`/`JCODE` became `amiro`/`Amiro`/`AMIRO` in crate
   names, directory and file names, Rust identifiers, environment variables and
   user-facing strings. The root package is `amiro-runtime`, the library target
   is `amiro_runtime`, and the primary executable target is `amiro-runtime`.
2. **Default-deny upstream services.** The upstream self-updater and upstream
   telemetry/discovery beacons are off unless an operator opts in explicitly
   (`AMIRO_ALLOW_UPSTREAM_UPDATE`, `AMIRO_ALLOW_UPSTREAM_TELEMETRY`). See
   `runtime/crates/amiro-build-meta/src/fork_policy.rs`.
3. **Preserved upstream identities.** URLs, domains, the GitHub repository, the
   npm scope, release asset file names, the upstream subscription provider id,
   and the on-disk `.jcode` / `config/jcode` layout keep their upstream values so
   that nothing silently points at a repository, service, or path that does not
   exist.

## Third-party dependencies

`runtime/Cargo.lock` pins the full registry dependency set, resolved from
crates.io. Those crates keep their own licences and are not vendored here;
`cargo` fetches them at build time.

## Update history

| Date | From | To | How |
|---|---|---|---|
| 2026-10-19 | `11952e02` (0.98.1) | `48aa83e9` (0.99.0+54) | Normalized with `scripts/runtime-update/normalize_upstream.py` (transform v2), three-way merged with the tracked runtime per `docs/runtime-upstream-update.md`. Conflicts: root `Cargo.toml` (kept `amiro-runtime`, took `0.99.0`), `Cargo.lock` (re-resolved by Cargo). 10 upstream deletions (swarm task-graph DAG) reviewed: unused by Amiro. |
| 2026-11-02 | `48aa83e9` | `48aa83e9` + 25 ported fixes | Base unchanged. Individual fixes from upstream `master` and the owner's fork (`vallabha717/jcode`, branch `fix/muse-ga-antigravity-latest`), each normalized with transform v3 and merged file by file (`git merge-file`). Listed in `docs/runtime-customizations.json` under `portedFixes`; a later full update will find them already present. |

### Fixes ported on top of the base (2026-11-02)

Each is one Amiro commit named `fix(runtime): port <upstream subject>`.

| Upstream commit | Source | What it fixes |
|---|---|---|
| `b0706e840` | fork | Muse: tool mapping and the launcher User-Agent Muse needs to treat requests as subscription use |
| `926cca658` | fork | Muse native subscription login without the experimental opt-in |
| `cd255711b`, `f4b50936f` | fork | Muse quota usage windows; plan tier sanitized |
| `27717c5d5` | fork | Antigravity client version refresh; Gemini 3.8 effort and thinking |
| `aac3a2d10` | fork | Nullable tool type unions lowered for Gemini protobuf requests |
| `8a32da6c1` | fork | `execute_command` / `exec_command` resolve to bash |
| `91eabcd4d` | upstream | Antigravity context budget from the routed model catalog (needed by `27717c5d5`) |
| `aba7d5a49`, `11c33f3b5` | upstream | Assistant text that looks like a tool call is never executed |
| `742bd69f4` | upstream | OpenAI SSE idle detection and completion (applied by hand to `openai_stream_runtime.rs`) |
| `ce5d3cb4a` | upstream | UTF-8 kept intact across Responses SSE chunks |
| `4bb16b96c` | upstream | RUSTSEC-2026-0385/0387: unused AWS features dropped, `ctutils` 0.4.5 |
| `86d9efe05` | upstream | Account store transactions serialized across processes |
| `0e966d904`, `b8f1e46b0`, `a10284963` | upstream | Session resume and completed-turn reconciliation |
| `5e7e0457c`, `812c174c3` | upstream | Configured model honoured for fresh sessions; model catalogs refreshed every 30 minutes |
| `b882d84be`, `9fb8fbf35`, `7e6dec1e6`, `a2e805328`, `9d22cbb8e` | upstream | Tool schema dialect fixes; canonical edit operations; stale patch hunks rejected. `7e6dec1e6`'s todo-tool half is not applied: Amiro's todo tool has no `add` operation |

Not ported: `bf264b9d6` (swallowed server errors) needs upstream refactors Amiro lacks (task progress plumbing, turn ownership, todo dependencies); `81d9d2e79` changes only the TUI.
