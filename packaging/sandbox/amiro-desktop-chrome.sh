#!/usr/bin/env bash
# Chromium on the agent's desktop, with its persistent per-agent profile. A
# second call opens the URL as a tab in the running browser. DevTools listens
# on the container's loopback only, so amiro-desktop-state can read each tab's
# address; nothing outside the container can reach it.
. /usr/local/share/amiro/desktop-env
# Chromium hangs at start under nss_wrapper and needs no user name.
unset LD_PRELOAD NSS_WRAPPER_PASSWD NSS_WRAPPER_GROUP
exec chromium \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-gpu \
  --password-store=basic \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="/home/agent/.browser" \
  --window-size=1280,700 \
  --window-position=80,28 \
  "$@"
