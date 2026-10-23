#!/usr/bin/env bash
# Build owned native executables from the source in this repository.
# This is deliberately separate from the compatibility Node adapter launcher.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=release
TARGET=""
STAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) PROFILE=debug; shift ;;
    --target) TARGET="${2:?--target requires a Rust target triple}"; shift 2 ;;
    --stage) STAGE="${2:?--stage requires an output directory}"; shift 2 ;;
    --help|-h)
      printf '%s\n' 'Usage: scripts/build-native.sh [--debug] [--target TRIPLE] [--stage DIRECTORY]' 'Builds the Rust HTTP backend and the in-repo Rust agent runtime.'
      exit 0
      ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v cargo >/dev/null || { echo 'A Rust toolchain is required.' >&2; exit 1; }
for manifest in backend/Cargo.toml runtime/Cargo.toml; do
  [[ -f "$ROOT/$manifest" ]] || { printf 'Missing native source manifest: %s\n' "$manifest" >&2; exit 1; }
done

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
ARGS=(--locked)
[[ "$PROFILE" == release ]] && ARGS+=(--release)
[[ -n "$TARGET" ]] && ARGS+=(--target "$TARGET")
cargo build --manifest-path "$ROOT/backend/Cargo.toml" --target-dir "$ROOT/backend/target" --bin amiro-backend "${ARGS[@]}"
cargo build --manifest-path "$ROOT/runtime/Cargo.toml" --target-dir "$ROOT/runtime/target" --bin amiro-runtime --no-default-features "${ARGS[@]}"

if [[ -n "$STAGE" ]]; then
  SUFFIX=""
  case "${TARGET:-$(rustc -vV | awk '/^host:/ { print $2 }')}" in *windows*) SUFFIX=.exe ;; esac
  SEGMENT="${TARGET:+$TARGET/}$PROFILE"
  # A directory can be moved as a unit. Neither executable contains a checkout path.
  mkdir -p "$STAGE"
  install -m 755 "$ROOT/backend/target/$SEGMENT/amiro-backend$SUFFIX" "$STAGE/amiro-backend$SUFFIX"
  install -m 755 "$ROOT/runtime/target/$SEGMENT/amiro-runtime$SUFFIX" "$STAGE/amiro$SUFFIX"
  install -m 644 "$ROOT/runtime/LICENSE" "$STAGE/RUNTIME-LICENSE"
  if [[ -d "$ROOT/clients/web/out" ]]; then
    mkdir -p "$STAGE/ui"
    cp -R "$ROOT/clients/web/out/." "$STAGE/ui/"
  else
    printf '%s\n' 'No clients/web/out/ export found. Run pnpm build before staging the standalone web UI.' >&2
  fi
  printf 'Native Amiro executables staged in %s\n' "$STAGE"
fi
