#!/usr/bin/env bash
# ==============================================================================
# start-local.sh
# Starts both the Node adapter (port 8787) and Next.js frontend (port 3210) locally.
#
# Usage:
#   ./scripts/start-local.sh              # Default: builds and runs production static server (fastest)
#   ./scripts/start-local.sh --build      # Build and run production static server
#   ./scripts/start-local.sh --no-build   # Run production static server using existing out/ build
#   ./scripts/start-local.sh --dev        # Run Next.js dev server with Turbopack & hot-reloading
# ==============================================================================
set -euo pipefail

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

# 1. Clean up any stale instances bound to ports 8787 or 3210
echo "[1/3] Ensuring ports 8787 and 3210 are free..."
fuser -k 8787/tcp 3210/tcp 2>/dev/null || true

# Process tracker for cleanup
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down servers..."
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  fuser -k 8787/tcp 3210/tcp 2>/dev/null || true
  echo "Servers stopped."
}
trap cleanup EXIT INT TERM

# 2. Build if needed
if [ "$MODE" = "build" ]; then
  echo "[2/3] Building production static bundle (npm run build)..."
  npm run build
fi

# 3. Start Node adapter (replaces the old Go backend)
echo "[3/3] Starting Node adapter on port 8787..."
"$SCRIPT_DIR/dev-backend.sh" &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for Node adapter on port 8787..."
MAX_RETRIES=60
COUNT=0
while ! (ss -ltnp | grep -q ':8787') && [ $COUNT -lt $MAX_RETRIES ]; do
  sleep 1
  COUNT=$((COUNT + 1))
done

if ! (ss -ltnp | grep -q ':8787'); then
  echo "Error: Node adapter failed to start on port 8787."
  exit 1
fi
echo "✓ Node adapter is ready on http://127.0.0.1:8787"

# 4. Start Frontend
if [ "$MODE" = "dev" ]; then
  echo "Starting Next.js Dev Server with Turbopack on port 3210..."
  NODE_OPTIONS="--max-old-space-size=8192" PORT=3210 npx next dev --turbopack &
  FRONTEND_PID=$!
else
  echo "Starting production static server on port 3210..."
  PORT=3210 node "$SCRIPT_DIR/serve-prod.mjs" &
  FRONTEND_PID=$!
fi

# Wait for frontend to respond
echo "Waiting for frontend on http://localhost:3210..."
COUNT=0
while ! (ss -ltnp | grep -q ':3210') && [ $COUNT -lt $MAX_RETRIES ]; do
  sleep 0.5
  COUNT=$((COUNT + 1))
done

echo ""
echo "=================================================="
echo "🚀 Amiro is running!"
echo "   - Frontend: http://localhost:3210"
echo "   - Backend:  http://localhost:8787"
echo "=================================================="
echo "Press Ctrl+C to stop both servers."

wait "$FRONTEND_PID" "$BACKEND_PID"
