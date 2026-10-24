#!/usr/bin/env python3
"""Print what is on the agent's virtual desktop as JSON.

{"running": true,
 "agent": {"name": "Amiro", "home": "/home/agent", "hostHome": "/home/owner/.amiro/agents/main"},
 "active": {"app": "files", "title": "...", "path": "/home/agent/docs",
            "hostPath": "/home/owner/.amiro/agents/main/docs"},
 "windows": [{"app": "browser", "title": "Example Domain", "url": "https://example.com/", "active": false}, ...]}

`app` is browser, files, terminal or other. Files and Terminal windows carry
the exact folder they show, inside the container (`path`) and on the owner's
computer (`hostPath`); the browser the address of the page it shows (`url`). With `--wait-for <app>` it prints nothing and exits 0 only once
a window of that app is open.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

ENV = dict(os.environ, DISPLAY=":99", HOME="/home/agent")
# Thunar with misc-full-path-in-window-title: "/home/agent/docs - File Manager".
THUNAR_TITLE = re.compile(r"^(/.*?) - (?:File Manager|Thunar)$")


def run(*argv):
    try:
        return subprocess.run(argv, env=ENV, capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def window_ids():
    return [w for w in run("xdotool", "search", "--onlyvisible", "--name", ".").split() if w.isdigit()]


def wm_class(wid):
    # WM_CLASS(STRING) = "thunar", "Thunar"
    found = re.findall(r'"([^"]*)"', run("xprop", "-id", wid, "WM_CLASS"))
    return found[-1].lower() if found else ""


def active_id():
    match = re.search(r"window id # (0x[0-9a-f]+)", run("xprop", "-root", "_NET_ACTIVE_WINDOW"))
    return str(int(match.group(1), 16)) if match else None


def browser_tabs():
    try:
        with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=1) as response:
            pages = json.load(response)
    except Exception:
        return []
    return [p for p in pages if p.get("type") == "page"]


AGENT_HOME = "/home/agent"


def read_line(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return f.readline().strip() or default
    except OSError:
        return default


AGENT_NAME = read_line("/tmp/desktop-agent-name", "Agent")
# Where /home/agent is on the owner's computer.
HOST_HOME = read_line("/tmp/desktop-agent-home", AGENT_HOME).rstrip("/") or AGENT_HOME


def to_host(path):
    if path == AGENT_HOME or path.startswith(AGENT_HOME + "/"):
        return HOST_HOME + path[len(AGENT_HOME):]
    return path


def from_host(path):
    if path == HOST_HOME or path.startswith(HOST_HOME + "/"):
        return AGENT_HOME + path[len(HOST_HOME):]
    return path


def describe(wid, active, tabs):
    cls = wm_class(wid)
    title = run("xdotool", "getwindowname", wid).strip()
    window = {"app": "other", "title": title, "active": wid == active}
    if cls in ("chromium", "chromium-browser", "google-chrome"):
        window["app"] = "browser"
        # The window title is the shown tab's title plus " - Chromium".
        shown = title.rsplit(" - Chromium", 1)[0]
        tab = next((t for t in tabs if t.get("title") == shown), tabs[0] if tabs else None)
        if tab:
            window["url"] = tab.get("url", "")
            window["title"] = tab.get("title", shown)
    elif cls == "thunar":
        window["app"] = "files"
        match = THUNAR_TITLE.match(title)
        if match:
            # Files may show the folder either way (/home/agent/… or its real path).
            window["hostPath"] = to_host(match.group(1))
            window["path"] = from_host(match.group(1))
    elif cls in ("xfce4-terminal", "terminal"):
        window["app"] = "terminal"
        # The desktop's bashrc titles the window "<agent> — <folder on the
        # owner's computer>".
        shown = title.split(" — ", 1)[-1]
        if shown.startswith("/"):
            window["hostPath"] = shown
            window["path"] = from_host(shown)
    return window


def main():
    ids = window_ids()
    if not ids and not run("xdotool", "getdisplaygeometry").strip():
        print(json.dumps({"running": False, "active": None, "windows": []}))
        return 0
    active = active_id()
    tabs = browser_tabs()
    windows = [w for w in (describe(wid, active, tabs) for wid in ids) if w["title"] or w["app"] != "other"]
    # Plank's dock and Openbox's own surfaces are not windows the user opened.
    windows = [w for w in windows if not (w["app"] == "other" and w["title"] in ("plank", "Plank"))]
    if len(sys.argv) == 3 and sys.argv[1] == "--wait-for":
        return 0 if any(w["app"] == sys.argv[2] for w in windows) else 1
    current = next((w for w in windows if w["active"]), None)
    agent = {"name": AGENT_NAME, "home": AGENT_HOME, "hostHome": HOST_HOME}
    print(json.dumps({"running": True, "agent": agent, "active": current, "windows": windows}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
