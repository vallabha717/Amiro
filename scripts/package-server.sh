#!/usr/bin/env bash
# Build the downloadable server archive install.sh installs:
#
#   scripts/package-server.sh <version> [target] [out-dir]
#
# amiro-server-<os>-<arch>.tar.gz (os: linux|macos, arch: x86_64|aarch64)
# contains amiro/ with amiro-backend,
# amiro-runtime, ui/ (the static web UI), the `amiro` command,
# amiro.example.toml and VERSION. Expects release builds of backend and
# runtime for <target> and a built UI in out/ (pnpm build). Binaries can be
# overridden with AMIRO_PKG_BACKEND / AMIRO_PKG_RUNTIME.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?usage: package-server.sh <version> [target] [out-dir]}"
HOST="$(rustc -Vv | awk '/^host:/ {print $2}')"
TARGET="${2:-$HOST}"
OUT="${3:-$ROOT/dist}"

if [ "$TARGET" = "$HOST" ]; then rel=release; else rel="$TARGET/release"; fi
backend="${AMIRO_PKG_BACKEND:-$ROOT/backend/target/$rel/amiro-backend}"
runtime="${AMIRO_PKG_RUNTIME:-$ROOT/runtime/target/$rel/amiro-runtime}"
for f in "$backend" "$runtime" "$ROOT/clients/web/out/index.html"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done

stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
pkg="$stage/amiro"
mkdir -p "$pkg"
cp "$backend" "$pkg/amiro-backend"
cp "$runtime" "$pkg/amiro-runtime"
cp -R "$ROOT/clients/web/out" "$pkg/ui"
cp "$ROOT/packaging/amiro" "$pkg/amiro"
cp "$ROOT/amiro.example.toml" "$pkg/amiro.example.toml"
cp "$ROOT/LICENSE" "$pkg/LICENSE" 2>/dev/null || true
printf '%s\n' "$VERSION" > "$pkg/VERSION"
chmod 755 "$pkg/amiro" "$pkg/amiro-backend" "$pkg/amiro-runtime"
# Debug symbols make the runtime several times larger.
if [ "${AMIRO_PKG_NO_STRIP:-}" != 1 ]; then
  case "$TARGET" in
    *apple-darwin) strip -x "$pkg/amiro-backend" "$pkg/amiro-runtime" 2>/dev/null || true ;;
    *) strip "$pkg/amiro-backend" "$pkg/amiro-runtime" 2>/dev/null || true ;;
  esac
fi

case "$TARGET" in
  *-linux-*) os=linux ;;
  *-apple-darwin) os=macos ;;
  *) echo "unsupported target $TARGET" >&2; exit 1 ;;
esac
arch="${TARGET%%-*}"
mkdir -p "$OUT"
archive="$OUT/amiro-server-$os-$arch.tar.gz"
tar -C "$stage" -czf "$archive" amiro
echo "$archive ($(du -h "$archive" | cut -f1))"
