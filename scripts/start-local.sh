#!/usr/bin/env bash
# ==============================================================================
# start-local.sh
# Starts both the Amiro adapter (port 8787) and Next.js frontend (port 3210) locally.
#
# Usage:
#   ./scripts/start-local.sh              # Default: builds and runs production static server (fastest)
#   ./scripts/start-local.sh --build      # Build and run production static server
#   ./scripts/start-local.sh --no-build   # Run production static server using existing out/ build
#   ./scripts/start-local.sh --dev        # Run Next.js dev server with Turbopack & hot-reloading
#
# Port policy: this script never kills anything it did not start. If 8787 or
# 3210 is already taken it stops and says so, so an unrelated dev server or
# service is never silently terminated. Use AMIRO_PORT / FRONTEND_PORT to move
# this script somewhere else.
# ==============================================================================
set -euo pipefail

BACKEND_PORT="${AMIRO_PORT:-8787}"
FRONTEND_PORT="${FRONTEND_PORT:-3210}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

MODE="build"

for arg in "$@"; do
  case "$arg" in
    --build|-b|--prod|-p)
      MODE="build"
      ;;
    --dev|-d)
      MODE="dev"
      ;;
    --no-build)
      MODE="no-build"
      ;;
    --help|-h)
      echo "Usage: ./scripts/start-local.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --build, -b, --prod   Build and start production static server (fast, default)"
      echo "  --no-build            Start production static server with existing build"
      echo "  --dev, -d             Start Next.js dev server with Turbopack (hot-reloading)"
      echo "  --help, -h            Show this help message"
      echo ""
      echo "Ports: backend \$AMIRO_PORT (default 8787), frontend \$FRONTEND_PORT (default 3210)."
      echo "An occupied port is reported, never killed."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Use --help for usage instructions."
      exit 1
      ;;
  esac
done

echo "=================================================="
echo " Starting Amiro Local Environment (Mode: $MODE)"
echo "=================================================="

# Is something already listening on this port?
port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q . && return 0
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  # Last resort: a direct TCP connect.
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && return 0
  return 1
}

# 1. Refuse to start on top of someone else's process.
echo "[1/3] Checking that ports ${BACKEND_PORT} and ${FRONTEND_PORT} are free..."
busy=""
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_listening "$port"; then
    busy="${busy} ${port}"
  fi
done
if [ -n "$busy" ]; then
  echo "Error: port(s)${busy} are already in use." >&2
  echo "       This script will not kill a process it did not start. Stop that" >&2
  echo "       process yourself, or pick other ports, e.g.:" >&2
  echo "         AMIRO_PORT=8887 FRONTEND_PORT=3310 ./scripts/start-local.sh" >&2
  exit 1
fi

# Process tracker for cleanup: only these PIDs are ever signalled.
BACKEND_PID=""
FRONTEND_PID=""

stop_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
}

still_running() {
  local pid
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "Shutting down the servers this script started..."
  stop_pid "$FRONTEND_PID"
  stop_pid "$BACKEND_PID"
  local waited=0
  while still_running && [ "$waited" -lt 20 ]; do
    sleep 0.25
    waited=$((waited + 1))
  done
  # Only our own children, and only if they ignored SIGTERM.
  local pid
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "Servers stopped."
}
trap cleanup EXIT INT TERM

# 2. Build if needed
if [ "$MODE" = "build" ]; then
  echo "[2/3] Building production static bundle (npm run build)..."
  npm run build
fi

# 3. Start Amiro adapter (replaces the old Go backend)
echo "[3/3] Starting Amiro adapter on port ${BACKEND_PORT}..."
AMIRO_PORT="$BACKEND_PORT" "$SCRIPT_DIR/dev-backend.sh" &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for Amiro adapter on port ${BACKEND_PORT}..."
MAX_RETRIES=60
COUNT=0
while ! port_listening "$BACKEND_PORT" && [ $COUNT -lt $MAX_RETRIES ]; do
  sleep 1
  COUNT=$((COUNT + 1))
done

if ! port_listening "$BACKEND_PORT"; then
  echo "Error: Amiro adapter failed to start on port ${BACKEND_PORT}."
  exit 1
fi
echo "✓ Amiro adapter is ready on http://127.0.0.1:${BACKEND_PORT}"

# 4. Start Frontend
if [ "$MODE" = "dev" ]; then
  echo "Starting Next.js Dev Server with Turbopack on port ${FRONTEND_PORT}..."
  NODE_OPTIONS="--max-old-space-size=8192" PORT="$FRONTEND_PORT" npx next dev --turbopack &
  FRONTEND_PID=$!
else
  echo "Starting production static server on port ${FRONTEND_PORT}..."
  PORT="$FRONTEND_PORT" node "$SCRIPT_DIR/serve-prod.mjs" &
  FRONTEND_PID=$!
fi

# Wait for frontend to respond
echo "Waiting for frontend on http://localhost:${FRONTEND_PORT}..."
COUNT=0
while ! port_listening "$FRONTEND_PORT" && [ $COUNT -lt $MAX_RETRIES ]; do
  sleep 0.5
  COUNT=$((COUNT + 1))
done

echo ""
echo "=================================================="
echo "🚀 Amiro is running!"
echo "   - Frontend: http://localhost:${FRONTEND_PORT}"
echo "   - Backend:  http://localhost:${BACKEND_PORT}"
echo "=================================================="
echo "Press Ctrl+C to stop both servers."

wait "$FRONTEND_PID" "$BACKEND_PID"
