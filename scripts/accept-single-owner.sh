#!/usr/bin/env bash
# Acceptance check for the single-owner flow, run against a throwaway AMIRO_HOME.
# Usage: scripts/accept-single-owner.sh <fresh-empty-home-dir> <port> [composio-key]
set -u
HOME_DIR="$1"
PORT="${2:-3100}"
KEY="${3:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="localhost:${PORT}"

mkdir -p "${HOME_DIR}"
if [ -n "${KEY}" ]; then
  printf '[composio]\napi_key = "%s"\n' "${KEY}" > "${HOME_DIR}/amiro.toml"
  chmod 600 "${HOME_DIR}/amiro.toml"
fi

setsid env AMIRO_HOME="${HOME_DIR}" AMIRO_SKIP_ONBOARDING=1 AMIRO_HOST=127.0.0.1 AMIRO_PORT="${PORT}" \
  AMIRO_OUT_DIR="${ROOT}/out" \
  AMIRO_RUNTIME_BIN="${ROOT}/runtime/target/debug/amiro-runtime" \
  AMIRO_NO_TELEMETRY=1 \
  "${ROOT}/backend/target/debug/amiro-backend" > "${HOME_DIR}/backend.log" 2>&1 < /dev/null &
sleep 10

echo "status:    $(curl -s ${BASE}/api/auth/status)"
echo "register:  $(curl -s -o /dev/null -w '%{http_code}' -X POST ${BASE}/api/auth/register -H 'content-type: application/json' -d '{}')"
echo "weak pw:   $(curl -s -X POST ${BASE}/api/auth/setup -H 'content-type: application/json' -d '{"email":"owner@x.io","password":"short"}')"
RESP="$(curl -s -X POST ${BASE}/api/auth/setup -H 'content-type: application/json' -d '{"email":"owner@x.io","password":"Correct-horse-9battery"}')"
echo "setup:     $(echo "${RESP}" | head -c 100)"
TOKEN="$(echo "${RESP}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')"
echo "${TOKEN}" > "${HOME_DIR}/token"
echo "setup#2:   $(curl -s -o /dev/null -w '%{http_code}' -X POST ${BASE}/api/auth/setup -H 'content-type: application/json' -d '{"email":"b@x.io","password":"Correct-horse-9battery"}')"
AUTH="Authorization: Bearer ${TOKEN}"
echo "cfg:       $(curl -s -H "${AUTH}" ${BASE}/api/composio/config)"
if [ -n "${KEY}" ]; then
  echo "put:       $(curl -s -X PUT -H "${AUTH}" -H 'content-type: application/json' -d "{\"service\":\"composio\",\"field\":\"api_key\",\"value\":\"${KEY}\",\"label\":\"Composio\"}" ${BASE}/api/credentials)"
fi
echo "list:      $(curl -s -H "${AUTH}" ${BASE}/api/credentials)"
echo "validate:  $(curl -s -X POST -H "${AUTH}" -H 'content-type: application/json' -d '{"service":"composio","field":"api_key"}' ${BASE}/api/credentials/validate)"
echo "cfg after: $(curl -s -H "${AUTH}" ${BASE}/api/composio/config)"
ls -l "${HOME_DIR}/protected" 2>&1
if [ -n "${KEY}" ]; then
  echo "plaintext hits in credentials.enc: $(grep -c "${KEY}" "${HOME_DIR}/protected/credentials.enc" 2>/dev/null)"
fi
