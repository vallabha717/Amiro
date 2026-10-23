import { apiJson } from "../backend/client";
import {
  backendUrl,
  getBackendSharedSecret,
  getSessionToken,
} from "../backend/config";
import type { ClientFrame, ServerFrame } from "./protocol";

/** http(s) -> ws(s) with ticket/token query. Relative URLs resolve against `pageHref`. */
export function buildLiveVoiceWsUrl(
  httpUrl: string,
  ticket: string,
  token: string,
  pageHref?: string,
): string {
  const base =
    pageHref ?? (typeof location !== "undefined" ? location.href : undefined);
  const url = new URL(httpUrl, base);
  url.protocol =
    url.protocol === "https:"
      ? "wss:"
      : url.protocol === "http:"
        ? "ws:"
        : url.protocol;
  url.searchParams.set("ticket", ticket);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/** Drops duplicate / out-of-order frames: accept only seq strictly greater than the last. */
export function createSeqFilter() {
  let last = 0;
  return (seq: number): boolean => {
    if (typeof seq !== "number" || seq <= last) return false;
    last = seq;
    return true;
  };
}

export interface LiveVoiceConnection {
  send(frame: ClientFrame): void;
  sendAudio(pcm: ArrayBuffer): void;
  close(): void;
  onFrame(cb: (frame: ServerFrame) => void): () => void;
  onClose(cb: (ev: CloseEvent) => void): () => void;
}

export interface ConnectLiveVoiceOptions {
  /** Overridable for tests. */
  signal?: AbortSignal;
}

export async function connectLiveVoice(
  _opts: ConnectLiveVoiceOptions = {},
): Promise<LiveVoiceConnection> {
  const { ticket } = await apiJson<{ ticket: string; expiresInMs: number }>(
    "/api/live-voice/ticket",
    { method: "POST", body: "{}" },
  );
  const wsUrl = buildLiveVoiceWsUrl(
    backendUrl("/api/live-voice"),
    ticket,
    // A paired device has no sidecar secret; its session stands in for it.
    getBackendSharedSecret() || getSessionToken() || "",
  );
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const frameCbs = new Set<(f: ServerFrame) => void>();
  const closeCbs = new Set<(ev: CloseEvent) => void>();
  const accept = createSeqFilter();
  let opened = false;

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(ev.data) as ServerFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string" || !accept(frame.seq)) return;
    for (const cb of [...frameCbs]) cb(frame);
  });

  return new Promise<LiveVoiceConnection>((resolve, reject) => {
    ws.addEventListener("open", () => {
      opened = true;
      resolve({
        send(frame) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
        },
        sendAudio(pcm) {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        },
        close() {
          try {
            ws.close(1000, "client end");
          } catch {}
        },
        onFrame(cb) {
          frameCbs.add(cb);
          return () => frameCbs.delete(cb);
        },
        onClose(cb) {
          closeCbs.add(cb);
          return () => closeCbs.delete(cb);
        },
      });
    });
    ws.addEventListener("error", () => {
      if (!opened) reject(new Error("Could not connect to the voice service"));
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      if (!opened) reject(new Error("Could not connect to the voice service"));
      for (const cb of [...closeCbs]) cb(ev);
    });
  });
}
