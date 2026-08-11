#!/usr/bin/env bash
# Starts backend-go's cmd/server for standalone frontend dev/testing
# (pnpm dev / pnpm build run outside the real Tauri shell). Values here
# must match .env.local's NEXT_PUBLIC_BACKEND_URL/NEXT_PUBLIC_BACKEND_TOKEN
# -- backend-go has no .env-file support of its own (pure os.Getenv(), by
# design: the real Tauri shell injects these directly into the spawned
# process too, see src-tauri/src/lib.rs), so this script is the backend
# half of the same "shared config" .env.local covers for the frontend.
# desktop/ is a standalone project (moved out of better-chatbot/), so
# every path here resolves within its own tree, never a sibling repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"

export BETTERCHATBOT_DATABASE_DRIVER=sqlite
export BETTERCHATBOT_APP_DATA_DIR="${BETTERCHATBOT_APP_DATA_DIR:-$HOME/.local/share/better-chatbot-dev}"
export BETTERCHATBOT_PORT=8787
export BETTERCHATBOT_AUTH_TOKEN="dev-test-token-1786373638"
export BETTERCHATBOT_ALLOWED_ORIGIN="${BETTERCHATBOT_ALLOWED_ORIGIN:-http://localhost:3210}"

# OPENAI_COMPATIBLE_DATA (custom self-hosted / OpenAI-compatible models,
# internal/ai/bifrost/openai_compatible.go) lives in desktop's own .env
# (gitignored, matching .env.local) -- desktop/ is a standalone project, not
# nested under better-chatbot, so this never reaches outside its own tree.
# Pulled in here with a real (dotenv-shaped, not bash-sourceable -- the JSON
# value has unescaped braces/quotes) line parse rather than `source`, and
# only if not already set in this shell.
DESKTOP_ENV="$DESKTOP_DIR/.env"
if [ -z "${OPENAI_COMPATIBLE_DATA:-}" ] && [ -f "$DESKTOP_ENV" ]; then
  OPENAI_COMPATIBLE_DATA="$(python3 -c '
import sys
path = sys.argv[1]
with open(path) as f:
    for line in f:
        if line.startswith("OPENAI_COMPATIBLE_DATA="):
            print(line.rstrip("\n").split("=", 1)[1])
            break
' "$DESKTOP_ENV")"
  export OPENAI_COMPATIBLE_DATA
fi

mkdir -p "$BETTERCHATBOT_APP_DATA_DIR"
cd "$DESKTOP_DIR/backend-go"
exec go run ./cmd/server
