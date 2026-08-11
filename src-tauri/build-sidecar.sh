#!/usr/bin/env bash
# Cross-compiles the Go sidecar and drops it into src-tauri/binaries/ under
# Tauri's externalBin naming convention (<name>-<rust-target-triple>[.exe]),
# so `tauri dev`/`tauri build` can find it via tauri.conf.json's
# bundle.externalBin: ["binaries/backend"]. Go's own GOOS/GOARCH naming
# doesn't match Rust's target-triple naming, so this script is the
# translation point between the two toolchains (plan section 1: "cross-
# compiled the normal Go way, no cross toolchain needed... dropped into
# that externalBin slot").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../backend-go"
OUT_DIR="$SCRIPT_DIR/binaries"

TARGET_TRIPLE="${1:-$(rustc -Vv | awk '/^host:/ {print $2}')}"
if [ -z "$TARGET_TRIPLE" ]; then
  echo "error: could not determine rust target triple (rustc not on PATH?) -- pass one explicitly" >&2
  exit 1
fi

EXT=""
GOOS="linux"
GOARCH="amd64"
case "$TARGET_TRIPLE" in
  x86_64-unknown-linux-gnu) GOOS=linux; GOARCH=amd64 ;;
  aarch64-unknown-linux-gnu) GOOS=linux; GOARCH=arm64 ;;
  x86_64-apple-darwin) GOOS=darwin; GOARCH=amd64 ;;
  aarch64-apple-darwin) GOOS=darwin; GOARCH=arm64 ;;
  x86_64-pc-windows-msvc) GOOS=windows; GOARCH=amd64; EXT=".exe" ;;
  aarch64-pc-windows-msvc) GOOS=windows; GOARCH=arm64; EXT=".exe" ;;
  *)
    echo "error: unrecognized target triple '$TARGET_TRIPLE' -- add a GOOS/GOARCH mapping in this script" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/backend-${TARGET_TRIPLE}${EXT}"

echo "building backend-go for $TARGET_TRIPLE (GOOS=$GOOS GOARCH=$GOARCH) -> $OUT_FILE"
( cd "$BACKEND_DIR" && GOOS="$GOOS" GOARCH="$GOARCH" CGO_ENABLED=0 go build -o "$OUT_FILE" ./cmd/server )
chmod +x "$OUT_FILE"
echo "done"
