#!/usr/bin/env bash
# Build the Next.js dashboard static export into out/.
#
# History: this used to also stage out/ into backend-go/internal/web/dist so a
# `go build -tags embedui` binary could serve the dashboard from one listener.
# backend-go is gone; the Amiro adapter (adapter/src/server.mjs) serves out/
# directly from the repo root, so the staging step is no longer needed and out/
# is the single source of truth for both the adapter and clients/desktop's
# frontendDist.
#
# Usage:
#   ./scripts/build-ui.sh            build the dashboard (next build -> out/)
#   ./scripts/build-ui.sh --check    verify an existing out/ is present
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/clients/web/out"

if [[ "${1:-}" != "--check" ]]; then
  echo "==> building the dashboard (next build)"
  cd "$ROOT"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm build
  else
    echo "pnpm not found on PATH -- install it, or run with --check to reuse an existing out/" >&2
    exit 1
  fi
fi

if [[ ! -f "$OUT/index.html" ]]; then
  echo "no export at $OUT (index.html missing) -- did 'next build' succeed?" >&2
  exit 1
fi

FILES=$(find "$OUT" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$OUT" | cut -f1)
echo "==> export ready: $FILES files ($SIZE) at $OUT"
echo
echo "the Amiro adapter serves this directly; to run it standalone:"
echo "  ./scripts/dev-backend.sh"
