#!/usr/bin/env bash
# Acceptance run for the native Amiro stack, in a browser.
#
# Brings up, under backend/target/ui-check/<timestamp>/ (gitignored):
#   - a local OpenAI-compatible provider stub (scripts/native-stub-provider.py),
#   - the owned Amiro runtime bridge, spawned by the backend itself,
#   - the native backend, serving the built UI from out/,
# then logs in with the generated admin account and runs
# scripts/verify-native-ui.mjs against it.
#
# No real provider is called and no user state is touched. Everything is torn
# down on exit.
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=${AMIRO_UI_CHECK_ROOT:-$REPO_ROOT/backend/target/ui-check/$(date +%s)}
BACKEND_BIN=${AMIRO_BACKEND_BIN:-$REPO_ROOT/backend/target/debug/amiro-backend}
RUNTIME_BIN=${AMIRO_RUNTIME_BIN:-$REPO_ROOT/runtime/target/debug/amiro-runtime}
OUT_DIR=${AMIRO_OUT_DIR:-$REPO_ROOT/out}
STUB_PORT=${STUB_PORT:-38951}
BACKEND_PORT=${BACKEND_PORT:-38952}
SOCKET=$ROOT/run/amiro-api.sock
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # The backend spawns the bridge in its own process group; match only this
  # fixture's socket so nothing else can be hit.
  pkill -f -- "--api-socket $SOCKET" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "native ui check: $*" >&2
  exit 1
}

[ -f "$REPO_ROOT/out/index.html" ] || fail "out/index.html missing; run 'pnpm build' first"
[ -x "$BACKEND_BIN" ] || fail "backend binary missing; run 'cargo build --manifest-path backend/Cargo.toml --bin amiro-backend'"
[ -x "$RUNTIME_BIN" ] || fail "runtime binary missing; run 'cargo build --manifest-path runtime/Cargo.toml --bin amiro-runtime'"

mkdir -p "$ROOT/run" "$ROOT/home/workspace" "$ROOT/runtime-home" "$ROOT/screens"

python3 "$REPO_ROOT/scripts/native-stub-provider.py" "$STUB_PORT" > "$ROOT/stub.log" 2>&1 &
PIDS+=($!)

AMIRO_HOME=$ROOT/home \
AMIRO_RUNTIME_HOME=$ROOT/runtime-home \
AMIRO_RUNTIME_DIR=$ROOT/run \
AMIRO_API_SOCKET=$SOCKET \
AMIRO_RUNTIME_BIN=$RUNTIME_BIN \
AMIRO_NO_TELEMETRY=1 \
AMIRO_OPENAI_COMPAT_API_BASE="http://127.0.0.1:$STUB_PORT/v1" \
OPENAI_COMPAT_API_KEY=stub-key \
AMIRO_OUT_DIR=$OUT_DIR \
AMIRO_PORT=$BACKEND_PORT \
AMIRO_HOST=127.0.0.1 \
AMIRO_OWNER_EMAIL=owner@amiro.test \
AMIRO_OWNER_PASSWORD=native-ui-check-owner-1 \
  "$BACKEND_BIN" > "$ROOT/backend.log" 2>&1 &
PIDS+=($!)

ready=0
for _ in $(seq 1 180); do
  if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null)" = "200" ]; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail "backend did not become healthy; see $ROOT/backend.log"

TOKEN_FILE=$ROOT/token
curl -s -m 60 -H 'Content-Type: application/json' \
  -d '{"email":"owner@amiro.test","password":"native-ui-check-owner-1"}' \
  "http://127.0.0.1:$BACKEND_PORT/api/auth/login" |
  sed -E 's/.*"token":"([^"]+)".*/\1/' > "$TOKEN_FILE"
[ "$(wc -c < "$TOKEN_FILE")" -gt 10 ] || fail "login did not return a session token"

echo "native ui check: http://127.0.0.1:$BACKEND_PORT (fixture: $ROOT)"
AMIRO_UI_URL="http://127.0.0.1:$BACKEND_PORT" \
AMIRO_UI_TOKEN_FILE=$TOKEN_FILE \
AMIRO_UI_SHOT_DIR=$ROOT/screens \
  node "$REPO_ROOT/scripts/verify-native-ui.mjs"
status=$?
exit $status
