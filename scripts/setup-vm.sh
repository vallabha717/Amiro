#!/usr/bin/env bash
# setup-vm.sh: one-command bootstrap for a brand new Amiro machine.
#
# Installs OS prerequisites, Rust, Node and pnpm, installs JS dependencies,
# then builds the owned native binaries (via scripts/build-native.sh) and the
# static frontend export (via pnpm build, which lands in out/).
#
# Idempotent: safe to re-run. Anything already installed is skipped.
#
# Usage:
#   ./scripts/setup-vm.sh [--skip-frontend] [--skip-native] [--skip-desktop] [--remote] [--install-service] [--port P] [--yes]
#
# Flags:
#   --skip-frontend   skip `pnpm build` (no out/ export)
#   --skip-native     skip scripts/build-native.sh (no Rust binaries)
#   --skip-desktop    skip Tauri desktop GUI system libraries (webkit/GTK).
#                     Pick this for headless servers. `cargo tauri dev` will
#                     still need those libraries later.
#   --remote          configure remote VM access defaults (0.0.0.0 bind)
#   --install-service install and enable systemd boot service (via install-vm-service.sh)
#   --port P          port for VM Web UI server (default 3000)
#   --yes, -y         assume yes for install prompts (non-interactive)
#   --help, -h        print this help and exit
#
# sudo is used only for the OS package manager step (apt on Debian/Ubuntu),
# and the exact privileged command is printed before it runs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_FILE="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SKIP_FRONTEND=0
SKIP_NATIVE=0
SKIP_DESKTOP=0
REMOTE=0
INSTALL_SERVICE=0
PORT=3000
ASSUME_YES=0

usage() {
  sed -n '2,24p' "$SCRIPT_FILE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    --skip-native) SKIP_NATIVE=1; shift ;;
    --skip-desktop) SKIP_DESKTOP=1; shift ;;
    --remote) REMOTE=1; shift ;;
    --install-service) INSTALL_SERVICE=1; shift ;;
    --port) PORT="${2:?--port requires a value}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; echo "try: ./scripts/setup-vm.sh --help" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'
  BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BLUE=''; BOLD=''; RESET=''
fi

step() { printf '\n%s==>%s %s\n' "$BLUE" "$RESET" "$*"; }
ok() { printf '%sok:%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%swarn:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

confirm() {
  if [ "$ASSUME_YES" = "1" ]; then
    return 0
  fi
  local reply=""
  read -r -p "$1 [y/N] " reply || true
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

INSTALLED_OS_DEPS="skipped (already present)"
INSTALLED_RUST="skipped (already present)"
INSTALLED_NODE="skipped (already present)"
INSTALLED_PNPM="skipped (already present)"

OS="$(uname -s)"
case "$OS" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *) die "unsupported OS: $OS (this script supports Ubuntu/Debian Linux and macOS)" ;;
esac

step "Amiro setup: platform $PLATFORM, repo $REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. OS prerequisites
# ---------------------------------------------------------------------------
APT_BASE=(build-essential pkg-config libssl-dev curl git wget file)
APT_DESKTOP=(libxdo-dev libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev)
BREW_PKGS=(pkg-config openssl curl git wget file)

if [ "$PLATFORM" = "linux" ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    die "apt-get not found. This script supports Ubuntu/Debian only. Install the prerequisites for your distro by hand, then re-run with the OS step satisfied."
  fi
  WANT=("${APT_BASE[@]}")
  if [ "$SKIP_DESKTOP" = "0" ]; then
    WANT+=("${APT_DESKTOP[@]}")
  else
    warn "--skip-desktop: leaving out Tauri GUI libraries (webkit/GTK). Install them later before running cargo tauri dev."
  fi
  MISSING=()
  for pkg in "${WANT[@]}"; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "ok installed"; then
      ok "$pkg already installed"
    else
      MISSING+=("$pkg")
    fi
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
      command -v sudo >/dev/null 2>&1 || die "need root for apt-get but sudo is not installed. Re-run as root."
      SUDO="sudo"
    fi
    echo "About to run with privileges: ${SUDO:+$SUDO }apt-get update && ${SUDO:+$SUDO }apt-get install -y ${MISSING[*]}"
    confirm "Install ${#MISSING[@]} missing OS package(s)?" || die "declined OS package install. Re-run with --yes to accept automatically."
    step "Installing OS packages (privileged)"
    # shellcheck disable=SC2068
    ${SUDO:+$SUDO} apt-get update
    # shellcheck disable=SC2068
    DEBIAN_FRONTEND=noninteractive ${SUDO:+$SUDO} apt-get install -y ${MISSING[@]}
    INSTALLED_OS_DEPS="installed: ${MISSING[*]}"
  fi
fi

if [ "$PLATFORM" = "macos" ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "Xcode command line tools are missing. Apple installs them with a GUI prompt:"
    echo "  xcode-select --install"
    if confirm "Run xcode-select --install now?"; then
      xcode-select --install || true
      die "Xcode tools install was started. Finish it, then re-run ./scripts/setup-vm.sh"
    else
      die "Xcode command line tools are required. Run xcode-select --install, then re-run ./scripts/setup-vm.sh"
    fi
  else
    ok "Xcode command line tools present"
  fi
  if command -v brew >/dev/null 2>&1; then
    MISSING_BREW=()
    for pkg in "${BREW_PKGS[@]}"; do
      if brew list --formula "$pkg" >/dev/null 2>&1; then
        ok "brew $pkg already installed"
      else
        MISSING_BREW+=("$pkg")
      fi
    done
    if [ "${#MISSING_BREW[@]}" -gt 0 ]; then
      step "Installing brew packages: ${MISSING_BREW[*]}"
      # shellcheck disable=SC2068
      brew install ${MISSING_BREW[@]}
      INSTALLED_OS_DEPS="installed (brew): ${MISSING_BREW[*]}"
    fi
  else
    warn "brew not found, skipping brew packages. Install from https://brew.sh if you want them managed."
  fi
fi

# ---------------------------------------------------------------------------
# 2. Rust via rustup (only when cargo is missing)
# ---------------------------------------------------------------------------
step "Rust toolchain"
if command -v cargo >/dev/null 2>&1; then
  ok "cargo present: $(cargo --version)"
else
  command -v curl >/dev/null 2>&1 || die "curl is required to install rustup but was not found."
  step "Installing Rust via rustup (unprivileged, into \$HOME/.cargo)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  export PATH="$HOME/.cargo/bin:$PATH"
  hash -r 2>/dev/null || true
  command -v cargo >/dev/null 2>&1 || die "rustup install finished but cargo is still not on PATH. Add \$HOME/.cargo/bin to PATH and re-run."
  INSTALLED_RUST="installed via rustup: $(cargo --version)"
  ok "$INSTALLED_RUST"
fi

# ---------------------------------------------------------------------------
# 3. Node >= 20 (prefer nvm, never install an arbitrary Node)
# ---------------------------------------------------------------------------
step "Node.js (>= 20, adapter wants >= 22)"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "node present: $(node --version)"
    if [ "$NODE_MAJOR" -lt 22 ]; then
      warn "adapter/src/server.mjs and adapter/package.json want Node >= 22. Consider upgrading with nvm: nvm install 22"
    fi
    NODE_OK=1
  else
    warn "node $(node --version) is older than 20"
  fi
fi
if [ "$NODE_OK" = "0" ]; then
  NVM_LOADED=0
  if command -v nvm >/dev/null 2>&1; then
    NVM_LOADED=1
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    NVM_LOADED=1
  fi
  if [ "$NVM_LOADED" = "1" ]; then
    step "Installing Node 22 with nvm"
    nvm install 22
    nvm use 22
    INSTALLED_NODE="installed via nvm: $(node --version)"
    ok "$INSTALLED_NODE"
  else
    cat >&2 <<'EOF'
error: Node >= 20 is required but none was found, and nvm is not installed.
This script will not install an arbitrary system Node. Pick one of these:
  1. nvm (recommended):
       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
       nvm install 22
  2. Direct download from https://nodejs.org (take the LTS release)
  3. macOS with brew: brew install node@22
Then re-run ./scripts/setup-vm.sh
EOF
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 4. pnpm 10.2.1 via corepack
# ---------------------------------------------------------------------------
step "pnpm 10.2.1 (matches package.json packageManager)"
WANT_PNPM="10.2.1"
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version 2>/dev/null || echo none)" = "$WANT_PNPM" ]; then
  ok "pnpm present: $(pnpm --version)"
else
  if command -v corepack >/dev/null 2>&1; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    if ! corepack enable 2>/dev/null; then
      warn "corepack enable needed privileges, retrying explicitly with sudo"
      command -v sudo >/dev/null 2>&1 || die "corepack enable failed and sudo is unavailable."
      echo "About to run with privileges: sudo corepack enable"
      sudo corepack enable
    fi
    corepack prepare "pnpm@$WANT_PNPM" --activate
  else
    warn "corepack not found on this Node, falling back to npm"
    npm install -g "pnpm@$WANT_PNPM"
  fi
  hash -r 2>/dev/null || true
  command -v pnpm >/dev/null 2>&1 || die "pnpm install finished but pnpm is still not on PATH."
  INSTALLED_PNPM="installed: pnpm $(pnpm --version)"
  ok "$INSTALLED_PNPM"
fi

# ---------------------------------------------------------------------------
# 5. JS dependencies (root and adapter)
# ---------------------------------------------------------------------------
step "Installing JS dependencies"
pnpm install
pnpm --dir adapter install
ok "pnpm install done (root and adapter/)"

# ---------------------------------------------------------------------------
# 6. Native binaries through the owned build script
# ---------------------------------------------------------------------------
BACKEND_BIN="$REPO_ROOT/backend/target/release/amiro-backend"
RUNTIME_BIN="$REPO_ROOT/runtime/target/release/amiro-runtime"
if [ "$SKIP_NATIVE" = "1" ]; then
  warn "--skip-native: not building Rust binaries. Run scripts/build-native.sh later."
else
  step "Building native binaries via scripts/build-native.sh"
  [ -x "$REPO_ROOT/scripts/build-native.sh" ] || die "scripts/build-native.sh is missing or not executable."
  bash "$REPO_ROOT/scripts/build-native.sh"
  if [ -x "$BACKEND_BIN" ] && [ -x "$RUNTIME_BIN" ]; then
    ok "native binaries built"
  else
    die "build-native.sh finished but a binary is missing. Expected $BACKEND_BIN and $RUNTIME_BIN"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Frontend static export (out/)
# ---------------------------------------------------------------------------
if [ "$SKIP_FRONTEND" = "1" ]; then
  warn "--skip-frontend: not running pnpm build. The backend serves out/, so build it before starting the app."
else
  step "Building the frontend (pnpm build -> out/)"
  pnpm build
  [ -f "$REPO_ROOT/out/index.html" ] || die "pnpm build finished but out/index.html is missing."
  ok "frontend export ready at $REPO_ROOT/out"
fi

# ---------------------------------------------------------------------------
# 8. Optional service installation
# ---------------------------------------------------------------------------
if [ "$INSTALL_SERVICE" = "1" ]; then
  step "Installing systemd VM service via scripts/install-vm-service.sh"
  SERVICE_ARGS=("--port" "$PORT")
  if [ "$REMOTE" = "1" ]; then
    SERVICE_ARGS+=("--host" "0.0.0.0")
  fi
  if [ "$ASSUME_YES" = "1" ]; then
    SERVICE_ARGS+=("--yes")
  fi
  bash "$REPO_ROOT/scripts/install-vm-service.sh" "${SERVICE_ARGS[@]}"
fi

# ---------------------------------------------------------------------------
# 9. Colored summary
# ---------------------------------------------------------------------------
printf '\n%s========================================%s\n' "$GREEN" "$RESET"
printf '%s  Amiro setup complete%s\n' "$BOLD" "$RESET"
printf '%s========================================%s\n' "$GREEN" "$RESET"
printf 'OS packages:  %s\n' "$INSTALLED_OS_DEPS"
printf 'Rust:         %s\n' "$INSTALLED_RUST"
printf 'Node:         %s (%s)\n' "$INSTALLED_NODE" "$(command -v node >/dev/null 2>&1 && node --version || echo missing)"
printf 'pnpm:         %s (%s)\n' "$INSTALLED_PNPM" "$(command -v pnpm >/dev/null 2>&1 && pnpm --version || echo missing)"
printf 'Binaries:\n'
if [ -x "$BACKEND_BIN" ]; then
  printf '  backend:      %s\n' "$BACKEND_BIN"
else
  printf '  backend:      %s (not built, see --skip-native)%s\n' "$BACKEND_BIN" ""
fi
if [ -x "$RUNTIME_BIN" ]; then
  printf '  runtime:      %s\n' "$RUNTIME_BIN"
else
  printf '  runtime:      %s (not built, see --skip-native)%s\n' "$RUNTIME_BIN" ""
fi
if [ -f "$REPO_ROOT/out/index.html" ]; then
  printf '  frontend:     %s\n' "$REPO_ROOT/out"
else
  printf '  frontend:     %s (not built, see --skip-frontend)\n' "$REPO_ROOT/out"
fi

printf '\n%sVM Server & Web UI (Remote Access):%s\n' "$BOLD" "$RESET"
printf '  Start the VM Web UI server on port %s:\n' "$PORT"
printf '    ./scripts/amiro-server.sh start --host 0.0.0.0 --port %s\n\n' "$PORT"
if [ -x "$REPO_ROOT/scripts/amiro-server.sh" ]; then
  AMIRO_HOST="0.0.0.0" AMIRO_PORT="$PORT" bash "$REPO_ROOT/scripts/amiro-server.sh" urls 2>/dev/null || true
fi
printf '\n%sNext commands:%s\n' "$BOLD" "$RESET"
cat <<'EOF'
  Start the native backend (serves out/ and spawns the runtime bridge):
    ./backend/target/release/amiro-backend
    # then open http://127.0.0.1:8787 and complete the one-time "Set up Amiro"
    # page to create the single owner account (or pre-set AMIRO_OWNER_EMAIL
    # and AMIRO_OWNER_PASSWORD before first start)

  Or run the dev loop (retired Node adapter on 8787 plus Next.js on 3210).
  The adapter is kept for contract tests, not shipped, so prefer the native
  backend above unless you are working on the adapter itself:
    ./scripts/start-local.sh
    # ./scripts/start-local.sh --dev   for hot-reloading instead

  Or run the pieces by hand:
    ./scripts/dev-backend.sh            # Node adapter (needs adapter deps)
    pnpm dev -p 3210                    # Next.js dev server

  Desktop app (needs the GUI libraries, so not with --skip-desktop):
    cargo tauri dev

  Runtime CLI shim (delegates to runtime/target/release/amiro-runtime):
    ./bin/amiro --version

  Tests:
    pnpm test                                     # frontend unit (vitest)
    node --test adapter/test/*.test.mjs           # adapter unit tests
    cargo test --manifest-path backend/Cargo.toml # native backend tests
    cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features
    pnpm verify:native-ui                         # browser check (needs a debug native build:
                                                  # scripts/build-native.sh --debug, plus out/)
    pnpm test:e2e                                 # Playwright end to end (see tests/)
EOF
printf '\nFull walkthrough: %sdocs/VM-SETUP.md%s\n' "$BLUE" "$RESET"
