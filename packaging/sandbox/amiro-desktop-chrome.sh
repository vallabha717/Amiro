#!/usr/bin/env bash
# Chromium on the agent's desktop, with its persistent per-agent profile. A
# second call opens the URL as a tab in the running browser. DevTools listens
# on the container's loopback only, so amiro-desktop-state can read each tab's
# address; nothing outside the container can reach it.
. /usr/local/share/amiro/desktop-env
# The profile persists across containers, and so does Chromium's lock: after
# the container is recreated it names a host that no longer exists, and
# Chromium refuses to start with a "profile in use" dialog. Clear a lock that
# belongs to another host or to a process that is gone; a live Chromium in
# this container keeps its lock, and this call opens a tab in it instead.
lock="$(readlink /home/agent/.browser/SingletonLock 2>/dev/null || true)"
if [ -n "$lock" ]; then
  lock_host="${lock%-*}"
  lock_pid="${lock##*-}"
  if [ "$lock_host" != "$(hostname)" ] || ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f /home/agent/.browser/SingletonLock /home/agent/.browser/SingletonCookie /home/agent/.browser/SingletonSocket
  fi
fi
# Chromium hangs at start under nss_wrapper and needs no user name.
unset LD_PRELOAD NSS_WRAPPER_PASSWD NSS_WRAPPER_GROUP
exec chromium \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --hide-crash-restore-bubble \
  --disable-dev-shm-usage \
  --disable-gpu \
  --password-store=basic \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="/home/agent/.browser" \
  --window-size=1280,700 \
  --window-position=80,28 \
  "$@"
