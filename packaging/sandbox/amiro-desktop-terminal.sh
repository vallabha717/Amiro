#!/usr/bin/env bash
# A terminal window on the agent's desktop, attached to the agent's shared
# shell (amiro-shell), opening a shell window in "$1" when given. Admin →
# Debug shows the same shell.
. /usr/local/share/amiro/desktop-env
DIR="${1:-}"
exec xfce4-terminal \
  ${DIR:+--working-directory="$DIR"} \
  --dynamic-title-mode=replace \
  --initial-title="$(cat /tmp/desktop-agent-name 2>/dev/null || echo Agent)" \
  --execute /usr/local/bin/amiro-shell ${DIR:+"$DIR"}
