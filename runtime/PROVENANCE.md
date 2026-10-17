# Amiro runtime: upstream provenance

`runtime/` is a vendored, rebranded fork of an upstream open-source project.
This file records exactly what it came from and what was changed, so the
attribution stays auditable.

## Upstream source

| Field | Value |
|---|---|
| Project | jcode |
| Repository | https://github.com/1jehuang/jcode |
| Commit vendored | `1952e02ac76fa1c335633e9c6113691c1cf3395` |
| Version | `0.98.1` (root `Cargo.toml` `[package].version`) |
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
