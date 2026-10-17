# Amiro VM setup

Set up Amiro on a brand new VM or fresh machine. For the one-command version, see Fast path. For full control, see Manual setup.

## Contents

- [Fast path](#fast-path-one-command)
- [Prerequisites](#prerequisites)
- [Manual setup, step by step](#manual-setup-step-by-step)
- [Linux](#linux-notes)
- [macOS](#macos-notes)
- [WSL2](#wsl2-notes)
- [Headless servers](#headless-servers-no-display)
- [Environment variables](#environment-variables)
- [First sign in](#first-sign-in-admin-password)
- [Starting the app](#starting-the-app)
- [Running the test suites](#running-the-test-suites)
- [Troubleshooting](#troubleshooting)

## Fast path (one command)

```sh
git clone https://github.com/vallabha717/Amiro.git Amiro
cd Amiro
./scripts/setup-vm.sh
```

That script is idempotent, so re-running it is safe. It skips anything already installed. Useful variants:

```sh
./scripts/setup-vm.sh --help            # list flags
./scripts/setup-vm.sh --yes             # non-interactive, answer yes to prompts
./scripts/setup-vm.sh --skip-desktop    # headless server, skip webkit/GTK GUI libraries
./scripts/setup-vm.sh --skip-native     # skip Rust builds (run scripts/build-native.sh later)
./scripts/setup-vm.sh --skip-frontend   # skip pnpm build (no out/ export yet)
```

What the script does, in order:

1. Detects the OS and package manager. Supports Ubuntu/Debian (`apt`) and macOS (`brew`).
2. Installs OS prerequisites (asks first, unless `--yes`). On Debian/Ubuntu it uses `sudo apt-get` only for this step, and it prints the exact privileged command before running it.
3. Installs Rust with rustup when `cargo` is missing.
4. Checks for Node 20 or newer (the adapter in `adapter/src/server.mjs` and `adapter/package.json` wants Node 22 or newer). When Node is missing it uses `nvm` if present, and otherwise prints install instructions instead of forcing an arbitrary Node on you.
5. Enables `corepack` and activates `pnpm 10.2.1`, matching the `packageManager` field in `package.json`.
6. Runs `pnpm install` and `pnpm --dir adapter install`.
7. Calls `scripts/build-native.sh` (the owned build script, not duplicated logic). That builds `backend/target/release/amiro-backend` and `runtime/target/release/amiro-runtime`.
8. Runs `pnpm build`, which writes the static export to `out/` (`out/index.html` is the marker file the backend and adapter both look for).
9. Prints a colored summary with what was installed, where the binaries landed, and the exact next commands.

## Prerequisites

| Tool | Minimum version | Why Amiro needs it |
|------|-----------------|--------------------|
| git | any recent | clone the repo and record build metadata |
| curl | any recent | rustup install, health checks in `scripts/start-native-ui-check.sh` |
| Rust toolchain (`cargo`, `rustc`) | 1.89 or newer (verified: 1.88 is refused, 1.89 builds) | builds `backend/` (`amiro-backend`, axum) and `runtime/` (`amiro-runtime`) |
| Node.js | 20 minimum, 22 recommended | `adapter/src/server.mjs` is a plain Node HTTP server, `adapter/package.json` sets `engines.node >= 22`, and `next.config.ts` uses `import.meta.dirname` (needs Node 20.11 plus) |
| pnpm | 10.2.1 exactly | `package.json` sets `packageManager` to `pnpm@10.2.1` |
| C build tools (`build-essential`, `pkg-config`, `libssl-dev`) | distro packages | link the Rust binaries |
| Tauri desktop GUI libraries (Linux) | distro packages, see list below | only for `cargo tauri dev` and `tauri build`, not for the backend or web UI |
| Xcode command line tools (macOS) | current | compiling Rust and Tauri on macOS |

Debian/Ubuntu GUI libraries installed by the script (skipped with `--skip-desktop`): `libxdo-dev`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

Script names below are verified against `ls scripts/`: `setup-vm.sh`, `build-native.sh`, `build-ui.sh`, `dev-backend.sh`, `dev-backend.ps1`, `start-local.sh`, `start-native-ui-check.sh`, `serve-prod.mjs`. Script commands in `package.json` used here: `build` (`next build`), `dev` (`next dev`), `adapter` (`node adapter/src/server.mjs`), `native:build` (`bash scripts/build-native.sh`), `native:dev` (`cargo run --manifest-path backend/Cargo.toml --bin amiro-backend`), `native:test` (`cargo test --manifest-path backend/Cargo.toml`), `runtime:check`, `test` (`vitest run`), `test:e2e` (`playwright test`), `verify:native-ui` (`bash scripts/start-native-ui-check.sh`).

## Manual setup, step by step

Do this if you want to understand or control each stage. The bootstrap script automates the same steps.

### 1. Clone the repo

```sh
git clone https://github.com/vallabha717/Amiro.git Amiro
cd Amiro
```

### 2. Install OS prerequisites

Debian/Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev curl git wget file \
  libxdo-dev libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Leave out the second line (the webkit/GTK set) on a headless server. You only need those for the Tauri desktop shell.

macOS:

```sh
xcode-select --install
brew install pkg-config openssl curl git wget file
```

### 3. Install Rust

Skip this if `cargo --version` already works.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version
```

### 4. Install Node (20 plus, 22 recommended) and pnpm 10.2.1

With `nvm` present:

```sh
nvm install 22
nvm use 22
corepack enable
corepack prepare pnpm@10.2.1 --activate
pnpm --version   # expect 10.2.1
```

Without `nvm`, install the Node LTS release from https://nodejs.org (or `brew install node@22` on macOS), then run the two `corepack` lines above.

### 5. Install JS dependencies

```sh
pnpm install
pnpm --dir adapter install
```

The second line installs the adapter's own dependency (`@1jehuang/jcode-sdk`). `scripts/dev-backend.sh` refuses to start without `adapter/node_modules/@1jehuang/jcode-sdk`.

### 6. Build the native binaries

This calls the owned build script, which compiles the Rust HTTP backend and the in-repo Rust agent runtime:

```sh
bash scripts/build-native.sh
```

Results:

- `backend/target/release/amiro-backend` (the `amiro-backend` binary, axum, serves both the static UI and the API, spawns the runtime bridge)
- `runtime/target/release/amiro-runtime` (the `amiro-runtime` coding agent engine)

Debug builds go to `backend/target/debug/amiro-backend` and `runtime/target/debug/amiro-runtime` with `bash scripts/build-native.sh --debug`. The browser check `scripts/start-native-ui-check.sh` defaults to those debug paths. `bin/amiro` is a shim that delegates to the runtime engine, it resolves `AMIRO_RUNTIME_BIN` first, then `runtime/target/release/amiro-runtime`, then the debug path.

### 7. Build the frontend

```sh
pnpm build
```

This writes the statically exported Next.js site to `out/` (`out/index.html` must exist). The native backend serves that directory (override with `AMIRO_OUT_DIR`). You can also build through the wrapper `bash scripts/build-ui.sh`, which runs `pnpm build` and then reports the file count, or verify an existing export with `bash scripts/build-ui.sh --check`.

## Linux notes

Ubuntu/Debian is the primary target. The `apt` step is the only one that uses `sudo`, and `scripts/setup-vm.sh` prints the exact command and asks before running it. If you run as root (typical on a fresh VM), no `sudo` prefix is used.

`cargo tauri dev` needs the full webkit/GTK set. The backend, the adapter, and `pnpm build` do not.

## macOS notes

Install the Xcode command line tools first (`xcode-select --install`, it opens an Apple prompt). Then `brew install pkg-config openssl curl git wget file`. The setup script does the Xcode check, then installs brew packages only when `brew` exists, and otherwise tells you where to get it.

## WSL2 notes

Treat WSL2 as Ubuntu. Run everything inside the Linux distro, not from Windows:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev curl git wget file
./scripts/setup-vm.sh --skip-desktop
```

Keep the checkout on the Linux filesystem (for example `~/Amiro`), not under `/mnt/c`, or Rust and Next.js builds get very slow. The app binds to `127.0.0.1` by default, which is reachable from Windows browsers on the same machine through WSL2 localhost forwarding. No display is needed for the backend path. Only install the GUI libraries and run `cargo tauri dev` if you have a Wayland/X setup you trust.

## Headless servers (no display)

Build without desktop libraries and run only the backend:

```sh
./scripts/setup-vm.sh --skip-desktop --yes
./backend/target/release/amiro-backend
```

The backend listens on `127.0.0.1:8787` by default (`AMIRO_HOST` and `AMIRO_PORT`). Keep it on loopback and reach it over an SSH tunnel from your laptop:

```sh
ssh -L 8787:127.0.0.1:8787 you@your-server
```

Then open http://127.0.0.1:8787 locally and sign in as `admin@local` with the generated password (see First sign in). Never bind `AMIRO_HOST=0.0.0.0` without a real auth and TLS story in front of it. The admin account starts with a generated password, registration is closed by default, and sign-in is rate limited, but the preview policy is still meant for a trusted operator.

On the server, `AMIRO_HOME` defaults to `~/.amiro`, so the admin password file is at `~/.amiro/admin-initial-password`.

## Environment variables

| Variable | Default | What it does |
|----------|---------|--------------|
| `AMIRO_HOME` | `~/.amiro` (native backend, `backend/src/state.rs`), `~/.amiro-dev` under `scripts/dev-backend.sh` | Application data home: `store/`, `users.json`, `threads.json`, `workspace/`, `admin-initial-password` |
| `AMIRO_HOST` | `127.0.0.1` (`backend/src/main.rs`) | Interface the native backend binds to |
| `AMIRO_PORT` | `8787` (`backend/src/main.rs`) | Port for the backend HTTP listener and the served UI. `scripts/dev-backend.sh` and `scripts/start-local.sh` use the same default |
| `AMIRO_API_SOCKET` | `<runtime home>/amiro-api.sock` (`backend/src/state.rs`) | Unix socket the backend uses to talk to the runtime bridge. The adapter default in `scripts/dev-backend.sh` is `$HOME/.jcode/scratch/amiro-api.sock`, with the pre-rename `JCODE_API_SOCKET` still read as a fallback |
| `AMIRO_RUNTIME_HOME` | `<AMIRO_HOME>/runtime` (`backend/src/state.rs`) | The engine's own home, separate from the app data in `AMIRO_HOME`. See `docs/AMIRO-RUNTIME.md` for the app home versus engine home split |
| `AMIRO_RUNTIME_BIN` | resolved in this order: explicit value, sidecar next to the backend executable, `runtime/target/release/amiro-runtime`, `runtime/target/debug/amiro-runtime` (`backend/src/state.rs`, same order documented in `bin/amiro`) | Which runtime engine binary the backend spawns and the `bin/amiro` shim delegates to. Set this when you keep the engine somewhere custom |
| `NEXT_PUBLIC_BACKEND_URL` | `http://127.0.0.1:8787` (`src/lib/backend/config.ts`) | Backend URL the frontend talks to. Must match `AMIRO_PORT` and `AMIRO_HOST` when you move the backend |
| `NEXT_PUBLIC_BACKEND_TOKEN` | empty (`src/lib/backend/config.ts`) | Shared secret the frontend sends. The dev adapter (`scripts/dev-backend.sh`, `AMIRO_TOKEN` empty) accepts all sidecar requests and logs a warning. Set a value in both places to exercise the shared-secret path |

Two behavior flags worth knowing:

- `AMIRO_NO_RUNTIME_SPAWN=1` means the backend will not start a bridge (`backend/src/runtime.rs`). Use it when you supervise the runtime yourself. Without it, the backend spawns the engine from `AMIRO_RUNTIME_BIN` on demand and keeps it alive.
- `AMIRO_ALLOW_REGISTRATION=1` opens registration. Default is closed: once the first user exists, new signups are refused (`backend/src/auth.rs`). `AMIRO_SEED_ADMIN` controls seeding the initial admin account.

## First sign in (admin password)

On first start the backend generates the owner password into `$AMIRO_HOME/admin-initial-password`, a mode `0600` JSON file shaped like `{"email":"admin@local","password":"...","createdAt":"..."}`. There is no default password.

```sh
cat ~/.amiro/admin-initial-password
```

Sign in with email `admin@local` and the generated password. Registration is closed by default, so that file is the only way in on a fresh home. Do not publish it. You can change the password later with `PUT /api/user/password` (the UI profile flow uses the same route).

If `AMIRO_HOME` is overridden, read the file under that directory instead. `scripts/dev-backend.sh` defaults `AMIRO_HOME` to `~/.amiro-dev`, so its password file is `~/.amiro-dev/admin-initial-password`.

## Starting the app

The native backend is the product. It serves the static export and the API from
one listener and starts the runtime bridge itself.

Native backend (serves `out/` and spawns the runtime bridge itself):

```sh
./backend/target/release/amiro-backend
# open http://127.0.0.1:8787
```

Dev loop with the retired Node adapter plus Next.js (`scripts/start-local.sh`, backend on 8787, frontend on 3210). The adapter is kept for contract tests and comparison, not shipped, so prefer the native backend above unless you are working on the adapter itself:

```sh
./scripts/start-local.sh            # build, then serve production static bundle
./scripts/start-local.sh --dev      # Next.js dev server with Turbopack hot reloading
./scripts/start-local.sh --no-build # reuse the existing out/ build
```

Pieces by hand:

```sh
./scripts/dev-backend.sh   # Node adapter on $AMIRO_PORT (default 8787)
pnpm dev -p 3210           # Next.js dev server
```

Desktop shell (needs the GUI libraries):

```sh
cargo tauri dev
```

Runtime CLI shim (delegates to the engine, try `./bin/amiro --help` for the resolution order):

```sh
./bin/amiro --version
```

## Running the test suites

| Suite | Command | Notes |
|-------|---------|-------|
| Frontend unit (vitest) | `pnpm test` | `vitest run` from `package.json` |
| Adapter unit | `node --test adapter/test/*.test.mjs` | Node test runner over `adapter/test/`, includes `runtime-env.test.mjs` and `workspace-listing.test.mjs` |
| Native backend (cargo) | `cargo test --manifest-path backend/Cargo.toml` | same as `pnpm native:test` |
| Runtime check | `cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features` | same as `pnpm runtime:check` |
| Native UI browser check | `pnpm verify:native-ui` | runs `scripts/start-native-ui-check.sh`: stub provider plus owned bridge plus native backend from `out/`, then `scripts/verify-native-ui.mjs` in a browser. Needs `out/index.html` and a debug native build (`scripts/build-native.sh --debug`) |
| End to end (Playwright) | `pnpm test:e2e` | Playwright specs, `tests/` is its own package (`tests/package.json`), install browsers with `pnpm --dir tests install-browsers` |
| Rust testkit | `cargo test --offline` run inside `tests/rust` | std-only offline harness, see `tests/README.md` and `tests/Taskfile.yml` |
| Tauri shell check | `cargo check --offline` run inside `src-tauri` | desktop shell only |

Adapter live probes in `adapter/tests/` (`probe-routes.mjs`, `integration.mjs`, `password.mjs`, and friends) and `node adapter/test/live-smoke.mjs` need a running backend with real credentials, so they are not part of a fresh checkout pass.

## Troubleshooting

Missing GTK or webkit packages (Linux, `cargo tauri dev` fails on `webkit2gtk`, `gtk`, `soup`, `javascriptcoregtk`, `appindicator`, or `rsvg`):

```sh
sudo apt-get install -y libxdo-dev libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Re-run `./scripts/setup-vm.sh` afterwards, it installs only what is still missing. On a headless box, skip this entirely with `--skip-desktop`.

`pnpm` not found after setup:

```sh
corepack enable
corepack prepare pnpm@10.2.1 --activate
pnpm --version
```

If `corepack enable` fails on permissions, the setup script retries it explicitly with `sudo corepack enable` and prints that command first.

`cargo` or `rustc` not found:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version
```

New shells need that `PATH` line in `~/.bashrc` (or the equivalent for your shell). The rustup installer normally adds it, but non-login shells skip it.

Port conflicts (`address in use` on 8787, or `scripts/start-local.sh` refusing on 8787 or 3210):

```sh
ss -ltnp | grep -E '8787|3210'
AMIRO_PORT=8887 FRONTEND_PORT=3310 ./scripts/start-local.sh
```

`start-local.sh` never kills anything it did not start, it stops and tells you. Move with `AMIRO_PORT` and `FRONTEND_PORT`, or stop the other process yourself. If you move the backend port, set `NEXT_PUBLIC_BACKEND_URL` to match (see Environment variables).

`runtime executable not found` (backend log names the path and suggests `AMIRO_RUNTIME_BIN`):

```sh
bash scripts/build-native.sh
ls -l backend/target/release/amiro-backend runtime/target/release/amiro-runtime
```

Or point at a custom engine location:

```sh
export AMIRO_RUNTIME_BIN=/path/to/amiro-runtime
```

The same resolution order applies to `./bin/amiro`, which prints the engine it resolved with `./bin/amiro --version`.

`AMIRO_NO_RUNTIME_SPAWN=1` means the backend will not start a bridge. With that flag set, chat turns have no engine behind them unless you supervise the runtime yourself (for example `amiro-runtime` with an `api-bridge` socket at `AMIRO_API_SOCKET`). If turns fail right after you set that flag, unset it or start the bridge yourself.

Adapter refuses to start (`adapter dependencies are not installed`):

```sh
pnpm --dir adapter install
./scripts/dev-backend.sh
```

Backend serves an empty page or warns `out dir missing`: run `pnpm build` (or `bash scripts/build-ui.sh`) and check `out/index.html` exists. Override the served directory with `AMIRO_OUT_DIR` if you keep the export elsewhere.
