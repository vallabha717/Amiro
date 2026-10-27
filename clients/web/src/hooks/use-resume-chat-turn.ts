"use client";

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef } from "react";
import { backendFetch, fetcher } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";

/**
 * A chat turn keeps running on the server when the page loses its stream
 * (a phone locking its screen or switching apps drops the request, or leaves
 * a dead connection that never errors). This brings the page back in step:
 *
 * - the turn still runs, or ended a moment ago: the partial reply on screen is
 *   removed and the server replays the turn from its first frame;
 * - the turn ended long ago: the saved conversation is loaded from history.
 *
 * It runs on opening the chat, after a stream fails or is cut off, and when the
 * page comes back (visible again, back online) after being away.
 */

export type ChatRunState = "running" | "finished" | "none";

export async function fetchChatRunState(
  threadId: string,
): Promise<ChatRunState> {
  try {
    const response = await backendFetch(
      backendUrl(`/api/chat/${encodeURIComponent(threadId)}/run`),
    );
    if (!response.ok) return "none";
    const body = (await response.json()) as { state?: ChatRunState };
    return body.state ?? "none";
  } catch {
    return "none";
  }
}

/** Tell the server to stop the thread's running turn. Best effort. */
export function stopChatTurn(threadId: string): void {
  void backendFetch(backendUrl("/api/chat/stop"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: threadId }),
  }).catch(() => {});
}

/** Messages up to and including the last user message: the turn's own reply
 * comes back in full from the replay. */
export function messagesBeforeTurn<M extends UIMessage>(messages: M[]): M[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "assistant") end -= 1;
  return end === 0 || end === messages.length
    ? messages
    : messages.slice(0, end);
}

/** What to do to bring the page back in step with the server's turn. */
export function recoveryFor(
  run: ChatRunState,
): "replay" | "reload-history" {
  return run === "none" ? "reload-history" : "replay";
}

/** Away at least this long before a still-"streaming" page is doubted. */
const AWAY_MS = 3000;
/** Recoveries after one interruption before giving up and showing it. */
const MAX_ATTEMPTS = 3;

type Status = "submitted" | "streaming" | "ready" | "error";

export function useResumeChatTurn<M extends UIMessage>({
  threadId,
  status,
  setMessages,
  resumeStream,
  abortStream,
  clearError,
}: {
  threadId: string;
  status: Status;
  setMessages: (messages: M[] | ((messages: M[]) => M[])) => void;
  resumeStream: () => Promise<void>;
  /** Drop the page's own stream (not the server's turn). */
  abortStream: () => void;
  clearError: () => void;
}) {
  const latest = useRef({ status, setMessages, resumeStream, abortStream, clearError });
  latest.current = { status, setMessages, resumeStream, abortStream, clearError };
  const busy = useRef(false);
  const attempts = useRef(0);
  const stopped = useRef(false);
  // The last stream ended without the turn's own end (dropped or failed).
  const interrupted = useRef(false);
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    if (status === "submitted") {
      stopped.current = false;
      interrupted.current = false;
    }
    if (status === "error") interrupted.current = true;
  }, [status]);

  const recover = useCallback(
    async ({ onlyIfRunning, force }: { onlyIfRunning?: boolean; force?: boolean } = {}) => {
      if (busy.current || stopped.current) return;
      const live = latest.current.status === "submitted" || latest.current.status === "streaming";
      if (live && !force) return;
      busy.current = true;
      try {
        const run = await fetchChatRunState(threadId);
        if (onlyIfRunning && run !== "running") return;
        if (live) latest.current.abortStream();
        if (recoveryFor(run) === "replay") {
          latest.current.setMessages((messages) => messagesBeforeTurn(messages));
          await latest.current.resumeStream();
        } else {
          const thread = (await fetcher(`/api/thread/${threadId}`)) as
            | { messages?: M[] }
            | undefined;
          if (thread?.messages) latest.current.setMessages(thread.messages);
          latest.current.clearError();
        }
        interrupted.current = false;
        attempts.current = 0;
      } catch {
        // Next visibility/online change tries again.
      } finally {
        busy.current = false;
      }
    },
    [threadId],
  );

  useEffect(() => {
    // Opening the chat while its turn runs (a reload, or back from another
    // app): the history so far is on screen, the rest streams in.
    void recover({ onlyIfRunning: true });

    const onBack = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt.current = Date.now();
        return;
      }
      const awayFor = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      const now = latest.current.status;
      const live = now === "submitted" || now === "streaming";
      // Back from the background with a stream that may have died silently
      // (iOS keeps it "open" with nothing arriving): check with the server.
      if (live && awayFor >= AWAY_MS) {
        void recover({ force: true });
        return;
      }
      if (!interrupted.current || attempts.current >= MAX_ATTEMPTS) return;
      attempts.current += 1;
      void recover();
    };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("online", onBack);
    window.addEventListener("pageshow", onBack);
    return () => {
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("online", onBack);
      window.removeEventListener("pageshow", onBack);
    };
  }, [recover]);

  // A stream that fails or is cut off while the page is visible (the network
  // blipped, or the phone woke up and the browser reported the drop).
  useEffect(() => {
    if (status !== "error" || stopped.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (attempts.current >= MAX_ATTEMPTS) return;
    attempts.current += 1;
    const timer = window.setTimeout(() => void recover(), 600);
    return () => window.clearTimeout(timer);
  }, [status, recover]);

  return {
    /** Call with Stop, so the turn is not reconnected to afterwards. */
    markStopped: () => {
      stopped.current = true;
    },
    /** Call from useChat's onFinish: a disconnect counts as interrupted. */
    noteFinish: ({ isDisconnect, isError, isAbort }: { isDisconnect?: boolean; isError?: boolean; isAbort?: boolean }) => {
      if (isDisconnect || isError) {
        interrupted.current = true;
        if (document.visibilityState === "visible" && attempts.current < MAX_ATTEMPTS && !stopped.current) {
          attempts.current += 1;
          window.setTimeout(() => void recover(), 600);
        }
      } else if (!isAbort) {
        interrupted.current = false;
      }
    },
  };
}
