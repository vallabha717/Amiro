#!/usr/bin/env bash
# ============================================================================
# amiro-server.sh -- first-class Amiro server / VM service manager.
#
# Runs the single-binary native backend (`amiro-backend`) that serves both the
# Web UI (the static Next `out/` export) and the JSON API on one port, and
# manages it as a foreground process, a background daemon, or a systemd
# service that starts automatically on boot.
#
# Usage:
#   scripts/amiro-server.sh <command> [options]
#
# Commands:
#   start [--host H] [--port P] [--daemon]   start the server (foreground by
#                                            default; --daemon detaches with
#                                            nohup and a pidfile)
#   stop                                     stop a --daemon start
#   restart [...]                            stop then start
#   status                                   process + listener + service state
#   urls                                     print every URL the UI answers on
#   install-service [--user|--system]        generate + install + enable a
#                                            systemd unit (amiro.service) that
#                                            starts Amiro on boot
#   uninstall-service [--user|--system]     disable + remove the unit
#   service-status                           systemctl status for the unit
#   print-unit                              print the generated unit (no write)
#
# Options:
#   --host H        bind host (default $AMIRO_HOST, or 127.0.0.1; 0.0.0.0
#                   binds every interface so the VM's Web UI is reachable
#                   from anywhere)
#   --port P        port (default $AMIRO_PORT, or 3000)
#   --backend BIN   backend binary (default backend/target/release/amiro-backend,
#                   then the debug build)
#   --allowed-origin L
#                   AMIRO_ALLOWED_ORIGIN for the child (e.g. "*" behind your
#                   own authenticated proxy, or a comma-separated origin list)
#   --token T       AMIRO_TOKEN sidecar secret (generated to a state file and
#                   reused across restarts when not given)
#   --yes, -y       assume yes for privileged systemd (--system) installs
#   --help, -h      this help
#
# Security note: binding 0.0.0.0 exposes Amiro to the network. The first-run
# owner setup plus the per-user session layer still gate the API, but put TLS
# (e.g. caddy/nginx) and a network boundary in front for any public VM, and
# set AMIRO_TOKEN so the sidecar secret is required too.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${AMIRO_SERVER_STATE_DIR:-$REPO_ROOT/.amiro-server}"
PID_FILE="$STATE_DIR/amiro-server.pid"
LOG_FILE="$STATE_DIR/amiro-server.log"
TOKEN_FILE="$STATE_DIR/amiro-token"
UNIT_NAME="amiro.service"

# `[server] key = value` from amiro.toml (AMIRO_CONFIG, ./amiro.toml, then
# ~/.amiro/amiro.toml), so the script and the backend agree on host/port/token.
CONFIG_FILE="${AMIRO_CONFIG:-}"
if [ -z "$CONFIG_FILE" ]; then
  for candidate in "$PWD/amiro.toml" "${AMIRO_HOME:-$HOME/.amiro}/amiro.toml"; do
    [ -f "$candidate" ] && { CONFIG_FILE="$candidate"; break; }
  done
fi
toml_server() {
  [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ] || return 0
  awk -v key="$1" '
    /^[[:space:]]*\[/ { section = $0; gsub(/[[:space:]\[\]]/, "", section); next }
    section == "server" {
      line = $0; sub(/#.*/, "", line)
      split(line, kv, "=")
      k = kv[1]; gsub(/[[:space:]]/, "", k)
      if (k == key) { v = substr(line, index(line, "=") + 1); gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", v); print v; exit }
    }' "$CONFIG_FILE"
}

HOST="${AMIRO_HOST:-$(toml_server host)}"; HOST="${HOST:-127.0.0.1}"
PORT="${AMIRO_PORT:-$(toml_server port)}"; PORT="${PORT:-3000}"
BACKEND=""
ALLOWED_ORIGIN="${AMIRO_ALLOWED_ORIGIN:-$(toml_server allowed_origin)}"
TOKEN="${AMIRO_TOKEN:-$(toml_server token)}"
DAEMON=0
ASSUME_YES=0
SCOPE="user"

say()  { printf '%s\n' "$*"; }
err()  { printf 'error: %s\n' "$*" >&2; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '3,45p' "${BASH_SOURCE[0]}"; }

# ---------------------------------------------------------------------------
# Backend binary resolution (release build, then debug, then PATH)
# ---------------------------------------------------------------------------
resolve_backend() {
  if [ -n "$BACKEND" ]; then
    [ -x "$BACKEND" ] || die "backend binary not executable: $BACKEND"
    printf '%s\n' "$BACKEND"
    return 0
  fi
  for candidate in \
    "$REPO_ROOT/backend/target/release/amiro-backend" \
    "$REPO_ROOT/backend/target/debug/amiro-backend" \
    "$(command -v amiro-backend 2>/dev/null || true)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  die "amiro-backend not found. Build it with: scripts/build-native.sh (or pass --backend /path/to/amiro-backend)"
}

# A stable sidecar secret so a restart does not invalidate running browsers.
ensure_token() {
  if [ -n "$TOKEN" ]; then
    printf '%s\n' "$TOKEN"
    return 0
  fi
  if [ -s "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  local generated
  generated="$(head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')" \
    || generated="$(date +%s%N 2>/dev/null || date +%s)-$$"
  printf '%s\n' "$generated" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  printf '%s\n' "$generated"
}

# ---------------------------------------------------------------------------
# URL / listener helpers
# ---------------------------------------------------------------------------
is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
}

lan_ipv4_addresses() {
  local addresses=""
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    addresses="$(hostname -I 2>/dev/null || true)"
  fi
  if [ -z "$addresses" ] && command -v ip >/dev/null 2>&1; then
    addresses="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ' || true)"
  fi
  if [ -z "$addresses" ] && command -v ifconfig >/dev/null 2>&1; then
    addresses="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {print $2}' | tr '\n' ' ' || true)"
  fi
  printf '%s\n' $addresses 2>/dev/null | grep -v '^127\.' || true
}

print_urls() {
  local host="$1" port="$2"
  say "Web UI URLs for this machine (port $port):"
  say "  http://localhost:${port}"
  local ip
  while IFS= read -r ip; do
    [ -n "$ip" ] || continue
    say "  http://${ip}:${port}"
  done < <(lan_ipv4_addresses)
  if [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ]; then
    say "(bound to $host: reachable from other machines on the ports above)"
  else
    say "(bound to $host only)"
  fi
}

wait_for_port() {
  local port="$1" waited=0
  while ! is_listening "$port" && [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  is_listening "$port"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_start() {
  local daemon_flag=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --host) HOST="${2:?--host requires a value}"; shift 2 ;;
      --port) PORT="${2:?--port requires a value}"; shift 2 ;;
      --daemon) daemon_flag=1; shift ;;
      *) die "unknown option for start: $1 (see --help)" ;;
    esac
  done

  local backend token
  backend="$(resolve_backend)"
  token="$(ensure_token)"
  mkdir -p "$STATE_DIR"

  if is_listening "$PORT"; then
    die "port $PORT is already in use. Stop that process or pass --port."
  fi

  export AMIRO_HOST="$HOST"
  export AMIRO_PORT="$PORT"
  export AMIRO_TOKEN="$token"
  export AMIRO_HOME="${AMIRO_HOME:-$HOME/.amiro}"
  [ -n "$ALLOWED_ORIGIN" ] && export AMIRO_ALLOWED_ORIGIN="$ALLOWED_ORIGIN" || true

  say "Starting Amiro server"
  say "  backend: $backend"
  say "  bind:    $HOST:$PORT"
  say "  home:    $AMIRO_HOME"
  say "  log:     $LOG_FILE"

  if [ "$daemon_flag" = "1" ]; then
    nohup "$backend" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    printf '%s\n' "$pid" > "$PID_FILE"
    say "  pid:     $pid (daemon; stop with: scripts/amiro-server.sh stop)"
  else
    print_urls "$HOST" "$PORT"
    say ""
    exec "$backend"
  fi

  if wait_for_port "$PORT"; then
    say "Amiro server is up."
    print_urls "$HOST" "$PORT"
  else
    warn "server did not open port $PORT within 30s; check $LOG_FILE"
    exit 1
  fi
}

cmd_stop() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      local waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
        sleep 0.25
        waited=$((waited + 1))
      done
      kill -KILL "$pid" 2>/dev/null || true
      say "stopped daemon pid $pid"
    else
      say "no running daemon found (stale pidfile removed)"
    fi
    rm -f "$PID_FILE"
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
    systemctl --user stop "$UNIT_NAME"
    say "stopped systemd user service $UNIT_NAME"
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active "$UNIT_NAME" >/dev/null 2>&1; then
    say "the system service $UNIT_NAME is active; stop it with:"
    say "  scripts/amiro-server.sh uninstall-service --system"
    return 0
  fi
  say "nothing to stop (no pidfile, no active service)"
}

cmd_restart() {
  cmd_stop || true
  cmd_start "$@"
}

cmd_status() {
  local backend
  backend="$(resolve_backend 2>/dev/null || true)"
  say "Amiro server status"
  say "  backend: ${backend:-not built (run scripts/build-native.sh)}"
  say "  bind:    $HOST:$PORT"
  say "  state:   $STATE_DIR"
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      say "  daemon:  running (pid $pid)"
    else
      say "  daemon:  stale pidfile"
    fi
  else
    say "  daemon:  not running"
  fi
  if is_listening "$PORT"; then
    say "  listener: port $PORT is OPEN"
  else
    say "  listener: port $PORT is closed"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1 || systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
      say "  service: systemd user unit $UNIT_NAME present ($(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo unknown))"
    elif systemctl is-enabled "$UNIT_NAME" >/dev/null 2>&1 || systemctl is-active "$UNIT_NAME" >/dev/null 2>&1; then
      say "  service: systemd system unit $UNIT_NAME present ($(systemctl is-active "$UNIT_NAME" 2>/dev/null || echo unknown))"
    else
      say "  service: no systemd unit installed"
    fi
  else
    say "  service: systemctl not available"
  fi
}

cmd_urls() {
  print_urls "$HOST" "$PORT"
}

# ---------------------------------------------------------------------------
# systemd unit generation (shared with scripts/install-vm-service.sh)
# ---------------------------------------------------------------------------
unit_path_for_scope() {
  if [ "$SCOPE" = "user" ]; then
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
  else
    printf '%s\n' "/etc/systemd/system/$UNIT_NAME"
  fi
}

generate_unit() {
  local backend token
  backend="$(resolve_backend)"
  token="$(ensure_token)"
  local workdir="$REPO_ROOT"
  cat <<UNIT
# Generated by scripts/amiro-server.sh -- do not edit by hand.
[Unit]
Description=Amiro server (Web UI + API on one port)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workdir}
ExecStart=${backend}
Environment=AMIRO_HOST=${HOST}
Environment=AMIRO_PORT=${PORT}
Environment=AMIRO_TOKEN=${token}
Environment=AMIRO_HOME=${AMIRO_HOME:-$HOME/.amiro}
${ALLOWED_ORIGIN:+Environment=AMIRO_ALLOWED_ORIGIN=${ALLOWED_ORIGIN}}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
}

cmd_print_unit() {
  generate_unit
}

cmd_install_service() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --user) SCOPE="user"; shift ;;
      --system) SCOPE="system"; shift ;;
      *) die "unknown option for install-service: $1 (see --help)" ;;
    esac
  done
  command -v systemctl >/dev/null 2>&1 \
    || die "systemctl not found; systemd is required for install-service"

  local unit_path
  unit_path="$(unit_path_for_scope)"

  if [ "$SCOPE" = "system" ]; then
    [ "$(id -u)" = "0" ] || SUDO="sudo"
    say "About to write $unit_path and run: ${SUDO:-}systemctl daemon-reload, enable --now $UNIT_NAME"
    if [ "$ASSUME_YES" != "1" ]; then
      read -r -p "Install the SYSTEM service? [y/N] " reply || true
      case "$reply" in y|Y|yes|YES) ;; *) die "declined; re-run with --yes to accept" ;; esac
    fi
    ${SUDO:-} mkdir -p "$(dirname "$unit_path")"
    generate_unit | ${SUDO:-} tee "$unit_path" >/dev/null
    ${SUDO:-} systemctl daemon-reload
    ${SUDO:-} systemctl enable --now "$UNIT_NAME"
    ${SUDO:-} systemctl restart "$UNIT_NAME"
  else
    say "Installing the USER service (survives reboot after 'loginctl enable-linger $USER'; no root needed)"
    mkdir -p "$(dirname "$unit_path")"
    generate_unit > "$unit_path"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME"
    systemctl --user restart "$UNIT_NAME"
    if command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$USER" 2>/dev/null \
        && say "linger enabled for $USER (the user service now starts at boot)" \
        || warn "could not enable linger; run: loginctl enable-linger $USER"
    fi
  fi

  say ""
  say "Installed $UNIT_NAME ($SCOPE scope)"
  say "  status:   systemctl ${SCOPE} status $UNIT_NAME"
  say "  journal:  journalctl ${SCOPE} -u $UNIT_NAME -f"
  print_urls "$HOST" "$PORT"
}

cmd_uninstall_service() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --user) SCOPE="user"; shift ;;
      --system) SCOPE="system"; shift ;;
      *) die "unknown option for uninstall-service: $1 (see --help)" ;;
    esac
  done
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
  if [ "$SCOPE" = "system" ]; then
    [ "$(id -u)" = "0" ] || SUDO="sudo"
    ${SUDO:-} systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
    ${SUDO:-} rm -f "$(unit_path_for_scope)"
    ${SUDO:-} systemctl daemon-reload
  else
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$(unit_path_for_scope)"
    systemctl --user daemon-reload
  fi
  say "removed $UNIT_NAME ($SCOPE scope)"
}

cmd_service_status() {
  if ! command -v systemctl >/dev/null 2>&1; then
    die "systemctl not found"
  fi
  if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
    systemctl --user status "$UNIT_NAME" || true
  elif systemctl is-active "$UNIT_NAME" >/dev/null 2>&1; then
    systemctl status "$UNIT_NAME" || true
  else
    say "$UNIT_NAME is not active in either scope"
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing (global flags first, then the command)
# ---------------------------------------------------------------------------
COMMAND="${1:-help}"
[ $# -gt 0 ] && shift || true

case "$COMMAND" in
  start)             cmd_start "$@" ;;
  stop)              cmd_stop ;;
  restart)           cmd_restart "$@" ;;
  status)            cmd_status ;;
  urls)              cmd_urls ;;
  print-unit)        cmd_print_unit ;;
  install-service)   cmd_install_service "$@" ;;
  uninstall-service) cmd_uninstall_service "$@" ;;
  service-status)    cmd_service_status ;;
  help|--help|-h)    usage ;;
  *)
    err "unknown command: $COMMAND"
    usage >&2
    exit 2
    ;;
esac
