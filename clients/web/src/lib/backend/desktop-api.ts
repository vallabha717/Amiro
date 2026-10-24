import useSWR from "swr";
import { fetcher } from "./client";

/** One window on an agent's desktop, as GET /api/desktop/state reports it. */
export interface DesktopWindow {
  app: "browser" | "files" | "terminal" | "other";
  title: string;
  active: boolean;
  /** The exact folder a Files or Terminal window shows. */
  path?: string;
  /** The address of the page a browser window shows. */
  url?: string;
}

export interface DesktopState {
  running: boolean;
  active: DesktopWindow | null;
  windows: DesktopWindow[];
}

export function desktopStateKey(agentId: string): string {
  return `/api/desktop/state?agentId=${encodeURIComponent(agentId)}`;
}

/**
 * What is open on the agent's desktop, refreshed every `refreshMs` while the
 * TV shows it. `agentId` null pauses it.
 */
export function useDesktopState(agentId: string | null, refreshMs = 2000) {
  return useSWR<DesktopState>(
    agentId ? desktopStateKey(agentId) : null,
    fetcher,
    {
      refreshInterval: refreshMs,
      revalidateOnFocus: false,
      // Keep asking at the same pace after an error (the sandbox may still be
      // starting the container).
      errorRetryInterval: refreshMs,
      errorRetryCount: Number.POSITIVE_INFINITY,
    },
  );
}

/** The folder or address a window shows, else its title. */
export function windowLocation(window: DesktopWindow): string {
  return window.path || window.url || window.title;
}

const TOOL_LINE = /^- (Browser|Files|Terminal) — (.+?)( \(in front\))?$/;

/**
 * Read the windows out of a desktop tool's text result (the lines
 * `describe_desktop` writes in backend/src/routes/agent_browser.rs):
 * `- Files — /home/agent/docs (in front)`.
 */
export function windowsFromToolText(text: string): DesktopWindow[] {
  const windows: DesktopWindow[] = [];
  for (const raw of text.split("\n")) {
    const match = TOOL_LINE.exec(raw.trim());
    if (!match) continue;
    const [, kind, rest, front] = match;
    const active = Boolean(front);
    if (kind === "Browser") {
      // "https://example.com/ (Example Domain)"
      const tab = /^(\S+) \((.*)\)$/.exec(rest);
      windows.push({
        app: "browser",
        url: tab ? tab[1] : rest,
        title: tab ? tab[2] : rest,
        active,
      });
    } else {
      windows.push({
        app: kind === "Files" ? "files" : "terminal",
        path: rest,
        title: rest,
        active,
      });
    }
  }
  return windows;
}
