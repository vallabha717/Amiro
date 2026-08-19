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

export AMIRO_DATABASE_DRIVER=sqlite
export AMIRO_APP_DATA_DIR="${AMIRO_APP_DATA_DIR:-$HOME/.local/share/amiro-dev}"
export AMIRO_PORT=8787
export AMIRO_AUTH_TOKEN="dev-test-token-1786373638"
export AMIRO_ALLOWED_ORIGIN="${AMIRO_ALLOWED_ORIGIN:-http://localhost:3210}"
# File/edit/search/git tools only exist when a workspace root is set (see
# backend-go/internal/agent/workspace) -- without this, this dev flow is
# terminal-only no matter what the frontend's Tools dropdown allows.
# Defaults to this repo so the agent can work on itself out of the box.
export AMIRO_WORKSPACE_ROOT="${AMIRO_WORKSPACE_ROOT:-$DESKTOP_DIR}"

# Legacy fallback variables for backwards compatibility
export BETTERCHATBOT_DATABASE_DRIVER="$AMIRO_DATABASE_DRIVER"
export BETTERCHATBOT_APP_DATA_DIR="$AMIRO_APP_DATA_DIR"
export BETTERCHATBOT_PORT="$AMIRO_PORT"
export BETTERCHATBOT_AUTH_TOKEN="$AMIRO_AUTH_TOKEN"
export BETTERCHATBOT_ALLOWED_ORIGIN="$AMIRO_ALLOWED_ORIGIN"
export BETTERCHATBOT_WORKSPACE_ROOT="$AMIRO_WORKSPACE_ROOT"

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
            value = line.rstrip("\n").split("=", 1)[1].strip()
            # The value is necessarily quoted (the JSON has spaces and shell
            # metacharacters); print the JSON, not the quotes, or the Go
            # side json.Unmarshal fails on the leading quote and silently
            # drops every custom provider.
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("\"", chr(39)):
                value = value[1:-1]
            print(value)
            break
' "$DESKTOP_ENV")"
  export OPENAI_COMPATIBLE_DATA
fi

mkdir -p "$AMIRO_APP_DATA_DIR"
if [ ! -f "$AMIRO_APP_DATA_DIR/amiro.db" ] && [ -f "$HOME/.local/share/better-chatbot-dev/betterchatbot.db" ]; then
  cp -rn "$HOME/.local/share/better-chatbot-dev/"* "$AMIRO_APP_DATA_DIR/" 2>/dev/null || true
  cp "$HOME/.local/share/better-chatbot-dev/betterchatbot.db" "$AMIRO_APP_DATA_DIR/amiro.db"
fi

cd "$DESKTOP_DIR/backend-go"
exec go run ./cmd/server
