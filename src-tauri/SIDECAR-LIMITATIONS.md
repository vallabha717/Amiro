# Amiro Sidecars: Packaging Status

The desktop backend is now the **owned Rust backend** (`backend/`, binary
`amiro-backend`) and the engine is the **owned Rust runtime** (`runtime/`,
binary `amiro-runtime`). Both are real executables, so Tauri's
`bundle.externalBin` contract is satisfied directly:

```json
"externalBin": ["binaries/backend", "binaries/runtime"]
```

`src-tauri/build-sidecar.sh` (Linux/macOS) and `build-sidecar.ps1` (Windows)
stage both binaries for the host target triple. `src-tauri/src/lib.rs` spawns
the backend sidecar, sets `AMIRO_PORT` to an ephemeral `127.0.0.1:0` reservation
and `AMIRO_TOKEN` to a per-launch random secret, injects the same port/token
into the webview (`__BACKEND_PORT__` / `__BACKEND_TOKEN__`), and passes
`AMIRO_RUNTIME_BIN` when the bundled runtime is found next to the app.

The backend starts the runtime on demand
(`amiro-runtime --no-update api-bridge --api-socket <home>/runtime/amiro-api.sock`),
keeps it alive with protocol pings (the daemon otherwise exits after five idle
minutes) and restarts it if it dies. Runtime state defaults to `~/.amiro`
(`AMIRO_HOME`, with `AMIRO_RUNTIME_HOME`/`AMIRO_RUNTIME_DIR` overrides).

## Native mode (default)

`AMIRO_SIDECAR_MODE` defaults to `native`. Both staging scripts require:

- `backend/target/{release,debug}/amiro-backend` (`cargo build --manifest-path backend/Cargo.toml --bin amiro-backend --release`)
- `runtime/target/{release,debug}/amiro-runtime` (`cargo build --manifest-path runtime/Cargo.toml --bin amiro-runtime --release`)

and fail with that build hint when one is missing, rather than producing a
bundle with no engine.

## What remains

1. **Release builds and code signing.** Development builds work; producing
   signed installers is a release-pipeline task (icons, notarization, update
   feed). Nothing here pretends that is done.
2. **Node adapter fallback.** `AMIRO_SIDECAR_MODE=adapter` still stages the old
   Node launcher for one release of comparison. Its absolute-path limitation is
   documented in the script header; it is not a distributable option and is not
   the default.
3. **First-run state.** `~/.amiro` is created on first launch. Migrating an
   existing `~/.jcode` login into it is left to the runtime's own credential
   inheritance; the backend never copies credentials itself.
