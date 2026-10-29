#!/usr/bin/env bash
# Open something on the agent's virtual desktop (started by amiro-desktop-start)
# and print the desktop state afterwards.
#
#   amiro-desktop-open browser <URL or file>    a Chromium tab: an http(s) URL,
#                                               or a file (path or file://)
#   amiro-desktop-open files [folder]           a Files (Thunar) window
#   amiro-desktop-open terminal [folder]        a terminal starting in folder
#
# Folders are absolute or relative to /home/agent and must exist.
set -euo pipefail

APP="${1:-}"
TARGET="${2:-}"
. /usr/local/share/amiro/desktop-env

fail() {
  echo "$1" >&2
  exit 2
}

# A path as the desktop shows it: under the agent's real path when that is
# mounted (see desktop-env), so Files and the terminal name it exactly.
desktop_path() {
  local path="${1:-$AMIRO_DESKTOP_HOME}"
  case "$path" in
    /home/agent) path="$AMIRO_DESKTOP_HOME" ;;
    /home/agent/*) path="$AMIRO_DESKTOP_HOME/${path#/home/agent/}" ;;
    /*) ;;
    *) path="$AMIRO_DESKTOP_HOME/$path" ;;
  esac
  printf '%s\n' "$path"
}

folder() {
  local dir
  dir="$(desktop_path "${1:-}")"
  [ -d "$dir" ] || fail "no such folder: $dir"
  (cd "$dir" && pwd -L)
}

# A workspace file as a file:// URL for the browser.
open_file() {
  local file
  file="$(desktop_path "$1")"
  [ -f "$file" ] || fail "no such file: $file (for a website, pass an http(s) URL)"
  printf 'file://%s\n' "$file"
}

# Is anything listening on this TCP port inside the desktop? (hex, LISTEN=0A)
listening_here() {
  local hex
  hex="$(printf '%04X' "$1")"
  grep -qs ":$hex [0-9A-F:]* 0A " /proc/net/tcp /proc/net/tcp6
}

case "$APP" in
  browser)
    case "$TARGET" in
      http://localhost*|https://localhost*|http://127.0.0.1*|https://127.0.0.1*|http://\[::1\]*|https://\[::1\]*)
        # The desktop is its own machine: its localhost is not wherever the
        # agent's shell started a server. Say so instead of a dead tab.
        hostport="${TARGET#*://}"; hostport="${hostport%%/*}"; hostport="${hostport%%\?*}"
        port="${hostport##*:}"
        case "$port" in
          ''|*[!0-9]*) case "$TARGET" in https:*) port=443 ;; *) port=80 ;; esac ;;
        esac
        listening_here "$port" || fail "nothing is listening on port $port inside your desktop. The desktop is a separate machine, so a server started in your shell is not reachable from it. To show a workspace file (an HTML page, image or PDF), pass its path instead, e.g. /home/agent/apps/page.html"
        ;;
      http://*|https://*) ;;
      file://*|/*) TARGET="$(open_file "${TARGET#file://}")" || exit 2 ;;
      *://*) fail "browser needs an http(s) URL or a file path" ;;
      *) TARGET="$(open_file "$TARGET")" || exit 2 ;;
    esac
    nohup /usr/local/bin/amiro-desktop-chrome "$TARGET" </dev/null >>/tmp/chrome.log 2>&1 &
    ;;
  files)
    DIR="$(folder "$TARGET")"
    nohup thunar "$DIR" </dev/null >>/tmp/thunar.log 2>&1 &
    ;;
  terminal)
    DIR="$(folder "$TARGET")"
    nohup /usr/local/bin/amiro-desktop-terminal "$DIR" </dev/null >>/tmp/terminal.log 2>&1 &
    ;;
  *)
    fail "usage: amiro-desktop-open browser|files|terminal [target]"
    ;;
esac

# Let the window map (and the page title load) before reporting.
for _ in $(seq 1 30); do
  sleep 0.2
  if /usr/local/bin/amiro-desktop-state --wait-for "$APP" >/dev/null 2>&1; then
    break
  fi
done
exec /usr/local/bin/amiro-desktop-state
