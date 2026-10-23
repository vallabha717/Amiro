import { apiFetch } from "@/lib/backend/client";

export interface TerminalOutputEvent {
  seq: number;
  /** Base64-encoded PTY output bytes (VT100/xterm escape sequences). */
  data: string;
}

export interface TerminalOutputStream {
  cancel: () => void;
}

export function subscribeTerminalEvents(
  sessionId: string,
  onEvent: (event: TerminalOutputEvent) => void,
  onError: (err: Error) => void,
): TerminalOutputStream {
  let cancelled = false;
  const abortController = new AbortController();

  const cancel = () => {
    cancelled = true;
    abortController.abort();
  };

  const connect = async () => {
    if (cancelled) return;
    try {
      const response = await apiFetch(
        `/api/terminal/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          headers: {
            Accept: "text/event-stream, application/json",
          },
          signal: abortController.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Terminal stream connection failed (HTTP ${response.status})`,
        );
      }

      if (!response.body) {
        throw new Error("Terminal stream body is empty");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");

          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const rawJson = trimmed.slice(5).trim();
            if (!rawJson) continue;
            try {
              const parsed = JSON.parse(rawJson) as Record<string, unknown>;
              const seq = typeof parsed.seq === "number" ? parsed.seq : -1;
              const data = typeof parsed.data === "string" ? parsed.data : "";
              if (seq >= 0 && data !== "") {
                onEvent({ seq, data });
              }
            } catch {
              // Ignore malformed SSE lines
            }
          }
        }
      }

      if (cancelled) return;
      onError(new Error("Terminal stream ended"));
    } catch (err) {
      if (cancelled) return;
      const error =
        err instanceof Error
          ? err
          : new Error("Terminal stream connection failed");
      onError(error);
    }
  };

  void connect();

  return { cancel };
}
