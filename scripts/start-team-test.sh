#!/usr/bin/env bash
# Start a brand-new Amiro from this checkout for testing the Team view:
# an empty AMIRO_HOME every run (so onboarding starts from scratch), this
# checkout's backend, static UI (out/) and runtime. Never touches ~/.amiro.
#
#   bash scripts/start-team-test.sh            # port 3003, reachable on the VM's IP
#   AMIRO_PORT=3010 bash scripts/start-team-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

export AMIRO_HOME="/tmp/amiro-team-test-${STAMP}"
export AMIRO_PORT="${AMIRO_PORT:-3003}"
export AMIRO_HOST="${AMIRO_HOST:-0.0.0.0}"
export AMIRO_OUT_DIR="${ROOT}/out"
export AMIRO_RUNTIME_BIN="${ROOT}/runtime/target/debug/amiro-runtime"
unset AMIRO_SKIP_ONBOARDING AMIRO_RUNTIME_HOME AMIRO_API_SOCKET AMIRO_OWNER_EMAIL AMIRO_OWNER_PASSWORD

for need in "${ROOT}/backend/target/debug/amiro-backend" "${AMIRO_RUNTIME_BIN}" "${AMIRO_OUT_DIR}/index.html"; do
  [ -e "$need" ] || { echo "missing $need — build first (pnpm build; pnpm native:build)" >&2; exit 1; }
done

mkdir -p "${AMIRO_HOME}"
echo "Fresh Amiro home: ${AMIRO_HOME}"
echo "Open: http://127.0.0.1:${AMIRO_PORT}/  (or http://<vm-ip>:${AMIRO_PORT}/)"
echo "Stop with Ctrl-C."
exec "${ROOT}/backend/target/debug/amiro-backend"
