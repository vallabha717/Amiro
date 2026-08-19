#!/usr/bin/env bash
# Build the Next.js dashboard and stage it where go:embed can find it.
#
# The two halves of this are separate on purpose. `next build` writes to
# out/ at the repo root, which is also what src-tauri bundles and what
# serve-out.mjs serves; backend-go/internal/web/dist is a *copy*, staged
# only so `go build -tags embedui` has something to compile in. Making the
# Go build read out/ directly would put a path traversal out of the Go
# module into every build, and go:embed refuses to leave the module anyway.
#
# Usage:
#   ./scripts/build-ui.sh            build the frontend, then stage it
#   ./scripts/build-ui.sh --stage    stage an existing out/, skip the build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/out"
DIST="$ROOT/backend-go/internal/web/dist"

if [[ "${1:-}" != "--stage" ]]; then
  echo "==> building the dashboard (next build)"
  cd "$ROOT"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm build
  else
    echo "pnpm not found on PATH -- install it, or run with --stage to reuse an existing out/" >&2
    exit 1
  fi
fi

if [[ ! -f "$OUT/index.html" ]]; then
  echo "no export at $OUT (index.html missing) -- did 'next build' succeed?" >&2
  exit 1
fi

echo "==> staging $OUT -> $DIST"
# Replace rather than merge: a file deleted from the export must not
# survive in the embedded copy, where it would be served forever.
rm -rf "$DIST"
mkdir -p "$DIST"
cp -R "$OUT/." "$DIST/"

# Keep the placeholder, so a later `git clean` of the generated files still
# leaves go:embed a directory to point at.
cat > "$DIST/.gitkeep" <<'GITKEEP'
Placeholder so `go:embed all:dist` (embed_on.go) has a directory to point
at in a checkout that has not run scripts/build-ui.sh. Everything else in
here is generated and gitignored.
GITKEEP

FILES=$(find "$DIST" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$DIST" | cut -f1)
echo "==> staged $FILES files ($SIZE)"
echo
echo "now build the binaries with the bundle compiled in:"
echo "  cd backend-go && go build -tags embedui -o bin/amiro ./cmd/amiro"
echo "  cd backend-go && go build -tags embedui -o bin/amiro-server ./cmd/server"
