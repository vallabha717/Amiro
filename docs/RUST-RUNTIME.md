# Amiro Rust runtime

`runtime/` is Amiro's **own** runtime engine: a vendored, rebranded Rust
workspace that Amiro builds and ships. It is not a wrapper around an installed
third-party binary, and nothing in this directory shells out to one.

Upstream provenance, the exact commit, the MIT licence text, and the list of
what was and was not vendored live in [`../runtime/PROVENANCE.md`](../runtime/PROVENANCE.md).
The licence that governs `runtime/` is [`../runtime/LICENSE`](../runtime/LICENSE)
(MIT, Copyright (c) 2025 Jeremy Huang), copied verbatim.

## Status

- Vendored tree: 88 workspace crates, ~38 MiB of source, root package
  `amiro-runtime`, library target `amiro_runtime`, primary executable target
  `amiro-runtime`.
- Compiles: `cargo check --manifest-path runtime/Cargo.toml --no-default-features
  --bin amiro-runtime` passes (see "Verifying the build" below).
- Not yet done: no Amiro release feed, no Amiro telemetry, and no packaging
  step. The Node adapter and native backend have been connected to this build.
  Remaining items are listed under "Open items".

## Building

```bash
# from the repository root
CARGO_BUILD_JOBS=1 cargo check \
  --manifest-path runtime/Cargo.toml \
  --no-default-features \
  --bin amiro-runtime
```

Notes that matter on a shared or memory-constrained machine:

- `--no-default-features` drops the two heavy optional stacks (`pdf` and the AWS
  SDK `bedrock` provider). Enable them later, deliberately, once the core build
  is accepted: `--features pdf`, `--features bedrock`.
- Run it with `CARGO_BUILD_JOBS=1` (or set `CARGO_BUILD_JOBS` in the
  environment). A single `amiro-base` rustc unit peaks well above 1 GiB; several
  concurrent jobs can exhaust a 16 GiB machine that is also running other builds.
- `runtime/.cargo/config.toml` sets `jobs = 2`. Cargo discovers
  `.cargo/config.toml` from the **current working directory**, not from
  `--manifest-path`, so that setting applies when you run cargo from inside
  `runtime/`. From the repository root, pass the equivalent explicitly:

  ```bash
  cd runtime && cargo check --no-default-features --bin amiro-runtime
  # or, from the root:
  CARGO_BUILD_JOBS=1 cargo check --manifest-path runtime/Cargo.toml ...
  ```

- `CARGO_PROFILE_DEV_DEBUG=0` additionally drops debug info, which is the
  cheapest way to shave memory and disk for a check-only pass. It changes the
  build fingerprint, so use it consistently or not at all.

- Dependencies are ordinary crates.io crates pinned by `runtime/Cargo.lock`.
  They are not vendored; the first build needs network access to fetch them.

The build produces `runtime/target/debug/amiro-runtime`. The other targets are
`test_api`, `amiro-harness`, and the `dev-bins` benches/probes
(`session_memory_bench`, `memory_recall_bench`, `mermaid_side_panel_probe`,
`tui_bench`), which only build with `--features dev-bins`.

## Layout

```
runtime/
  Cargo.toml          workspace root package (amiro-runtime) + 88 members
  Cargo.lock          pinned dependency set
  LICENSE             upstream MIT licence, verbatim
  PROVENANCE.md       upstream commit, vendoring and rebranding record
  src/                CLI + bin entry points (main.rs is the amiro-runtime bin)
  crates/             amiro-* workspace crates
  tests/              root-crate integration and e2e tests
  docs/*.md           compiled into the binary by amiro-app-core/build.rs
  assets/             app icons and brand assets used at build/UI time
  scripts/            local build tooling
  .cargo/config.toml  build settings for builds launched inside runtime/
```

Notable crates, by role:

| Crate | Role |
|---|---|
| `amiro-build-meta` | compile-time version metadata **and the fork policy gates** |
| `amiro-base` | providers, auth, sessions, storage, tools, config |
| `amiro-app-core` | the agent loop, server, tools, plus `build.rs` doc corpus |
| `amiro-tui` | terminal UI, rendering, replays |
| `amiro-harness-api`, `amiro-harness-api-server` | the API bridge used by clients over a Unix socket |
| `amiro-sdk` | Rust client for the runtime protocol |
| `amiro-telemetry-core` | upstream telemetry/transcript/discovery client (gated off) |
| `amiro-update-core`, `amiro-build-support` | upstream self-update and install plumbing (gated off) |

## Rebrand

`jcode` / `Jcode` / `JCODE` became `amiro` / `Amiro` / `AMIRO` across crate
names, directory and file names, Rust identifiers (modules, types, functions,
constants), environment variables, and user-facing strings.

Identity details:

| Before | After |
|---|---|
| root package `jcode` | `amiro-runtime` |
| library target `jcode` | `amiro_runtime` |
| binary `jcode` | `amiro-runtime` |
| crates `jcode-base`, `jcode-tui`, … | `amiro-base`, `amiro-tui`, … |
| env vars `JCODE_*` | `AMIRO_*` |
| `jcode_dir()` and friends | `amiro_dir()` and friends |

`amiro_runtime` is deliberately not named `amiro`: the Tauri desktop shell
already owns the `amiro` library name in this repository, and the two must not
collide.

## Preserved upstream identities

A rebrand that also rewrote these would produce a runtime that confidently talks
to repositories, hosts, paths, and services that do not exist. They are
therefore kept exactly as upstream:

- **URLs and domains.** `https://jcode.sh`, `https://api.jcode.sh/v1`,
  `https://telemetry.jcode.sh/v1/*`, `https://github.com/1jehuang/jcode`, the
  npm scope `@1jehuang/jcode-sdk`, and every issue/release/documentation link.
- **Release asset names.** `jcode-linux-x86_64.tar.gz`, `jcode-macos-aarch64`,
  `jcode-windows-x86_64.exe`, the `readme-assets` files, and the
  `jcode-harness-api-bridge` companion binary name.
- **The upstream subscription provider.** Its wire id `"jcode"`, the
  `"jcode-subscription"` alias, the credential file `jcode-subscription.env`,
  and the display name "Jcode Subscription". This is the identity of a real
  upstream service; renaming the client side would only break it.
- **On-disk layout.** The runtime home stays `~/.jcode` (or `$AMIRO_HOME`), and
  per-provider credentials stay in `<runtimeHome>/config/jcode/<provider>.env`.
  Amiro's Node adapter reads that exact path and `~/.jcode` directly, so changing
  it here would break the adapter with no compile-time signal. A migration to an
  Amiro-owned layout has to be done together with the adapter, not by renaming a
  string in the runtime.
- **Protocol strings.** `jcode.page_snapshot.v1` and the `jcode_not_found` error
  code are shared with the external runtime client; both sides must agree.
- **Legal notices.** `LICENSE`, the copyright line, and attribution text.

## Fork policy gates

Two upstream behaviours are **default-deny** in this fork. They are implemented
in [`runtime/crates/amiro-build-meta/src/fork_policy.rs`](../runtime/crates/amiro-build-meta/src/fork_policy.rs),
a dependency-free leaf crate that every other crate can reach.

| Gate | Default | Opt-in | Wired into |
|---|---|---|---|
| Upstream self-update | **off** | `AMIRO_ALLOW_UPSTREAM_UPDATE=1` | `amiro-app-core::update::should_auto_update`, `src/cli/startup.rs::should_auto_install_update` |
| Upstream telemetry, transcripts, discovery beacons | **off** | `AMIRO_ALLOW_UPSTREAM_TELEMETRY=1` | `amiro-telemetry-core::is_enabled` |

Why default-deny:

- The self-updater downloads an upstream release and swaps the running
  executable. In an Amiro install that silently replaces Amiro's runtime with
  the upstream binary.
- Telemetry would forward Amiro users' usage data to the upstream vendor under
  fork branding.

The gates are one-way: they can only be opened by an explicit opt-in. The
existing `AMIRO_NO_TELEMETRY` / `DO_NOT_TRACK` opt-outs still work and can only
turn telemetry further off. The gate functions are pure environment reads, and
`cargo test -p amiro-build-meta` asserts the default-deny and opt-in behaviour.

Anything Amiro ships later, such as its own update feed, its own telemetry, or
its own account services, needs its own gate. None of these opt-ins may be reused
for that: they exist only to reach the upstream vendor's real services.

## Compatibility with the existing adapter

Amiro's Node adapter (`adapter/`, outside this directory) exports the runtime
home under `AMIRO_RUNTIME_HOME` and the pre-rename `JCODE_HOME`. The runtime
accepts all three names, in order `AMIRO_HOME`, `AMIRO_RUNTIME_HOME`,
`JCODE_HOME` (`amiro_storage::RUNTIME_HOME_ENV_ORDER`), so an installation that
already points at a runtime home keeps using it instead of being silently
relocated.

Two things did change and are worth knowing when reading adapter code or logs:

- Unix sockets are now `amiro-api.sock`, `amiro.sock`, `amiro-debug.sock`.
  Clients that pass `AMIRO_API_SOCKET` explicitly are unaffected; the adapter's
  own fallback already expects an `amiro-api.sock` name.
- The runtime announces itself to clients as `amiro-runtime`.

## Verifying the build

The acceptance check is the command in "Building" above, and it has been run
against this vendored tree:

| Command | Result |
|---|---|
| `cargo check --manifest-path runtime/Cargo.toml --no-default-features --bin amiro-runtime` | exit 0: cold run 4m44s including all dependency units, 0 errors, 19 warnings (all pre-existing upstream lints such as `dead_code` and unused `profile` package specs) |
| `cargo build --manifest-path runtime/Cargo.toml --no-default-features --bin amiro-runtime` | exit 0 in 6m21s; produced `runtime/target/debug/amiro-runtime`, an x86-64 ELF executable |
| `./runtime/target/debug/amiro-runtime --version` | `amiro-runtime v0.98.1-dev (3b038a4, dirty)` (the version string is built by `amiro-build-meta`; the `dirty` marker comes from the enclosing Amiro git checkout, since the vendored tree itself has no `.git`) |
| `cargo test --manifest-path runtime/Cargo.toml -p amiro-build-meta` | 5 passed, 0 failed (includes both fork-policy gate tests) |

Both runs used `CARGO_BUILD_JOBS=1` on a machine that was also running other
builds. `cargo check` is the gate that matters for the source-level rebrand
(crate names, paths, identifiers); `cargo build` additionally proves the link
step, and `cargo test` exercises behaviour.

Useful extra checks, in increasing cost:

```bash
cargo check --manifest-path runtime/Cargo.toml --no-default-features --bin amiro-runtime
cargo test  --manifest-path runtime/Cargo.toml -p amiro-build-meta      # fork gates
cargo build --manifest-path runtime/Cargo.toml --no-default-features --bin amiro-runtime
```

## Updating from upstream

Follow [runtime-upstream-update.md](runtime-upstream-update.md) and the repository [amiro-runtime-update skill](../.agents/skills/amiro-runtime-update/SKILL.md). The runtime is a vendored source fork, not a submodule. Updating upstream Jcode does not update Amiro automatically. Imports require an isolated candidate, a proven normalized baseline, preservation of the complete Amiro delta, mandatory SDK/storage/browser tests and separate deployment approval. Never enable the upstream self-updater to update this fork.

The [customization inventory](runtime-customizations.json) and `node scripts/verify-runtime-update-contract.mjs` provide structural guards. They do not constitute an implemented importer or proof that a future update is safe.

## Open items

Deliberately not done in this change, in rough priority order:

1. **Adapter and native backend connection.** Completed. `adapter/src/runtime.mjs`
   resolves the runtime through Amiro's socket/home variables, `bin/amiro`
   delegates to `amiro-runtime` via `AMIRO_RUNTIME_BIN`, and the native Rust
   backend (`backend/`, `amiro-backend`) connects to `amiro-runtime` via
   `amiro-sdk`.
2. **Amiro-owned services.** A release feed and telemetry endpoint under Amiro's
   control, behind their own explicit gates, if Amiro wants update or telemetry
   features at all. Until then both stay off.
3. **Packaging.** Build scripts to produce and checksum an `amiro-runtime`
   artifact, and a launcher/`amiro` alias if the product name should also be an
   executable name.
4. **Optional capabilities.** Re-enable `pdf` and `bedrock` deliberately, with
   their own build/test pass, after the core runtime is accepted.
5. **Documentation corpus.** `docs/*.md` in `runtime/` is upstream reference
   material compiled into the binary. Much of it describes the upstream product
   by its upstream name and predates this fork; it is accurate about behaviour
   but not about branding.
6. **Build metadata.** The vendored tree has no `.git`, so `amiro-build-meta`'s
   build script falls back to `unknown` for the git hash/date unless
   `AMIRO_BUILD_GIT_HASH` / `AMIRO_BUILD_METADATA_FILE` is provided by the build
   pipeline.
