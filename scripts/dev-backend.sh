#!/usr/bin/env bash
# Starts the Amiro Node adapter (adapter/src/server.mjs) for standalone
# frontend dev/testing (pnpm dev / pnpm build run outside the real Tauri
# shell). Replaces the old `go run ./cmd/server` backend-go flow.
#
# The adapter is a plain Node (>=22) HTTP server that serves the Next static
# export from out/ and bridges to the live Amiro runtime. Values here must
# match .env.local's NEXT_PUBLIC_BACKEND_URL (http://127.0.0.1:8787);
# NEXT_PUBLIC_BACKEND_TOKEN stays empty in dev, and the adapter accepts all
# requests when AMIRO_TOKEN is empty (it logs a warning).
#
# desktop/ is a standalone project (moved out of better-chatbot/), so every
# path here resolves within its own tree, never a sibling repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"

ADAPTER_ENTRY="$DESKTOP_DIR/adapter/src/server.mjs"

export AMIRO_PORT="${AMIRO_PORT:-8787}"
export AMIRO_HOME="${AMIRO_HOME:-$HOME/.amiro-dev}"
# Empty = accept all sidecar requests (dev only). Matches the frontend's empty
# NEXT_PUBLIC_BACKEND_TOKEN default; set a value in both places to exercise the
# shared-secret path.
export AMIRO_TOKEN="${AMIRO_TOKEN:-}"
# The Amiro runtime's api-bridge socket the adapter talks to. The legacy
# (pre-rename) variable is still honoured, and the default below is the
# runtime engine's real on-disk socket path.
export AMIRO_API_SOCKET="${AMIRO_API_SOCKET:-${JCODE_API_SOCKET:-$HOME/.jcode/scratch/amiro-api.sock}}"
# File/edit/search/git tools only exist when a workspace root is set; the
# adapter defaults it to $AMIRO_HOME/workspace, overridable here. Defaults to
# this repo so the agent can work on itself out of the box.
export AMIRO_WORKSPACE_ROOT="${AMIRO_WORKSPACE_ROOT:-$DESKTOP_DIR}"

if [ ! -f "$ADAPTER_ENTRY" ]; then
  echo "error: adapter not found at $ADAPTER_ENTRY" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH -- the adapter is a Node server." >&2
  exit 1
fi

if [ ! -d "$DESKTOP_DIR/adapter/node_modules/@1jehuang/jcode-sdk" ]; then
  echo "error: adapter dependencies are not installed." >&2
  echo "       run: (cd \"$DESKTOP_DIR/adapter\" && pnpm install)" >&2
  exit 1
fi

mkdir -p "$AMIRO_HOME"

cd "$DESKTOP_DIR"
exec node "$ADAPTER_ENTRY"
