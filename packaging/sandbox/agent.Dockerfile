# The image every agent's container runs. Includes Vellum-parity virtual desktop
# packages (Xtigervnc, openbox, xcompmgr, plank, chromium, thunar, xfce4-terminal,
# feh, librsvg2-bin, adwaita-icon-theme) so each agent can stream a real X11
# desktop over VNC to @novnc/novnc.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk procps \
      ca-certificates curl git python3 jq less file unzip \
      tigervnc-standalone-server openbox xcompmgr plank \
      chromium thunar xfce4-terminal feh librsvg2-bin \
      dbus-x11 adwaita-icon-theme fonts-liberation fonts-dejavu-core \
      x11-xserver-utils xdotool socat \
 && rm -rf /var/lib/apt/lists/* \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true \
 && mkdir -p /home/agent

COPY amiro-desktop-start.sh /usr/local/bin/amiro-desktop-start
RUN chmod +x /usr/local/bin/amiro-desktop-start

ENV HOME=/home/agent
WORKDIR /home/agent
CMD ["sleep", "infinity"]
