import RFB from "@novnc/novnc";
import { apiJson } from "@/lib/backend/client";
import { backendUrl, getBackendSharedSecret } from "@/lib/backend/config";

const CONNECT_TIMEOUT_MS = 25_000;

export type DesktopEndReason = "busy" | "unavailable" | "failed" | "lost";

export type DesktopSessionState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "ended"; reason: DesktopEndReason };

export type DesktopViewportMode = "fit" | "pan" | "control";

export interface OpenDesktopSessionArgs {
  agentId: string;
  viewOnly?: boolean;
  viewportMode?: DesktopViewportMode;
  container: HTMLElement;
  onState: (state: DesktopSessionState) => void;
}

export interface DesktopSession {
  close(): void;
  setViewOnly(viewOnly: boolean): void;
  setViewportMode(mode: DesktopViewportMode): void;
}

function buildDesktopWsUrl(
  httpUrl: string,
  ticket: string,
  agentId: string,
  token: string,
): string {
  const base = typeof location !== "undefined" ? location.href : undefined;
  const url = new URL(httpUrl, base);
  url.protocol =
    url.protocol === "https:"
      ? "wss:"
      : url.protocol === "http:"
        ? "ws:"
        : url.protocol;
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("agentId", agentId);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export async function resolveDesktopStreamWsUrl(
  agentId: string,
): Promise<string> {
  const { ticket } = await apiJson<{ ticket: string; expiresInMs: number }>(
    "/api/desktop/ticket",
    {
      method: "POST",
      body: "{}",
    },
  );
  return buildDesktopWsUrl(
    backendUrl("/api/desktop/stream"),
    ticket,
    agentId,
    getBackendSharedSecret(),
  );
}

export function openDesktopSession({
  agentId,
  container,
  onState,
  viewOnly = false,
  viewportMode = "fit",
}: OpenDesktopSessionArgs): DesktopSession {
  let done = false;
  let ws: WebSocket | null = null;
  let rfb: RFB | null = null;
  let currentViewOnly = viewOnly;
  let currentViewportMode = viewportMode;

  const updateViewport = (): void => {
    if (rfb) {
      const mode = currentViewOnly ? "fit" : currentViewportMode;
      rfb.scaleViewport = mode === "fit";
      rfb.clipViewport = mode !== "fit";
      rfb.dragViewport = mode === "pan";
    }
  };

  const updateViewOnly = (): void => {
    if (rfb) {
      rfb.viewOnly = currentViewOnly;
      rfb.focusOnClick = !currentViewOnly;
      updateViewport();
    }
  };

  const teardown: (() => void)[] = [];

  const release = (): void => {
    for (const fn of teardown.splice(0)) {
      fn();
    }
    if (rfb) {
      rfb.disconnect();
      rfb = null;
    } else if (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN)
    ) {
      ws.close(1000);
    }
  };

  const end = (reason: DesktopEndReason): void => {
    if (done) return;
    done = true;
    release();
    onState({ kind: "ended", reason });
  };

  const attach = (url: string): void => {
    let client: RFB;
    try {
      ws = new WebSocket(url, ["binary"]);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("close", (event) => {
        if (event.code === 4013) end("busy");
        else if (event.code === 4008) end("unavailable");
        else if (event.code === 4011) end("failed");
        else end("lost");
      });
      client = new RFB(container, ws);
    } catch {
      end("failed");
      return;
    }
    rfb = client;
    client.background = "#10171c";
    client.resizeSession = false;
    updateViewOnly();

    const connectTimer = setTimeout(() => end("lost"), CONNECT_TIMEOUT_MS);
    teardown.push(() => clearTimeout(connectTimer));

    client.addEventListener("connect", () => {
      clearTimeout(connectTimer);
      if (!done) {
        onState({ kind: "connected" });
      }
    });
    client.addEventListener("securityfailure", () => end("failed"));
    client.addEventListener("disconnect", () => end("lost"));

    client.addEventListener("clipboard", (event) => {
      if (currentViewOnly) return;
      void navigator.clipboard?.writeText(event.detail.text).catch(() => {});
    });

    const onCopy = (): void => {
      if (currentViewOnly) return;
      const text = document.getSelection()?.toString();
      if (text) {
        rfb?.clipboardPasteFrom(text);
      }
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (currentViewOnly) return;
      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        rfb?.clipboardPasteFrom(text);
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    teardown.push(() => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    });
  };

  resolveDesktopStreamWsUrl(agentId).then(
    (url) => {
      if (!done) {
        attach(url);
      }
    },
    () => end("failed"),
  );

  return {
    close(): void {
      if (done) return;
      done = true;
      release();
    },
    setViewOnly(next: boolean): void {
      currentViewOnly = next;
      updateViewOnly();
    },
    setViewportMode(next: DesktopViewportMode): void {
      currentViewportMode = next;
      updateViewport();
    },
  };
}
