#!/usr/bin/env bash
# ============================================================================
# install-vm-service.sh -- install Amiro as a boot-time systemd service on a
# Linux VM.
#
# Thin wrapper over scripts/amiro-server.sh install-service so a one-liner
# works on any Linux VM:
#
#   ./scripts/setup-vm.sh --yes --skip-desktop
#   ./scripts/amiro-server.sh start --host 0.0.0.0 --port 3000
#   ./scripts/install-vm-service.sh --user        # (or --system, root/sudo)
#
# The generated unit runs the single-binary amiro-backend on
# 0.0.0.0:${AMIRO_PORT:-3000}, serving out/ (Web UI) + /api on the one port,
# so the VM's Web UI is reachable from anywhere at http://<vm-ip>:3000.
#
# Usage:
#   scripts/install-vm-service.sh [--user|--system] [--host H] [--port P] [--yes]
#
#   --user     systemd user unit (~/.config/systemd/user/amiro.service).
#              No root needed; survives reboots with `loginctl enable-linger`.
#              DEFAULT when run without root.
#   --system   systemd system unit (/etc/systemd/system/amiro.service).
#              Needs root or sudo; the DEFAULT when run as root.
#   --host H   bind host for the unit (default $AMIRO_HOST, or 0.0.0.0 on a
#              VM install -- this is the whole point of this script)
#   --port P   port for the unit (default $AMIRO_PORT, or 3000)
#   --yes, -y  assume yes for the privileged --system path
#   --help, -h this help
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARGS=()
SCOPE_GIVEN=0

# A VM service is the remote-facing install, so the default host is 0.0.0.0
# unless the caller (or AMIRO_HOST) says otherwise.
if [ -z "${AMIRO_HOST:-}" ]; then
  export AMIRO_HOST="0.0.0.0"
fi
if [ -z "${AMIRO_PORT:-}" ]; then
  export AMIRO_PORT="${AMIRO_PORT:-3000}"
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --user)   SCOPE_GIVEN=1; ARGS+=(--user); shift ;;
    --system) SCOPE_GIVEN=1; ARGS+=(--system); shift ;;
    --host)   export AMIRO_HOST="${2:?--host requires a value}"; shift 2 ;;
    --port)   export AMIRO_PORT="${2:?--port requires a value}"; shift 2 ;;
    --yes|-y) ARGS+=(--yes); shift ;;
    --help|-h) sed -n '3,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; echo "try: scripts/install-vm-service.sh --help" >&2; exit 2 ;;
  esac
done

# Default scope: root callers get the system unit, everyone else the user unit.
if [ "$SCOPE_GIVEN" = "0" ]; then
  if [ "$(id -u)" = "0" ]; then
    ARGS+=(--system)
  else
    ARGS+=(--user)
  fi
fi

exec bash "$SCRIPT_DIR/amiro-server.sh" install-service "${ARGS[@]}"
