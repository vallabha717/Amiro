#!/usr/bin/env bash
# Record whose computer this is, for the shared shell's prompt and the TV:
#   amiro-desktop-identity <agent name> <folder mounted at /home/agent, as the
#                                        owner sees it on their computer>
set -euo pipefail
printf '%s\n' "${1:-Agent}" > /tmp/desktop-agent-name
printf '%s\n' "${2:-/home/agent}" > /tmp/desktop-agent-home
