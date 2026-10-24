#!/usr/bin/env bash
# Run Amiro's team-agent sandbox: the supervisor that gives every team agent
# its own hardened container (docs/multi-agent-team-isolation/).
#
#   bash scripts/sandbox.sh up        # create secrets if missing, build, start
#   bash scripts/sandbox.sh status    # supervisor health
#   bash scripts/sandbox.sh down      # stop the supervisor (agent containers stay)
#
# Honours AMIRO_HOME (default ~/.amiro), AMIRO_SANDBOX_PORT (4313),
# AMIRO_SANDBOX_NAMESPACE (amiro), AMIRO_SANDBOX_NETWORK (bridge|none),
# AMIRO_SANDBOX_RUNTIME (e.g. runsc). The secrets file is never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/packaging/sandbox/compose.yml"

AMIRO_HOME="${AMIRO_HOME:-$HOME/.amiro}"
export AMIRO_SANDBOX_PORT="${AMIRO_SANDBOX_PORT:-4313}"
export AMIRO_SANDBOX_NAMESPACE="${AMIRO_SANDBOX_NAMESPACE:-amiro}"
export AMIRO_SANDBOX_ENV_FILE="${AMIRO_SANDBOX_ENV_FILE:-${AMIRO_HOME}/sandbox/supervisor.env}"
export AMIRO_SANDBOX_AGENTS_ROOT="${AMIRO_SANDBOX_AGENTS_ROOT:-${AMIRO_HOME}/agents}"
export DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
PROJECT="amiro-sandbox-${AMIRO_SANDBOX_NAMESPACE}"

compose() {
  # Snap-packaged Docker CLI cannot read files inside hidden dot-directories
  # such as ~/.herdr/worktrees/..., so pass the compose file via stdin (-f -)
  # with --project-directory when the path contains a dot-segment.
  case "${COMPOSE_FILE}" in
    */.*)
      docker compose -p "${PROJECT}" --project-directory "$(dirname "${COMPOSE_FILE}")" -f - "$@" < "${COMPOSE_FILE}"
      ;;
    *)
      docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" "$@"
      ;;
  esac
}

ensure_secrets() {
  if [ -s "${AMIRO_SANDBOX_ENV_FILE}" ]; then
    return
  fi
  mkdir -p "$(dirname "${AMIRO_SANDBOX_ENV_FILE}")"
  chmod 700 "$(dirname "${AMIRO_SANDBOX_ENV_FILE}")"
  (
    umask 077
    {
      echo "# Amiro sandbox secrets. Read by amiro-backend and amiro-sandboxd. Keep private."
      echo "AMIRO_SANDBOX_TOKEN=$(openssl rand -hex 32)"
      echo "AMIRO_SANDBOX_MASTER=$(openssl rand -hex 32)"
    } > "${AMIRO_SANDBOX_ENV_FILE}"
  )
  echo "Created ${AMIRO_SANDBOX_ENV_FILE} (0600)."
}

load_secrets() {
  AMIRO_SANDBOX_TOKEN="$(sed -n 's/^AMIRO_SANDBOX_TOKEN=//p' "${AMIRO_SANDBOX_ENV_FILE}")"
  AMIRO_SANDBOX_MASTER="$(sed -n 's/^AMIRO_SANDBOX_MASTER=//p' "${AMIRO_SANDBOX_ENV_FILE}")"
  export AMIRO_SANDBOX_TOKEN AMIRO_SANDBOX_MASTER
}

wait_healthy() {
  local url="http://127.0.0.1:${AMIRO_SANDBOX_PORT}/health"
  for _ in $(seq 1 30); do
    if curl -fsS "${url}" 2>/dev/null | grep -q '"docker":true'; then
      echo "Supervisor is up at http://127.0.0.1:${AMIRO_SANDBOX_PORT} (Docker reachable)."
      return 0
    fi
    sleep 1
  done
  echo "Supervisor did not become healthy; see: docker compose -p ${PROJECT} logs supervisor" >&2
  return 1
}

case "${1:-}" in
  up)
    uid="$(id -u)"
    gid="$(id -g)"
    if [ "${uid}" = "0" ] || [ "${gid}" = "0" ]; then
      echo "Run this as the user Amiro runs as, not root: agent containers never run as uid 0." >&2
      exit 1
    fi
    export AMIRO_SANDBOX_USER="${uid}:${gid}"
    export DOCKER_GID="$(stat -c %g "${DOCKER_SOCKET}")"
    # Snap-packaged Docker's AppArmor profile refuses every exec under
    # no-new-privileges, so containers could not start at all. Turn it off
    # there, loudly; the agent page's isolation check shows it too.
    if docker info --format '{{.DockerRootDir}}' 2>/dev/null | grep -q '/snap/'; then
      echo "WARNING: snap-packaged Docker detected. It cannot run containers with" >&2
      echo "         no-new-privileges, so it is turned off for the supervisor and agents." >&2
      echo "         Install Docker Engine from docker.com packages to keep it on." >&2
      export AMIRO_SANDBOX_NO_NEW_PRIVILEGES="${AMIRO_SANDBOX_NO_NEW_PRIVILEGES:-false}"
    fi
    export AMIRO_SANDBOX_NO_NEW_PRIVILEGES="${AMIRO_SANDBOX_NO_NEW_PRIVILEGES:-true}"
    mkdir -p "${AMIRO_SANDBOX_AGENTS_ROOT}"
    ensure_secrets
    load_secrets
    # AMIRO_SANDBOX_SKIP_BUILD=1 reuses existing images (the E2E runner does).
    if [ "${AMIRO_SANDBOX_SKIP_BUILD:-0}" != "1" ]; then
      compose --profile build build agent-image supervisor
    fi
    compose up -d supervisor
    wait_healthy
    ;;
  down)
    export AMIRO_SANDBOX_USER="${AMIRO_SANDBOX_USER:-1:1}" DOCKER_GID="${DOCKER_GID:-0}"
    export AMIRO_SANDBOX_TOKEN=unused AMIRO_SANDBOX_MASTER=unused
    compose down
    ;;
  status)
    curl -fsS "http://127.0.0.1:${AMIRO_SANDBOX_PORT}/health" && echo || {
      echo "Supervisor not reachable on 127.0.0.1:${AMIRO_SANDBOX_PORT}." >&2
      exit 1
    }
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
