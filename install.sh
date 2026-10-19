#!/usr/bin/env bash
# Install the Amiro server (Linux or macOS, x86_64 or arm64):
#
#   curl -fsSL https://github.com/vallabha717/Amiro/releases/latest/download/install.sh | bash
#
# Options (after `bash -s --`), or the matching environment variables:
#   --version vX.Y.Z   a specific release            (AMIRO_VERSION)
#   --public           listen on all interfaces, for a VM you reach over the network
#   --port N           port for the web UI (default 3000)
#   --service          start at boot (systemd user service / launchd)
#   --no-start         install only                  (AMIRO_NO_START=1)
#   --home DIR         data + app directory (default ~/.amiro)   (AMIRO_HOME)
#
# Example, a VM reachable on your network that survives reboots:
#   curl -fsSL https://github.com/vallabha717/Amiro/releases/latest/download/install.sh | bash -s -- --public --service
#
# What it does: downloads the release for this OS/CPU, checks its SHA-256,
# unpacks it to ~/.amiro/app/<version>, links `amiro` into ~/.local/bin, writes
# ~/.amiro/amiro.toml on first install, and starts the server. Nothing needs
# root unless you ask for a system service. Uninstall: amiro uninstall.
set -euo pipefail

REPO="${AMIRO_REPO:-vallabha717/Amiro}"
VERSION="${AMIRO_VERSION:-latest}"
AMIRO_HOME="${AMIRO_HOME:-$HOME/.amiro}"
START=1; [ "${AMIRO_NO_START:-}" = 1 ] && START=0
SERVICE=0
SETUP_ARGS=()
# For testing: install from a local archive instead of downloading.
ARCHIVE="${AMIRO_INSTALL_ARCHIVE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --public) SETUP_ARGS+=(--public); shift ;;
    --port) SETUP_ARGS+=(--port "$2"); shift 2 ;;
    --host) SETUP_ARGS+=(--host "$2"); shift 2 ;;
    --service) SERVICE=1; shift ;;
    --no-start) START=0; shift ;;
    --home) AMIRO_HOME="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
export AMIRO_HOME

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'; else B='' D='' G='' R='' C='' N=''; fi
step() { printf '%s›%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

printf '\n%s  Amiro%s %s· your own AI agent%s\n\n' "$B" "$N" "$D" "$N"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "Amiro's server installs on Linux and macOS. On Windows, use the desktop app or WSL2." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
# Rosetta: prefer the native build on Apple silicon.
if [ "$os" = macos ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=aarch64; fi
target="$os-$arch"
asset="amiro-server-$target.tar.gz"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [ -n "$ARCHIVE" ]; then
  step "Using local archive $ARCHIVE"
  cp "$ARCHIVE" "$tmp/$asset"
else
  step "Downloading Amiro ($VERSION) for $target"
  curl -fL --progress-bar -o "$tmp/$asset" "$base/$asset" \
    || die "no build for $target in release $VERSION ($base/$asset)"
  if curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"; then
    want="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)"
    [ -n "$want" ] || die "SHA256SUMS has no entry for $asset"
    [ "$(sha256 "$tmp/$asset")" = "$want" ] || die "checksum mismatch for $asset; refusing to install"
    ok "Checksum verified"
  else
    die "could not download SHA256SUMS for $VERSION"
  fi
fi

tar -xzf "$tmp/$asset" -C "$tmp"
[ -x "$tmp/amiro/amiro-backend" ] || die "archive is missing amiro/amiro-backend"
version="$(cat "$tmp/amiro/VERSION" 2>/dev/null || echo "$VERSION")"

mkdir -p "$AMIRO_HOME/app"; chmod 700 "$AMIRO_HOME" 2>/dev/null || true
dest="$AMIRO_HOME/app/$version"
rm -rf "$dest.partial"; mv "$tmp/amiro" "$dest.partial"
rm -rf "$dest"; mv "$dest.partial" "$dest"
ln -sfn "$dest" "$AMIRO_HOME/app/current"
# Keep the previous two versions for a quick rollback.
# shellcheck disable=SC2010,SC2012  # version dirs are ours: no odd file names
ls -1dt "$AMIRO_HOME"/app/*/ 2>/dev/null | grep -v '/current/$' | tail -n +4 | while IFS= read -r old; do
  rm -rf "$old"
done
if [ "$(uname -s)" = Darwin ]; then xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true; fi
ok "Installed Amiro $version to $dest"

bin_dir="$HOME/.local/bin"
mkdir -p "$bin_dir"
ln -sfn "$AMIRO_HOME/app/current/amiro" "$bin_dir/amiro"
case ":$PATH:" in
  *":$bin_dir:"*) path_hint="" ;;
  *)
    path_hint="$bin_dir"
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      grep -q '.local/bin' "$rc" 2>/dev/null || printf '\n# Added by the Amiro installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
    done ;;
esac
amiro="$AMIRO_HOME/app/current/amiro"

if [ "$(uname -s)" = Linux ] && ! { ldconfig -p 2>/dev/null | grep -q libssl.so.3 || ls /usr/lib*/libssl.so.3 /lib/*/libssl.so.3 >/dev/null 2>&1 || ls /usr/lib/*/libssl.so.3 >/dev/null 2>&1; }; then
  printf '%s! OpenSSL 3 not found; the agent runtime needs it:%s sudo apt install libssl3  (or: sudo dnf install openssl-libs)\n' "$R" "$N"
fi

"$amiro" setup ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} >/dev/null && ok "Settings in $AMIRO_HOME/amiro.toml"

if [ "$SERVICE" = 1 ]; then
  "$amiro" service install
elif [ "$START" = 1 ]; then
  if "$amiro" status 2>/dev/null | grep -q running; then "$amiro" restart; else "$amiro" start; fi
fi

printf '\n%sNext%s\n' "$B" "$N"
if [ "$START" = 1 ] || [ "$SERVICE" = 1 ]; then
  printf '  Open the address above. The setup wizard creates your account,\n  names your agent and connects an AI provider.\n'
else
  printf '  %samiro start%s, then open the address it prints.\n' "$B" "$N"
fi
printf '  %samiro help%s  for everything else (service, logs, update, reset-password).\n' "$B" "$N"
[ -n "${path_hint:-}" ] && printf '  %sOpen a new terminal (or run: export PATH="$HOME/.local/bin:$PATH") to use `amiro`.%s\n' "$D" "$N"
printf '\n'
