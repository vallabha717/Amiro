#!/usr/bin/env bash
# Starts the Vellum-parity virtual desktop inside an agent container:
# - Xtigervnc on :99 (1440x810x24) listening on 127.0.0.1:5999
# - dbus session bus
# - Openbox window manager with Vellum dark theme (#292930 / #232329)
# - xcompmgr compositor
# - Custom rendered "<AgentName> OS" wallpaper via rsvg-convert + feh
# - Plank bottom dock with Google Chrome (Chromium), Files (Thunar), and Terminal
# - Real Chromium browser with persistent per-agent profile (/home/agent/.browser)
set -euo pipefail

AGENT_LABEL="${1:-Amiro}"
ACCENT_HEX="${2:-#E9642F}"
# Where /home/agent lives on the owner's computer (the supervisor's agents
# root + this agent's id). Shown in the terminal and by amiro-desktop-state.
HOST_HOME="${3:-}"
. /usr/local/share/amiro/desktop-env
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$HOME/.browser"
chmod 700 "$XDG_RUNTIME_DIR"

# Who this desktop belongs to; refreshed on every start so a rename shows.
/usr/local/bin/amiro-desktop-identity "$AGENT_LABEL" "${HOST_HOME:-/home/agent}"
# desktop-env picks the folder the desktop opens from what was just recorded.
. /usr/local/share/amiro/desktop-env
mkdir -p "$XDG_CONFIG_HOME/gtk-3.0"
printf 'file://%s %s%s workspace\n' "$AMIRO_DESKTOP_HOME" "$AGENT_LABEL" "'s" > "$XDG_CONFIG_HOME/gtk-3.0/bookmarks"

# Is the VNC server listening on 5999? Read from the kernel's socket table
# (176F is 5999, 0A is LISTEN) rather than by connecting: TigerVNC counts a
# connection that closes before its handshake as a failed attempt, and five
# of them blacklist 127.0.0.1 -- the address every TV viewer arrives from.
vnc_listening() {
  grep -qs ':176F [0:]* 0A ' /proc/net/tcp /proc/net/tcp6
}

# If VNC server is already listening on 5999, exit 0 immediately
if vnc_listening; then
  exit 0
fi

# Clean any stale X99 locks
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# 1. Start session D-Bus
rm -f /tmp/dbus-session.sock
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS"

# 2. Start Xtigervnc on :99 (port 5999, 1440x810, 24-bit)
nohup Xtigervnc :99 \
  -localhost \
  -SecurityTypes None \
  -rfbport 5999 \
  -geometry 1440x810 \
  -AcceptSetDesktopSize=0 \
  -depth 24 \
  -desktop "${AGENT_LABEL} OS" \
  -BlacklistThreshold 1000000 \
  </dev/null >/tmp/xvnc.log 2>&1 &

for _ in $(seq 1 80); do
  if vnc_listening; then
    break
  fi
  sleep 0.1
done

# 3. Render "<AgentName> OS" wallpaper SVG -> PNG and apply with feh
cat > /tmp/wallpaper.svg <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="810" viewBox="0 0 1440 810">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#202a30"/>
      <stop offset="100%" stop-color="#10171c"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="46%" r="55%">
      <stop offset="0%" stop-color="${ACCENT_HEX}" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="${ACCENT_HEX}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="letter-face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="48%" stop-color="#e0e9e7"/>
      <stop offset="100%" stop-color="#9eb4ba"/>
    </linearGradient>
  </defs>
  <rect width="1440" height="810" fill="url(#base)"/>
  <ellipse cx="720" cy="372" rx="560" ry="480" fill="url(#glow)"/>
  <g fill="none" stroke="${ACCENT_HEX}">
    <circle cx="720" cy="372" r="148" stroke-opacity="0.16" stroke-width="1.5"/>
    <circle cx="720" cy="372" r="245" stroke-opacity="0.09" stroke-width="1.5"/>
    <circle cx="720" cy="372" r="370" stroke-opacity="0.05" stroke-width="1.5"/>
  </g>
  <circle cx="720" cy="360" r="64" fill="${ACCENT_HEX}" fill-opacity="0.88"/>
  <circle cx="700" cy="350" r="8" fill="#ffffff"/>
  <circle cx="740" cy="350" r="8" fill="#ffffff"/>
  <text x="724" y="556" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="48" font-weight="700" letter-spacing="2" fill="#080f14" opacity="0.45">${AGENT_LABEL} OS</text>
  <text x="720" y="552" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="48" font-weight="700" letter-spacing="2" fill="url(#letter-face)">${AGENT_LABEL} OS</text>
</svg>
EOF

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1440 -h 810 /tmp/wallpaper.svg -o /tmp/wallpaper.png
  feh --no-fehbg --bg-fill /tmp/wallpaper.png >/dev/null 2>&1 || true
fi

# 4. Write Vellum Openbox dark theme & config
THEME_DIR="/tmp/openbox-theme/VellumDark/openbox-3"
mkdir -p "$THEME_DIR" "$XDG_CONFIG_HOME/openbox" "$XDG_CONFIG_HOME/gtk-3.0"
cat > "$THEME_DIR/themerc" <<'EOF'
border.width: 1
padding.width: 8
padding.height: 7
window.client.padding.width: 0
window.client.padding.height: 0
window.handle.width: 3
window.label.text.justify: Center
window.*.label.text.font: shadow=n
window.*.title.bg: Flat Solid
window.*.label.bg: Parentrelative
window.*.handle.bg: Flat Solid
window.*.grip.bg: Flat Solid
window.*.button.*.bg: Parentrelative
window.*.button.*.hover.bg: Flat Solid
window.*.button.*.pressed.bg: Flat Solid
window.active.title.bg.color: #292930
window.active.border.color: #4a4a54
window.active.title.separator.color: #202026
window.active.label.text.color: #f0f0f4
window.active.handle.bg.color: #292930
window.active.grip.bg.color: #292930
window.active.button.*.image.color: #d4d4dc
window.active.button.*.hover.bg.color: #45454f
window.active.button.*.pressed.bg.color: #555561
window.active.button.close.hover.bg.color: #b64150
window.inactive.title.bg.color: #232329
window.inactive.border.color: #36363f
window.inactive.title.separator.color: #202026
window.inactive.label.text.color: #a6a6b2
window.inactive.handle.bg.color: #232329
window.inactive.grip.bg.color: #232329
window.inactive.button.*.image.color: #858592
EOF

cat > "$XDG_CONFIG_HOME/gtk-3.0/settings.ini" <<'EOF'
[Settings]
gtk-theme-name=Adwaita-dark
gtk-icon-theme-name=Adwaita
gtk-application-prefer-dark-theme=true
gtk-font-name=Sans 11
EOF

cat > "$XDG_CONFIG_HOME/openbox/rc.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <desktops>
    <number>1</number>
    <firstdesk>1</firstdesk>
    <popupTime>0</popupTime>
  </desktops>
  <theme>
    <name>/tmp/openbox-theme/VellumDark</name>
    <titleLayout>NLIMC</titleLayout>
    <keepBorder>yes</keepBorder>
  </theme>
</openbox_config>
EOF

nohup openbox --sm-disable --config-file "$XDG_CONFIG_HOME/openbox/rc.xml" </dev/null >/tmp/openbox.log 2>&1 &
nohup xcompmgr </dev/null >/tmp/xcompmgr.log 2>&1 &

# 5. Files shows the full folder path in its title (read by amiro-desktop-state
#    and shown on the TV). Thunar reads this through xfconf.
XFCONF_DIR="$XDG_CONFIG_HOME/xfce4/xfconf/xfce-perchannel-xml"
mkdir -p "$XFCONF_DIR"
cat > "$XFCONF_DIR/thunar.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="thunar" version="1.0">
  <property name="misc-full-path-in-window-title" type="bool" value="true"/>
  <property name="misc-full-path-in-tab-title" type="bool" value="true"/>
  <property name="last-view" type="string" value="ThunarDetailsView"/>
</channel>
EOF

APPS_DIR="$XDG_DATA_HOME/applications"
mkdir -p "$APPS_DIR"

cat > "$APPS_DIR/google-chrome.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Google Chrome
Exec=/usr/local/bin/amiro-desktop-chrome
Icon=chromium
Terminal=false
StartupWMClass=Chromium
EOF

cat > "$APPS_DIR/thunar.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Files
Exec=/usr/local/bin/amiro-desktop-open files
Icon=system-file-manager
Terminal=false
StartupWMClass=Thunar
EOF

cat > "$APPS_DIR/xterm.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Terminal
Exec=/usr/local/bin/amiro-desktop-terminal
Icon=utilities-terminal
Terminal=false
StartupWMClass=Xfce4-terminal
EOF

# 6. Configure Plank dock with Chrome, Files, and Terminal
PLANK_LAUNCHERS="$XDG_CONFIG_HOME/plank/dock1/launchers"
GLIB_SETTINGS="$XDG_CONFIG_HOME/glib-2.0/settings"
mkdir -p "$PLANK_LAUNCHERS" "$GLIB_SETTINGS"

cat > "$PLANK_LAUNCHERS/chrome.dockitem" <<EOF
[PlankDockItemPreferences]
Launcher=file://$APPS_DIR/google-chrome.desktop
EOF

cat > "$PLANK_LAUNCHERS/files.dockitem" <<EOF
[PlankDockItemPreferences]
Launcher=file://$APPS_DIR/thunar.desktop
EOF

cat > "$PLANK_LAUNCHERS/terminal.dockitem" <<EOF
[PlankDockItemPreferences]
Launcher=file://$APPS_DIR/xterm.desktop
EOF

cat > "$GLIB_SETTINGS/keyfile" <<'EOF'
[net/launchpad/plank/docks/dock1]
dock-items=['chrome.dockitem', 'files.dockitem', 'terminal.dockitem']
icon-size=48
hide-mode='none'
theme='Matte'
auto-pinning=false
EOF

GSETTINGS_BACKEND=keyfile nohup plank </dev/null >/tmp/plank.log 2>&1 &

# 7. Launch real Chromium on the desktop by default so it is immediately visible
if ! pgrep -f "/home/agent/.browser" >/dev/null 2>&1; then
  nohup /usr/local/bin/amiro-desktop-chrome "https://example.com" </dev/null >/tmp/chrome.log 2>&1 &
fi

