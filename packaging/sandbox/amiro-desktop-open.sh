#!/usr/bin/env bash
# Open something on the agent's virtual desktop (started by amiro-desktop-start)
# and print the desktop state afterwards.
#
#   amiro-desktop-open browser <http(s) URL>    a Chromium tab
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

# A folder as the desktop shows it: under the agent's real path when that is
# mounted (see desktop-env), so Files and the terminal name it exactly.
folder() {
  local dir="${1:-$AMIRO_DESKTOP_HOME}"
  case "$dir" in
    /home/agent) dir="$AMIRO_DESKTOP_HOME" ;;
    /home/agent/*) dir="$AMIRO_DESKTOP_HOME/${dir#/home/agent/}" ;;
    /*) ;;
    *) dir="$AMIRO_DESKTOP_HOME/$dir" ;;
  esac
  [ -d "$dir" ] || fail "no such folder: $dir"
  (cd "$dir" && pwd -L)
}

case "$APP" in
  browser)
    case "$TARGET" in
      http://*|https://*) ;;
      *) fail "browser needs an http:// or https:// URL" ;;
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
