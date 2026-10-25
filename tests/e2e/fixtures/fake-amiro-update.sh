#!/bin/sh
# Stands in for the installed `amiro` script during E2E (AMIRO_UPDATE_COMMAND):
# `amiro update <version>` prints what the real installer prints, then fails
# the checksum step, so the journey shows a real update job and its failure
# without downloading or replacing anything.
[ "$1" = update ] || { echo "fake amiro: only 'update' is supported" >&2; exit 2; }
printf '\033[1m==>\033[0m Downloading Amiro (%s) for linux-x86_64\n' "$2"
sleep 2
printf '\033[31mx\033[0m checksum mismatch for amiro-server-linux-x86_64.tar.gz; refusing to install\n'
exit 1
