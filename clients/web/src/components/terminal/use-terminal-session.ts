"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { apiJson } from "@/lib/backend/client";
import {
  subscribeTerminalEvents,
  type TerminalOutputStream,
} from "./terminal-stream";
import { useTerminalStore } from "./terminal-store";
import type { TerminalSessionInfo } from "./types";

const INPUT_FLUSH_INTERVAL_MS = 50;
const RESIZE_DEBOUNCE_MS = 150;
const MAX_AUTO_RECONNECT_ATTEMPTS = 3;
const AUTO_RECONNECT_BASE_DELAY_MS = 1000;

interface SeqTracker {
  highWaterMark: number;
}

function createSeqTracker(): SeqTracker {
  return { highWaterMark: -1 };
}

export interface UseTerminalSessionArgs {
  agentId: string;
  onData: (data: string) => void;
}

export interface UseTerminalSessionResult {
  connect: () => void;
  reconnect: () => void;
  close: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

export function useTerminalSession({
  agentId,
  onData,
}: UseTerminalSessionArgs): UseTerminalSessionResult {
  const streamRef = useRef<TerminalOutputStream | null>(null);
  const onDataRef = useRef(onData);

  useLayoutEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  const inputBufferRef = useRef<string>("");
  const inputFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);

  const seqTrackerRef = useRef<SeqTracker>(createSeqTracker());
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const userClosedRef = useRef(false);
  const lastSessionIdRef = useRef<string | null>(null);

  const startInputFlushTimer = useCallback((sessionId: string) => {
    if (inputFlushTimerRef.current) {
      return;
    }
    inputFlushTimerRef.current = setInterval(() => {
      const buffered = inputBufferRef.current;
      if (!buffered) {
        return;
      }
      inputBufferRef.current = "";
      apiJson(
        `/api/terminal/sessions/${encodeURIComponent(sessionId)}/input`,
        {
          method: "POST",
          body: JSON.stringify({ data: buffered }),
        },
      ).catch(() => {});
    }, INPUT_FLUSH_INTERVAL_MS);
  }, []);

  const stopInputFlushTimer = useCallback(() => {
    if (inputFlushTimerRef.current) {
      clearInterval(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }
    inputBufferRef.current = "";
  }, []);

  const openSession = useCallback(
    async (isReconnect: boolean) => {
      if (!agentId) {
        if (isReconnect) {
          useTerminalStore.getState().reconnectFailed("No agent selected");
        } else {
          useTerminalStore.getState().connectFailed("No agent selected");
        }
        return;
      }

      const dims = lastDimensionsRef.current ?? { cols: 80, rows: 24 };
      let created: TerminalSessionInfo;
      try {
        created = await apiJson<TerminalSessionInfo>("/api/terminal/sessions", {
          method: "POST",
          body: JSON.stringify({
            agentId,
            cols: dims.cols,
            rows: dims.rows,
          }),
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to create terminal session";
        if (isReconnect) {
          useTerminalStore.getState().reconnectFailed(message);
        } else {
          useTerminalStore.getState().connectFailed(message);
        }
        return;
      }

      const sessionId = created.session_id || created.id;
      if (!sessionId) {
        const msg = "Backend did not return a session ID";
        if (isReconnect) {
          useTerminalStore.getState().reconnectFailed(msg);
        } else {
          useTerminalStore.getState().connectFailed(msg);
        }
        return;
      }

      const expected = isReconnect ? "reconnecting" : "connecting";
      if (useTerminalStore.getState().status !== expected) {
        apiJson(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }).catch(() => {});
        return;
      }

      seqTrackerRef.current = createSeqTracker();

      const stream = subscribeTerminalEvents(
        sessionId,
        (event) => {
          if (event.seq <= seqTrackerRef.current.highWaterMark) {
            return;
          }
          seqTrackerRef.current.highWaterMark = event.seq;
          try {
            onDataRef.current(event.data);
          } catch {
            // Callback errors should not affect the stream
          }
        },
        (err) => {
          stopInputFlushTimer();
          useTerminalStore.getState().errorOccurred(err.message);
        },
      );

      streamRef.current = stream;
      startInputFlushTimer(sessionId);

      userClosedRef.current = false;
      lastSessionIdRef.current = sessionId;

      const meta = {
        isolation: created.isolation,
        cwd: created.cwd,
      };
      if (isReconnect) {
        useTerminalStore.getState().reconnectSucceeded(sessionId, meta);
      } else {
        useTerminalStore.getState().connectSucceeded(sessionId, meta);
      }

      if (lastDimensionsRef.current) {
        apiJson(
          `/api/terminal/sessions/${encodeURIComponent(sessionId)}/resize`,
          {
            method: "POST",
            body: JSON.stringify({
              cols: lastDimensionsRef.current.cols,
              rows: lastDimensionsRef.current.rows,
            }),
          },
        ).catch(() => {});
      }
    },
    [agentId, startInputFlushTimer, stopInputFlushTimer],
  );

  const status = useTerminalStore((s) => s.status);
  const reconnectAttempts = useTerminalStore((s) => s.reconnectAttempts);

  useEffect(() => {
    if (status !== "error") return;
    if (userClosedRef.current) return;
    if (reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS) return;

    const delay = AUTO_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts;
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      const current = useTerminalStore.getState();
      if (current.status !== "error" || userClosedRef.current) {
        return;
      }

      streamRef.current?.cancel();
      streamRef.current = null;

      const prevSessionId = lastSessionIdRef.current;
      if (prevSessionId) {
        lastSessionIdRef.current = null;
        apiJson(`/api/terminal/sessions/${encodeURIComponent(prevSessionId)}`, {
          method: "DELETE",
        }).catch(() => {});
      }

      useTerminalStore.getState().requestReconnect();
      void openSession(true);
    }, delay);

    return () => {
      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }
    };
  }, [status, reconnectAttempts, openSession]);

  const connect = useCallback(() => {
    const { status: s } = useTerminalStore.getState();
    if (s !== "idle" && s !== "closed" && s !== "error") {
      return;
    }
    useTerminalStore.getState().requestConnect();
    void openSession(false);
  }, [openSession]);

  const reconnect = useCallback(() => {
    const { status: s, sessionId } = useTerminalStore.getState();
    if (s !== "error" && s !== "connected") {
      return;
    }

    streamRef.current?.cancel();
    streamRef.current = null;
    stopInputFlushTimer();

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    pendingResizeRef.current = null;

    if (sessionId) {
      apiJson(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    useTerminalStore.getState().requestReconnect();
    void openSession(true);
  }, [openSession, stopInputFlushTimer]);

  const close = useCallback(() => {
    const { sessionId } = useTerminalStore.getState();

    userClosedRef.current = true;

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }

    streamRef.current?.cancel();
    streamRef.current = null;
    stopInputFlushTimer();

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }

    if (sessionId) {
      apiJson(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    useTerminalStore.getState().closed();
  }, [stopInputFlushTimer]);

  const sendInput = useCallback((data: string) => {
    inputBufferRef.current += data;
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    lastDimensionsRef.current = { cols, rows };

    const { status: s, sessionId } = useTerminalStore.getState();
    if (s !== "connected" || !sessionId) {
      return;
    }

    pendingResizeRef.current = { cols, rows };

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const pending = pendingResizeRef.current;
      const current = useTerminalStore.getState();
      if (!pending || !current.sessionId || current.status !== "connected") {
        return;
      }
      pendingResizeRef.current = null;
      apiJson(
        `/api/terminal/sessions/${encodeURIComponent(current.sessionId)}/resize`,
        {
          method: "POST",
          body: JSON.stringify({ cols: pending.cols, rows: pending.rows }),
        },
      ).catch(() => {});
    }, RESIZE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      userClosedRef.current = true;

      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }

      streamRef.current?.cancel();
      streamRef.current = null;

      if (inputFlushTimerRef.current) {
        clearInterval(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }

      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }

      const { sessionId } = useTerminalStore.getState();
      if (sessionId) {
        apiJson(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }).catch(() => {});
      }

      useTerminalStore.getState().reset();
    };
  }, [agentId]);

  return { connect, reconnect, close, sendInput, sendResize };
}
