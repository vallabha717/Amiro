# 03 — Deployment

## Files

```
packaging/sandbox/
├── compose.yml              supervisor service + agent image build target
├── supervisor.Dockerfile    builds backend/sandboxd → debian-slim, non-root
└── agent.Dockerfile         the agent image: sh, bash, coreutils, git, python3, curl
backend/sandboxd/            crate amiro-sandboxd: lib (spec, credential, docker, server) + bin
scripts/sandbox.sh           up | down | status — writes the secrets file, builds, starts
```

## `scripts/sandbox.sh up`

1. Creates `$AMIRO_HOME/sandbox/supervisor.env` (`umask 077`) with
   `AMIRO_SANDBOX_TOKEN` and `AMIRO_SANDBOX_MASTER` from `openssl rand -hex 32`
   if it does not exist. Never prints them.
2. Exports `AMIRO_SANDBOX_USER=$(id -u):$(id -g)` (refuses `0`),
   `AMIRO_SANDBOX_AGENTS_ROOT=$AMIRO_HOME/agents`, `DOCKER_GID` from the
   socket's group.
3. Reads the two secrets from that file into compose's environment (snap
   Docker's CLI cannot read `~/.amiro`, so no `env_file`).
4. On snap-packaged Docker, sets `AMIRO_SANDBOX_NO_NEW_PRIVILEGES=false` with a
   warning: its AppArmor profile refuses every exec under `no-new-privileges`
   (`apparmor="DENIED" … info="no new privs" profile="snap.docker.dockerd"`),
   so no container could start. Docker Engine from docker.com keeps it on.
5. `docker compose -f packaging/sandbox/compose.yml build` (skipped with
   `AMIRO_SANDBOX_SKIP_BUILD=1`) then `up -d supervisor`.
6. Waits for `GET http://127.0.0.1:4313/health` to report `docker: true`.

The backend then finds the supervisor at `AMIRO_SANDBOX_URL` (default
`http://127.0.0.1:4313`) and its secrets in the same file. No restart of the
backend is needed: it reads the file each time it calls the supervisor.

## Supervisor container

- `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true`.
- Runs as a non-root uid with `group_add: [${DOCKER_GID}]` so it can use the
  socket without root.
- `ports: ["127.0.0.1:4313:4313"]` — loopback only.
- Mounts only `/var/run/docker.sock`. It does not mount agent folders; it names
  them in bind mounts of the containers it creates.

## Honest limits (written into `docs/SECURITY-MODEL.md`)

- Containers share the host kernel. `AMIRO_SANDBOX_RUNTIME=runsc` uses gVisor
  if the owner installed it; Amiro does not install it.
- Default network is a normal bridge: an agent with `shell` can reach the
  internet. `AMIRO_SANDBOX_NETWORK=none` cuts it for every agent; a per-agent
  allowlist is Phase 01.
- If the Amiro user itself is in the `docker` group, the **main** agent (host
  tools) can still reach Docker. Team agents cannot. The VM is still the outer
  boundary.
