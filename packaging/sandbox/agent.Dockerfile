# The image every team agent's container runs. A plain shell host: the
# supervisor starts it as the owner's uid (never root) with no capabilities,
# a read-only root filesystem and only the agent's folder mounted at
# /home/agent. No sudo, no setuid helpers the agent could use.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk procps \
      ca-certificates curl git python3 jq less file unzip \
 && rm -rf /var/lib/apt/lists/* \
 # Remove setuid/setgid bits; no-new-privileges already blocks them, this
 # removes the temptation.
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true \
 && mkdir -p /home/agent

ENV HOME=/home/agent
WORKDIR /home/agent
CMD ["sleep", "infinity"]
