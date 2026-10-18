#!/usr/bin/env bash
# ============================================================================
# desktop-app.sh -- Cross-platform launcher for Amiro Desktop (Linux & macOS).
#
# Launches the native compiled Tauri desktop binary if present, or starts the
# local amiro-backend with AMIRO_DESKTOP=1 on loopback and opens a dedicated
# desktop app window in the user's browser with native notifications enabled.
#
# Usage:
#   scripts/desktop-app.sh [command] [options]
#
# Commands:
#   start             Launch Amiro Desktop (default)
#   stage-sidecars    Stage backend and runtime sidecar binaries
#   build             Build the desktop application package
#   dev               Run desktop development mode
#   status            Check desktop app runtime and process status
#   --help, -h        Print this help message
#
# Options:
#   --port P          Port for fallback server mode (default $AMIRO_PORT or 3000)
#   --no-browser      Do not auto-open the desktop app window
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${AMIRO_DESKTOP_STATE_DIR:-$REPO_ROOT/.amiro-desktop}"
PID_FILE="$STATE_DIR/desktop-backend.pid"
LOG_FILE="$STATE_DIR/desktop-backend.log"
TOKEN_FILE="$STATE_DIR/desktop-token"

PORT="${AMIRO_PORT:-3000}"
NO_BROWSER=0
CMD="${1:-start}"

say()  { printf '%s\n' "$*"; }
err()  { printf 'error: %s\n' "$*" >&2; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,21p' "${BASH_SOURCE[0]}"
}

# Determine target triple
get_target_triple() {
  rustc -Vv 2>/dev/null | awk '/^host:/ {print $2}' || uname -m
}

# Locate compiled native desktop binary
find_native_tauri_binary() {
  local candidates=(
    "$REPO_ROOT/src-tauri/target/release/bundle/macos/Amiro.app/Contents/MacOS/amiro"
    "$REPO_ROOT/src-tauri/target/debug/bundle/macos/Amiro.app/Contents/MacOS/amiro"
    "$REPO_ROOT/src-tauri/target/release/amiro"
    "$REPO_ROOT/src-tauri/target/debug/amiro"
  )
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Locate backend binary
resolve_backend() {
  local candidates=(
    "$REPO_ROOT/backend/target/release/amiro-backend"
    "$REPO_ROOT/backend/target/debug/amiro-backend"
    "$(command -v amiro-backend 2>/dev/null || true)"
  )
  for candidate in "${candidates[@]}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Check if port is in use
is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
}

# Find a free loopback port starting from preferred
find_free_port() {
  local candidate="$1"
  while is_listening "$candidate"; do
    # Check if existing listener is already an Amiro server
    if curl -sf -m 1 "http://127.0.0.1:${candidate}/api/system" >/dev/null 2>&1 || \
       curl -sf -m 1 "http://127.0.0.1:${candidate}/" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  printf '%s\n' "$candidate"
}

# Wait for port to respond
wait_for_server() {
  local port="$1" waited=0
  while [ "$waited" -lt 30 ]; do
    if curl -sf -m 1 "http://127.0.0.1:${port}/api/system" >/dev/null 2>&1 || \
       curl -sf -m 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

ensure_desktop_token() {
  if [ -s "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  local generated
  generated="$(head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')" \
    || generated="$(date +%s%N 2>/dev/null || date +%s)-$$"
  printf '%s\n' "$generated" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  printf '%s\n' "$generated"
}

# Open dedicated desktop app window
launch_desktop_window() {
  local url="$1"
  if [ "$NO_BROWSER" = "1" ]; then
    say "App URL: $url (browser launch suppressed via --no-browser)"
    return 0
  fi

  local os="$(uname -s)"
  if [ "$os" = "Darwin" ]; then
    if [ -d "/Applications/Google Chrome.app" ]; then
      open -na "Google Chrome" --args --app="$url" && return 0
    elif [ -d "/Applications/Brave Browser.app" ]; then
      open -na "Brave Browser" --args --app="$url" && return 0
    elif [ -d "/Applications/Microsoft Edge.app" ]; then
      open -na "Microsoft Edge" --args --app="$url" && return 0
    else
      open "$url" && return 0
    fi
  else
    # Linux browser list with app-mode support
    local browsers=(
      google-chrome
      google-chrome-stable
      chromium
      chromium-browser
      brave-browser
      microsoft-edge
      microsoft-edge-stable
    )
    for b in "${browsers[@]}"; do
      if command -v "$b" >/dev/null 2>&1; then
        nohup "$b" --app="$url" >/dev/null 2>&1 &
        return 0
      fi
    done
    if command -v xdg-open >/dev/null 2>&1; then
      nohup xdg-open "$url" >/dev/null 2>&1 &
      return 0
    fi
  fi
  say "Open this URL in your browser: $url"
}

cmd_stage_sidecars() {
  say "Staging Tauri sidecars..."
  bash "$REPO_ROOT/src-tauri/build-sidecar.sh"
}

cmd_build() {
  say "Building Amiro Desktop..."
  cmd_stage_sidecars
  if command -v cargo-tauri >/dev/null 2>&1; then
    cargo tauri build
  else
    cargo build --manifest-path "$REPO_ROOT/src-tauri/Cargo.toml" --release
  fi
}

cmd_dev() {
  if command -v cargo-tauri >/dev/null 2>&1; then
    cargo tauri dev
  else
    say "cargo-tauri not found; launching desktop app in dev mode..."
    cmd_start
  fi
}

cmd_status() {
  say "=== Amiro Desktop Status ==="
  say "Host OS:         $(uname -s) ($(uname -m))"
  say "Target Triple:   $(get_target_triple)"

  local native_bin
  if native_bin="$(find_native_tauri_binary)"; then
    say "Native Desktop:  Found ($native_bin)"
  else
    say "Native Desktop:  Not compiled (will use dedicated Desktop App Window fallback)"
  fi

  local backend_bin
  if backend_bin="$(resolve_backend)"; then
    say "Backend Sidecar: Found ($backend_bin)"
  else
    say "Backend Sidecar: Missing (run: scripts/build-native.sh)"
  fi

  local staged_triple="$(get_target_triple)"
  local staged_backend="$REPO_ROOT/src-tauri/binaries/backend-$staged_triple"
  local staged_runtime="$REPO_ROOT/src-tauri/binaries/runtime-$staged_triple"
  if [ -f "$staged_backend" ] && [ -f "$staged_runtime" ]; then
    say "Staged Sidecars: Yes (backend & runtime staged in src-tauri/binaries)"
  else
    say "Staged Sidecars: Not fully staged (run: scripts/desktop-app.sh stage-sidecars)"
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    local pid="$(cat "$PID_FILE")"
    say "Desktop Process: Running (PID $pid, logs at $LOG_FILE)"
  else
    say "Desktop Process: Not running"
  fi

  if is_listening "$PORT"; then
    say "Port $PORT:        Listening"
  else
    say "Port $PORT:        Idle"
  fi
}

cmd_start() {
  local native_bin
  if native_bin="$(find_native_tauri_binary)"; then
    say "Launching compiled native Tauri desktop app: $native_bin"
    if [[ "$native_bin" == *".app"* ]] && [ "$(uname -s)" = "Darwin" ]; then
      local app_bundle="${native_bin%%.app/*}.app"
      exec open "$app_bundle"
    else
      exec "$native_bin" "$@"
    fi
  fi

  say "Native Tauri binary not found; starting Amiro Desktop in dedicated window mode..."
  local backend_bin
  if ! backend_bin="$(resolve_backend)"; then
    die "Neither native Tauri binary nor amiro-backend found. Build it with: scripts/build-native.sh"
  fi

  mkdir -p "$STATE_DIR"
  local target_port
  target_port="$(find_free_port "$PORT")"

  # Check if an Amiro server is already running on this target port
  local already_running=0
  if is_listening "$target_port" && (curl -sf -m 1 "http://127.0.0.1:${target_port}/api/system" >/dev/null 2>&1 || curl -sf -m 1 "http://127.0.0.1:${target_port}/" >/dev/null 2>&1); then
    already_running=1
    say "Attached to running Amiro server on 127.0.0.1:${target_port}"
  else
    local token
    token="$(ensure_desktop_token)"
    export AMIRO_DESKTOP="1"
    export AMIRO_HOST="127.0.0.1"
    export AMIRO_PORT="$target_port"
    export AMIRO_TOKEN="$token"
    export AMIRO_AUTH_TOKEN="$token"
    export AMIRO_ALLOWED_ORIGIN="http://localhost:${target_port},http://127.0.0.1:${target_port}"
    export AMIRO_HOME="${AMIRO_HOME:-$HOME/.amiro}"

    say "Starting amiro-backend with AMIRO_DESKTOP=1 on 127.0.0.1:${target_port}..."
    nohup "$backend_bin" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    printf '%s\n' "$pid" > "$PID_FILE"
    say "Background desktop server started with PID $pid"

    if ! wait_for_server "$target_port"; then
      die "Backend failed to start on 127.0.0.1:${target_port}. Check $LOG_FILE for details."
    fi
  fi

  local app_url="http://127.0.0.1:${target_port}"
  say "Opening Amiro Desktop window at $app_url..."
  launch_desktop_window "$app_url"
}

# Parse options
case "$CMD" in
  start)
    shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --port) PORT="${2:?--port requires a value}"; shift 2 ;;
        --no-browser) NO_BROWSER=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown option for start: $1" ;;
      esac
    done
    cmd_start
    ;;
  stage-sidecars)
    cmd_stage_sidecars
    ;;
  build)
    cmd_build
    ;;
  dev)
    cmd_dev
    ;;
  status)
    cmd_status
    ;;
  --help|-h)
    usage
    ;;
  *)
    # Default to start if argument is an option
    if [[ "$CMD" == --* ]]; then
      cmd_start "$@"
    else
      die "unknown command: $CMD (see scripts/desktop-app.sh --help)"
    fi
    ;;
esac
