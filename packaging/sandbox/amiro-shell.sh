#!/usr/bin/env bash
# The agent's one shared shell: a tmux session named "agent". The terminal
# windows on its desktop (the TV) and Admin → Debug's terminal all attach to
# it, so they show the same shell and what is typed in one appears in all.
#
#   amiro-shell [folder]   attach; with a folder, first open a window there
set -euo pipefail
. /usr/local/share/amiro/desktop-env

DIR="${1:-}"
TMUX_CONF=/usr/local/share/amiro/tmux.conf
SHELL_CMD="bash --rcfile /usr/local/share/amiro/desktop-bashrc -i"
tmux_() { tmux -f "$TMUX_CONF" "$@"; }

if tmux_ has-session -t agent 2>/dev/null; then
  if [ -n "$DIR" ]; then
    tmux_ new-window -t agent: -c "$DIR" "$SHELL_CMD"
  fi
  exec tmux -f "$TMUX_CONF" attach-session -t agent
fi
exec tmux -f "$TMUX_CONF" new-session -s agent -c "${DIR:-$AMIRO_DESKTOP_HOME}" "$SHELL_CMD"
