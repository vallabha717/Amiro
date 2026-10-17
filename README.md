<div align="center">

# Amiro

**A personal-intelligence chat app you can actually own: a native Rust backend, a vendored Rust agent runtime, and a Tauri desktop shell around a statically-exported Next.js UI.**

[![CI](https://github.com/vallabha717/Amiro/actions/workflows/ci.yml/badge.svg)](https://github.com/vallabha717/Amiro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.9-brightgreen.svg)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-%E2%89%A51.89-orange.svg)](https://rustup.rs)
[![pnpm](https://img.shields.io/badge/pnpm-10.2.1-blueviolet.svg)](https://pnpm.io)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB.svg)](https://tauri.app)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org)

</div>

---

## Table of contents

- [What Amiro is](#what-amiro-is)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Setup on a fresh VM or machine](#setup-on-a-fresh-vm-or-machine)
  - [Fast path: one command](#fast-path-one-command)
  - [Manual path: Ubuntu / Debian](#manual-path-ubuntu--debian)
  - [Manual path: macOS](#manual-path-macos)
  - [WSL2](#wsl2)
  - [Headless server (no display)](#headless-server-no-display)
  - [First sign-in](#first-sign-in)
- [Running Amiro](#running-amiro)
- [Configuration](#configuration)
- [The `amiro` CLI](#the-amiro-cli)
- [Testing and verification](#testing-and-verification)
- [What works today, and what does not](#what-works-today-and-what-does-not)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License and acknowledgements](#license-and-acknowledgements)

---

## What Amiro is

Amiro is a self-hostable chat product built from four parts that all live in this
repository:

| Part | Path | Binary | What it does |
|---|---|---|---|
| **Web UI** | `src/` | static export in `out/` | The Next.js app, statically exported so it can be served by the backend with no Node runtime |
| **Backend** | `backend/` | `amiro-backend` | Rust (axum). Application auth, threads, schedules, providers, and the runtime bridge lifecycle. Serves the UI **and** the API from one listener |
| **Runtime** | `runtime/` | `amiro-runtime` | The Amiro-owned Rust agent runtime (vendored fork, MIT, provenance kept). Owns model execution, sessions, provider routing, and a TUI |
| **Desktop shell** | `src-tauri/` | `Amiro` | Tauri 2. Spawns the backend and runtime as sidecars, injects a per-launch port and token into the webview |

There is **no Go anywhere** in this repository. The Node code in `adapter/` is a
**retired compatibility harness** kept for contract tests and one release of
comparison. It is not the backend, and nothing in the native startup path runs it.

Because the whole stack is Rust plus a static export, a running Amiro needs no
Node.js at all. Node is only a build-time and test-time dependency.

> **Status:** this is a working local and single-operator deployment, not a
> hardened multi-tenant service. Read
> [What works today, and what does not](#what-works-today-and-what-does-not)
> before exposing it to anyone but yourself.
> [`docs/AMIRO-RUNTIME.md`](docs/AMIRO-RUNTIME.md) is the source of truth for
> behaviour, and older documents under `docs/` are design history.

---

## Features

**Chat and models**

- Multi-provider chat against the connected-provider model catalog, namespaced
  `provider:model` so a route is always pinned and never silently swapped.
- Full provider catalog driven by the installed runtime: OAuth, device code, API
  key, and local-endpoint mechanisms are all first class. A reference install
  reports 55 providers and 140 models.
- OAuth eligibility is read from the live catalog (`canStartOauth`), so a new
  provider in the runtime works with no code change.
- Streaming responses over SSE, thread history, titles, archives, and export.
- A server-side folder picker, so choosing a workspace works in a plain browser
  with no native OS dialog. The chosen folder is pinned to the runtime session.

**Agent**

- A customisable Agent: display name, tagline, persona sliders, portrait upload,
  and the sidebar theme.
- **Superpowers**: the runtime, project, and user-authored instruction sets,
  resolved server-side against the authenticated user's catalog.
- **Memory**: read-only inspection of the runtime's own memory graphs. There is no
  second memory engine.
- **Workspace**: an admin-only, allowlisted, realpath-checked file browser for
  runtime memory, skills, persona mirrors, and docs. Credential files and session
  logs are never exposed, and `config.toml` is redacted before it leaves the backend.
- OpenDots plush avatars whose tint follows the active sidebar theme, with
  `prefers-reduced-motion` respected.

**Schedules**

- Run a saved prompt on a timer: once, cron, or interval, each in its own timezone.
- Two modes: `notify` posts the result as a thread message with no model call, and
  `execute` runs a real agent turn with tools forced off and the model pinned
  server-side.
- DST-correct wall-time handling. A time that never exists, or exists twice, is
  rejected with a 400 rather than silently shifted.
- Inspectable run history, a cross-process advisory lock so two backends cannot
  double-fire, and crash recovery that does not replay side effects.

**Operations**

- Admin surfaces for providers, search providers, usage, and users.
- Self-view usage stats, quota read from the runtime, and explicit labelling of
  shared-account scope instead of pretending per-user billing.
- Password changes that take effect immediately, rate-limited sign-in, closed
  registration by default, and a generated per-install admin password.

---

## Architecture

```mermaid
flowchart TD
    U[Amiro web UI<br/>Next.js static export in out/] -->|HTTPS + bearer token| B[Native Rust backend<br/>amiro-backend, axum]
    D[Tauri desktop shell] -->|loopback HTTP + per-launch token| B
    B -->|protocol v1 over Unix socket| R[Owned Amiro runtime<br/>amiro-runtime]
    R --> P[Configured model providers]
    B --> H[App state<br/>AMIRO_HOME: users, threads, schedules]
    R --> RH[Runtime state<br/>AMIRO_RUNTIME_HOME: memory, sessions]
```

One listener serves both the static export and the API. The backend starts the
runtime on demand, keeps it alive with protocol pings (the daemon otherwise exits
after five idle minutes), and restarts it if it dies.

In the desktop build, the Tauri shell reserves an ephemeral `127.0.0.1:0` port,
generates a per-launch shared secret, spawns `amiro-backend` as a sidecar, and
injects the port and token into the webview as `window.__BACKEND_PORT__` and
`window.__BACKEND_TOKEN__` before the first request.

There are **two different homes**, and conflating them is the most common source
of confusion:

- `AMIRO_HOME` is the **application** home: `users.json`, `threads.json`,
  `store/`, `workspace/`, and `admin-initial-password`.
- `AMIRO_RUNTIME_HOME` is the **runtime** home: memory, sessions, and the
  runtime's own credential layout.

---

## Requirements

| Tool | Minimum | Why |
|---|---|---|
| [Node.js](https://nodejs.org) | **20.9** | Build and test the frontend. Not needed to *run* a shipped Amiro |
| [pnpm](https://pnpm.io) | **10.2.1** | The repo pins `pnpm@10.2.1` via `packageManager` |
| [Rust and Cargo](https://rustup.rs) | **1.89** | The backend, the runtime, and the Tauri shell. The pinned lockfile needs it (`uuid@1.28.0` declares `rustc 1.89.0`, the runtime uses edition 2024, and the backend uses `std::fs::File::try_lock`). Verified: 1.88 fails, 1.89 builds |
| [Tauri CLI](https://v2.tauri.app/reference/cli/) | **2.x** | Only for the desktop shell. `cargo install tauri-cli --version "^2" --locked`, invoked as `cargo tauri ...` |
| Python 3 | any 3.x | Only for the local stub provider used by the native UI acceptance check |
| `curl` | any | Only for the readiness and acceptance scripts |

Linux also needs the usual Tauri/WebKitGTK development packages. The exact list is
in the setup sections below.

---

## Setup on a fresh VM or machine

Amiro builds from source in one repository. Everything below has been run on
Ubuntu 24.04 (root or a sudo-capable user) and on macOS, and the whole thing takes
roughly 15 to 25 minutes on a 2-core box, most of it the first Rust compile.

### Fast path: one command

```sh
git clone https://github.com/vallabha717/Amiro.git
cd Amiro
./scripts/setup-vm.sh
```

`scripts/setup-vm.sh` detects your OS and package manager, installs the system
packages, Rust, Node, and pnpm if they are missing, installs dependencies, builds
the native binaries and the frontend, and prints the exact commands to start and
test. It is idempotent, so re-running it is safe, and it takes
`--skip-frontend`, `--skip-native`, `--skip-desktop`, `--yes`, and `--help`.

A longer, hand-held version of the same walkthrough, including WSL2 and headless
notes, lives in [`docs/VM-SETUP.md`](docs/VM-SETUP.md).

### Manual path: Ubuntu / Debian

```sh
# 1. System packages (Tauri/WebKitGTK and the usual build tools)
sudo apt-get update
sudo apt-get install -y \
  build-essential pkg-config libssl-dev curl wget git file python3 \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev

# 2. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# 3. Node 20+ and pnpm
#    Use your distribution's package, nvm, or nodesource. Then:
corepack enable
corepack prepare pnpm@10.2.1 --activate

# 4. Repository and dependencies
git clone https://github.com/vallabha717/Amiro.git
cd Amiro
pnpm install

# 5. Build everything
pnpm build                  # static export into out/
scripts/build-native.sh     # amiro-backend + amiro-runtime (release)

# 6. Run
AMIRO_PORT=8787 ./backend/target/release/amiro-backend
```

Then open `http://127.0.0.1:8787`.

If you want the desktop shell as well:

```sh
cargo install tauri-cli --version "^2" --locked
cargo tauri dev
```

### Manual path: macOS

```sh
# 1. Xcode command line tools
xcode-select --install

# 2. Homebrew packages
brew install pkg-config openssl@3

# 3. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# 4. Node 20+ and pnpm
brew install node
corepack enable && corepack prepare pnpm@10.2.1 --activate

# 5. Build and run, same as Linux
git clone https://github.com/vallabha717/Amiro.git
cd Amiro
pnpm install
pnpm build
scripts/build-native.sh
./backend/target/release/amiro-backend
```

### WSL2

Everything in the Ubuntu section applies. Two WSL-specific notes:

- Build inside the Linux filesystem (`~/Amiro`), not under `/mnt/c/...`. Rust and
  pnpm builds across the Windows bind mount are dramatically slower.
- For the desktop shell you need WSLg (Windows 11) or an X server. If you are not
  using the shell, skip the Tauri CLI entirely and use the headless path below.

### Headless server (no display)

This is the common case for a VM, and it needs no GUI packages at all. Skip the
Tauri CLI and the WebKitGTK packages, then:

```sh
pnpm install
pnpm build
scripts/build-native.sh

# Serve UI + API on all interfaces
AMIRO_HOST=0.0.0.0 AMIRO_PORT=8787 \
AMIRO_HOME=/srv/amiro \
./backend/target/release/amiro-backend
```

To reach it from your laptop safely, keep it bound to loopback and forward the
port over SSH instead of exposing it:

```sh
# On the VM
AMIRO_PORT=8787 ./backend/target/release/amiro-backend

# On your laptop
ssh -N -L 8787:127.0.0.1:8787 user@your-vm
# then browse http://127.0.0.1:8787
```

If you put a reverse proxy in front of it, terminate TLS at the proxy and keep the
backend on `127.0.0.1`. The backend rejects arbitrary cross-origin browser
requests, and `AMIRO_ALLOWED_ORIGIN` and `AMIRO_TOKEN` control what it trusts.

### First sign-in

There is **no default password**. On first boot Amiro generates one:

```sh
cat "$AMIRO_HOME/admin-initial-password"     # default: ~/.amiro/admin-initial-password
```

That file is a mode-`0600` JSON object with `email` (default `admin@local`) and
`password`. Sign in with both, then change the password from the UI. Registration
is closed by default, and an existing insecure default admin account is refused at
startup rather than silently reset.

Provider credentials are connected from the admin providers page, or with the
`/login` composer command. Keys and authorization codes are never submitted as
ordinary chat messages.

---

## Running Amiro

**Native backend, serving UI and API (recommended).**

```sh
AMIRO_PORT=8787 ./backend/target/release/amiro-backend
# or, for the debug build used by the acceptance script:
cargo build --manifest-path backend/Cargo.toml --bin amiro-backend
```

**Tauri desktop development.**

```sh
cargo tauri dev
```

`tauri.conf.json`'s `beforeDevCommand` stages the sidecars via
`src-tauri/build-sidecar.sh` and starts `pnpm dev -p 3210`, then opens the window
against that dev server.

**Full native acceptance run, in a browser, with no real provider called.**

```sh
pnpm build
cargo build --manifest-path backend/Cargo.toml --bin amiro-backend
cargo build --manifest-path runtime/Cargo.toml --bin amiro-runtime
scripts/start-native-ui-check.sh
```

This starts a local OpenAI-compatible stub provider, the owned runtime bridge, and
the backend serving the built UI, then drives real browser checks against it and
tears everything down on exit.

---

## Configuration

Every value below has a working default. Set only what you need.

| Variable | Default | Meaning |
|---|---|---|
| `AMIRO_HOME` | `~/.amiro` | Application home: users, threads, stores, workspace, generated admin password |
| `AMIRO_RUNTIME_HOME` | `$AMIRO_HOME/runtime` | Runtime home: memory, sessions, runtime credential layout |
| `AMIRO_HOST` | `127.0.0.1` | Bind address |
| `AMIRO_PORT` | `8787` | Bind port |
| `AMIRO_OUT_DIR` | `./out` | Directory of the static export to serve |
| `AMIRO_API_SOCKET` | `$AMIRO_RUNTIME_HOME/amiro-api.sock` | Unix socket the backend uses to reach the runtime bridge |
| `AMIRO_RUNTIME_BIN` | auto-detected | Path to `amiro-runtime`. An explicit value that is unusable fails loudly instead of quietly picking another engine |
| `AMIRO_RUNTIME_DIR` | `$AMIRO_RUNTIME_HOME/run` | Directory for the runtime bridge's run files |
| `AMIRO_TOKEN` | empty | Shared sidecar secret. Empty means accept all, which is only safe bound to loopback |
| `AMIRO_ALLOWED_ORIGIN` | unset | Extra permitted browser origin for cross-origin requests |
| `AMIRO_NO_RUNTIME_SPAWN` | unset | `1` makes the backend refuse to start a bridge and require one already running |
| `AMIRO_NO_RUNTIME_KEEPALIVE` | unset | `1` disables the supervisor thread that pings and restarts the runtime |
| `AMIRO_NO_SCHEDULER` | unset | `1` disables the schedule ticker for this process |
| `AMIRO_SEED_ADMIN` | on when the user store is empty | Seeds the first admin account on boot. Set `0` to disable seeding entirely |
| `AMIRO_ALLOW_REGISTRATION` | `0` | `1` opens sign-up |
| `AMIRO_ALLOW_INSECURE_ADMIN` | unset | `1` accepts a pre-existing insecure `admin@local` account that still uses the old default password. Development only, never on a reachable host |
| `AMIRO_ENABLE_SKILL_GENERATION` | `0` | `1` re-enables legacy skill generation, off by default |
| `AMIRO_SESSION_TTL_DAYS` | unset | Session lifetime in days |
| `AMIRO_DEFAULT_MODEL` | unset | `provider:model` used when a request omits a model. Also makes that group sort first |
| `AMIRO_PINNED_MODELS` | unset | Hard allow-list of models. When set, anything else is rejected |
| `AMIRO_BROWSE_ROOTS` | `/root,/home,/srv,/opt,/var/www,/tmp` | Absolute roots the server-side folder picker may browse |
| `AMIRO_WORKSPACE_ROOT` | `$AMIRO_HOME/workspace` | Default workspace root for file, edit, search, and git tools |
| `AMIRO_TRUSTED_OPERATOR` | unset | `1`, together with `AMIRO_TOOL_PROFILE=full`, is required to enable tools |
| `AMIRO_TOOL_PROFILE` | unset | `none`, `minimal`, or `full`. Tools stay disabled unless this and the flag above are both set |
| `AMIRO_NO_TELEMETRY` | unset | `1` disables runtime telemetry |
| `NEXT_PUBLIC_BACKEND_URL` | unset | Frontend-only dev: backend base URL |
| `NEXT_PUBLIC_BACKEND_TOKEN` | unset | Frontend-only dev: must match `AMIRO_TOKEN` |

A provider's API keys are never set here. They are stored by the runtime in its
real on-disk credential layout, through the runtime's own login path.

---

## The `amiro` CLI

`bin/amiro` is a delegation shim, not an engine. It resolves an engine binary and
then `exec`s it with your arguments untouched, rewriting and filtering nothing. It
tries, in order:

1. `AMIRO_RUNTIME_BIN`, which fails loudly if set and unusable
2. `amiro-runtime` next to the CLI, for a packaged install
3. `runtime/target/release/amiro-runtime`, then `runtime/target/debug/amiro-runtime`
4. a compatibility engine on `PATH` (`AMIRO_JCODE_BIN`, `JCODE_BIN`, or the
   upstream engine name), which is a separately installed program Amiro does not ship

`amiro --help` and `amiro --version` are answered locally and both name the engine
and the source it resolved, so the output never implies an engine Amiro does not
ship. A packaged install stages the owned runtime as the native `amiro` binary, so
the shim is not present there.

---

## Testing and verification

```sh
# Frontend
pnpm test            # vitest, 427 tests across 40 files
pnpm check-types     # tsc --noEmit
pnpm lint            # biome
pnpm check           # lint:fix, then check-types, then test

# Rust backend (integration tests spawn a real backend and drive real HTTP)
cargo test --manifest-path backend/Cargo.toml

# Rust runtime, the same check CI runs
pnpm runtime:check

# Retired adapter contract tests
node --test adapter/test/*.test.mjs

# Browser acceptance: stub provider, real runtime, real UI
pnpm build && scripts/start-native-ui-check.sh
node scripts/verify-schedules-ui.mjs
node scripts/verify-agent-color-sync.mjs
```

The backend integration tests start real servers. They are reliable run serially
and can be flaky when run concurrently with a full frontend test run on a small
machine, because each test spawns its own server and waits for readiness. Prefer:

```sh
cargo test --manifest-path backend/Cargo.toml -- --test-threads=1
```

The former Go test harness under `tests/` is retired and kept for reference only.

---

## What works today, and what does not

This project is deliberately explicit about the difference, because fabricated
success is worse than an honest error.

**Works**

- Text chat, streaming, history, titles, archives, export, uploads.
- Full provider connection: OAuth, device code, API key, local endpoints.
- The model catalog, including distinguishing a live listing from the runtime's
  static fallback.
- Agent identity, personality, skills, memory inspection, workspace browsing.
- Schedules end to end, including DST-correct timezone handling and run history.
- The Tauri desktop shell, with the Rust backend and Rust runtime as sidecars.

**Not enabled, and returns explicit unsupported errors rather than pretending**

- Tool execution, unless a trusted local operator sets both `AMIRO_TRUSTED_OPERATOR=1`
  and `AMIRO_TOOL_PROFILE=full`. The deployed default enables no tools at all.
- Per-action permission prompts. The runtime's api-bridge does not advertise the
  `permissions` capability, so a client waiting for a prompt would wait forever.
- MCP tool execution and authorization.
- Checkpoint restore.
- Legacy skill generation.
- Remote URL ingestion for uploads.

**Removed outright**

- The Go backend, replaced by the Rust backend.
- The user-authored workflow feature and the chat's Workflow View, including the
  `@xyflow/react` dependency. The chat no longer renders a graph.

**Known gaps**

- Signed installers, notarisation, and an update feed are release-pipeline work
  that is not done. Development builds work.
- The setup is single-operator. Provider credentials are shared operator
  credentials, and this is not an isolated multi-tenant BYOK service. Adding
  untrusted users needs per-user credential and daemon isolation first.
- The restrictions above are a **policy, not an OS sandbox**. Do not treat a
  passing web preview as proof of isolation.

---

## Project layout

```
.
├── src/                     # Next.js app, statically exported by Tauri and the backend
├── backend/                 # Native Rust backend (axum): auth, threads, schedules, providers
│   └── tests/               # Integration tests that boot a real backend over HTTP
├── runtime/                 # Vendored Amiro-owned Rust runtime workspace (MIT, provenance kept)
├── src-tauri/               # Tauri 2 shell: sidecar staging and lifecycle, window, bundler config
│   └── SIDECAR-LIMITATIONS.md
├── adapter/                 # RETIRED Node compatibility harness, contract tests only
├── bin/amiro                # CLI shim, delegates to the runtime engine
├── scripts/                 # setup-vm.sh, build-native.sh, acceptance and verification scripts
├── tests/                   # Retired Go harness, Rust contract checks, fixtures, cassettes
├── docs/                    # Living docs, starting with AMIRO-RUNTIME.md
├── messages/                # next-intl translations
└── out/                     # Build output, gitignored
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `backend/target/.../amiro-backend` missing | Run `scripts/build-native.sh` |
| `Amiro runtime executable not found` | Build the runtime with `scripts/build-native.sh`, or point `AMIRO_RUNTIME_BIN` at an `amiro-runtime` |
| `backend exited before readiness` in tests | Resource contention, not a code fault. Re-run with `--test-threads=1` |
| `libwebkit2gtk` / GTK errors under `cargo tauri dev` | Install the WebKitGTK and GTK dev packages listed under [Ubuntu](#manual-path-ubuntu--debian). On a headless VM, skip the desktop shell |
| `command not found: pnpm` | `corepack enable && corepack prepare pnpm@10.2.1 --activate` |
| `error: linker 'cc' not found` | Install `build-essential` |
| Port already in use | `AMIRO_PORT=8790 ./backend/target/release/amiro-backend` |
| 401 from the app in frontend-only dev | `NEXT_PUBLIC_BACKEND_TOKEN` must match the backend's `AMIRO_TOKEN` |
| Sign-in works but no providers are listed | The runtime has no connected providers yet. Connect one from the admin providers page |
| Models you expect are missing | The catalog falls back to the runtime's static list when a live refresh fails. Check the runtime's stderr, or reconnect the provider |
| Two backends fighting over schedules | Expected to be prevented by the advisory lock in `$AMIRO_HOME/scheduler.lock`. Only the lock holder serves schedule mutations |

---

## Documentation

The living documents, worth reading in this order:

| Document | Contents |
|---|---|
| [`docs/AMIRO-RUNTIME.md`](docs/AMIRO-RUNTIME.md) | The source of truth: architecture, login model, providers, models, restrictions |
| [`docs/VM-SETUP.md`](docs/VM-SETUP.md) | Full setup walkthrough, including WSL2 and headless |
| [`docs/SCHEDULES.md`](docs/SCHEDULES.md) | Schedules user guide and daemon behaviour |
| [`docs/AGENT.md`](docs/AGENT.md) | The Agent surfaces and how persona is delivered to the model |
| [`docs/RUST-RUNTIME.md`](docs/RUST-RUNTIME.md) | The vendored runtime: provenance, crates, build |
| [`docs/skills/README.md`](docs/skills/README.md) | Skill discovery, activation, authoring, and safety |
| [`docs/testing/README.md`](docs/testing/README.md) | The test architecture, config, artifacts, and CI |
| [`src-tauri/SIDECAR-LIMITATIONS.md`](src-tauri/SIDECAR-LIMITATIONS.md) | Desktop packaging status, honestly |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | Attribution for the vendored runtime and agent artwork |

Everything else under `docs/`, including every `progress/` and `phases/`
directory, is design history. Treat those as a record of what was decided, not as
a description of what runs today.

---

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full
guide. The short version:

1. Branch from `main`.
2. Keep the project's honesty rule: never report success you did not observe.
   Unsupported paths must return an explicit error rather than a plausible result.
3. Run the checks before opening a pull request:

   ```sh
   pnpm check-types
   pnpm lint
   pnpm test
   cargo test --manifest-path backend/Cargo.toml
   ```

4. Describe what you actually ran and what you observed.

---

## Security

Report vulnerabilities privately through GitHub security advisories rather than in
a public issue. See [`SECURITY.md`](SECURITY.md).

Two things to internalise before deploying this anywhere shared:

- **The preview restrictions are a policy, not an OS sandbox.** Tools being off is
  a configuration decision made by the backend, not a kernel-enforced boundary.
- **Provider credentials are shared operator credentials.** This is a
  single-operator design today. It is not multi-tenant.

---

## License and acknowledgements

Amiro is [MIT licensed](LICENSE).

It stands on other people's work, and that is attributed in full in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md):

- **Jcode** by Jeremy Huang. `runtime/` is a modified source fork, MIT licensed,
  pinned to an immutable upstream commit, with the original notice retained in
  [`runtime/LICENSE`](runtime/LICENSE). Product names, crate names, and state paths
  are adapted for Amiro. Upstream endorsement is not implied.
- **CopilotKit/OpenDots** by Atai Barkai (MIT). The Agent avatar sprites in
  `public/agent/opendots/` are copied verbatim and tinted at runtime.
- **Vellum Assistant**, an architectural reference. No code, geometry, or brand
  asset is copied into this repository.
