#!/usr/bin/env bash
# Independent local test server for feat/channels-contacts worktree: isolated state, port 3004, serves ./out.
set -e
cd "$(dirname "$0")"
STATE=/tmp/amiro-agent-feat-channels-contacts
mkdir -p "$STATE/run"
export AMIRO_HOME="$STATE"
export AMIRO_RUNTIME_HOME="$STATE/rt"
export AMIRO_API_SOCKET="$STATE/run/api.sock"
export AMIRO_RUNTIME_BIN=/home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/src-tauri/binaries/runtime-x86_64-unknown-linux-gnu
export AMIRO_OUT_DIR="$PWD/out"
export AMIRO_HOST=0.0.0.0
export AMIRO_PORT=3004
export AMIRO_ALLOWED_ORIGIN='*'
exec /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro-channels-contacts/backend/target/debug/amiro-backend
