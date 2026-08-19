---
name: local-dev-vm
description: Start the Go backend and the Next.js frontend directly in this VM, without Tauri, so the app can be opened and tested in a regular browser. Use when asked to run, start, or test the app locally/in the VM/without Tauri.
---

# Running locally without Tauri

A unified startup script `./scripts/start-local.sh` starts both the Go backend (port 8787) and the Next.js frontend (port 3210) from the repo root (`/home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro`).

## Commands

### 1. Production Mode (Fastest, Recommended for Testing)
Builds the static export and serves it via a lightweight static server. Best when testing performance or avoiding on-demand compilation delays:
```bash
./scripts/start-local.sh --build
```
*(Or `./scripts/start-local.sh --no-build` to skip rebuilding if `out/` is already fresh).*

### 2. Development Mode (Hot-Reloading)
Runs the Next.js dev server with Turbopack for live code reloading on edits:
```bash
./scripts/start-local.sh --dev
```

## How It Works

1. **Backend** (Go sidecar, port 8787):
   - Reads `.env.local`'s token/URL (`AMIRO_PORT=8787`, `AMIRO_AUTH_TOKEN=dev-test-token-1786373638`).
   - Automatically spawned and checked for readiness before frontend starts.

2. **Frontend** (port 3210):
   - `.env.local` points the frontend at `127.0.0.1:8787` with the matching shared token.
   - Accessible at `http://localhost:3210`.

3. **Background Execution**:
   - When running in an agent session, execute with `run_in_background: true` and monitor logs for readiness.

## Notes

- **Port Management**: The script automatically checks and clears ports 8787 and 3210 if previous instances were running.
- **Stopping Servers**: Sending `SIGINT` (Ctrl+C) or stopping the background task gracefully terminates both backend and frontend processes.
