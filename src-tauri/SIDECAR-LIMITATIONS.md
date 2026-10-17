# Amiro Backend Sidecar Launcher: Packaging Limitations

The desktop backend is `adapter/src/server.mjs` (a Node >=22 HTTP server that
serves the Next static export and bridges to the Amiro runtime daemon).

Tauri's `bundle.externalBin` slot (`"binaries/backend"`, read at runtime via
`app.shell().sidecar("backend")`) requires a native executable. A Node script
is not one, so `src-tauri/build-sidecar.sh` writes a small executable launcher
into that slot:

```sh
#!/usr/bin/env bash
exec "<absolute node path>" "<absolute repo>/adapter/src/server.mjs" "$@"
```

`src-tauri/src/lib.rs` spawns that sidecar, sets `AMIRO_PORT` to an ephemeral
`127.0.0.1:0` reservation and `AMIRO_TOKEN` to a per-launch random secret, then
injects the same port/token into the webview (`__BACKEND_PORT__` /
`__BACKEND_TOKEN__`).

## What works

- `tauri dev` and running a built app **from inside this checkout**, on
  Linux/macOS, with `node` on `PATH` and `adapter/node_modules` installed
  (`pnpm --dir adapter install`).
- The adapter itself, standalone, via `pnpm start` / `scripts/dev-backend.sh`.

## What does not (honest limitations, not TODOs)

1. **The launcher bakes in absolute paths** to the local `node` binary and to
   `adapter/src/server.mjs`. Those paths exist on the machine that generated
   the launcher; they do not exist on an end user's machine.
2. **`node` must be on `PATH` at launch.** There is no bundled Node runtime.
3. **Windows is unsupported by `build-sidecar.sh`.** Tauri's `externalBin`
   needs a real `.exe` there, and a batch file cannot occupy that slot.
   `build-sidecar.ps1` therefore fails with an explicit message instead of
   writing an `.exe` that cannot run.
4. **Self-contained distribution story** for the backend: distributing a desktop
   package requires bundling the runtime or single-executable packaging.

## What a distributable build needs (follow-up)

Any one of:

- Package the adapter as a **Node SEA / single executable** and ship that as
  the sidecar.
- Bundle a Node runtime and add it to `externalBin`.
- Ship a tiny native launcher (Rust/C) that locates a bundled Node and the
  adapter resources.

Until then, desktop packaging is a development-only capability. This is the
honest status of the Node adapter packaging and is recorded here rather than
silently degraded.
