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
      fonts-noto-cjk fonts-noto-color-emoji \
      x11-xserver-utils x11-utils xdotool socat libnss-wrapper \
 && rm -rf /var/lib/apt/lists/* \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true \
 && mkdir -p /home/agent

COPY amiro-desktop-start.sh /usr/local/bin/amiro-desktop-start
COPY amiro-desktop-open.sh /usr/local/bin/amiro-desktop-open
COPY amiro-desktop-state.py /usr/local/bin/amiro-desktop-state
COPY amiro-desktop-chrome.sh /usr/local/bin/amiro-desktop-chrome
COPY amiro-desktop-terminal.sh /usr/local/bin/amiro-desktop-terminal
COPY desktop-bashrc desktop-env /usr/local/share/amiro/
RUN chmod 755 /usr/local/bin/amiro-desktop-start /usr/local/bin/amiro-desktop-open \
      /usr/local/bin/amiro-desktop-state /usr/local/bin/amiro-desktop-chrome \
      /usr/local/bin/amiro-desktop-terminal

ENV HOME=/home/agent
WORKDIR /home/agent
CMD ["sleep", "infinity"]
