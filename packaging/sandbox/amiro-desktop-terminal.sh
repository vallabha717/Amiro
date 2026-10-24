#!/usr/bin/env bash
# A terminal on the agent's desktop, starting in "$1" (default /home/agent).
# Its bash titles the window with the folder it is in, so the TV and the
# agent always see the exact path.
. /usr/local/share/amiro/desktop-env
DIR="${1:-/home/agent}"
exec xfce4-terminal \
  --working-directory="$DIR" \
  --dynamic-title-mode=replace \
  --initial-title="$DIR" \
  --execute bash --rcfile /usr/local/share/amiro/desktop-bashrc -i
