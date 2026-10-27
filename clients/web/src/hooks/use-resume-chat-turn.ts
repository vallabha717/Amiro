"use client";

import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { backendFetch } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";

/**
 * A chat turn keeps running on the server when the page loses its stream
 * (a phone locking its screen or switching apps drops the request). This
 * reconnects to it: on opening the chat while a turn is running, and after
 * the stream fails, once the page is visible again.
 *
 * The server replays the turn from its first frame, so the partial reply
 * already on screen is removed first and rebuilt from the replay.
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

/** Reconnect attempts after one failure before giving up and showing it. */
const MAX_ATTEMPTS = 3;

export function useResumeChatTurn<M extends UIMessage>({
  threadId,
  status,
  setMessages,
  resumeStream,
}: {
  threadId: string;
  status: "submitted" | "streaming" | "ready" | "error";
  setMessages: (update: (messages: M[]) => M[]) => void;
  resumeStream: () => Promise<void>;
}) {
  const latest = useRef({ status, setMessages, resumeStream });
  latest.current = { status, setMessages, resumeStream };
  const busy = useRef(false);
  const attempts = useRef(0);
  const stopped = useRef(false);

  // Stop means stop: never reconnect to a turn the user just stopped.
  useEffect(() => {
    if (status === "submitted") stopped.current = false;
    if (status === "ready") attempts.current = 0;
  }, [status]);

  useEffect(() => {
    let cancelled = false;

    const reconnect = async (accept: ChatRunState[]) => {
      if (busy.current || stopped.current) return;
      const now = latest.current.status;
      if (now === "submitted" || now === "streaming") return;
      busy.current = true;
      try {
        const state = await fetchChatRunState(threadId);
        if (cancelled || !accept.includes(state)) return;
        const again = latest.current.status;
        if (again === "submitted" || again === "streaming") return;
        latest.current.setMessages((messages) => messagesBeforeTurn(messages));
        await latest.current.resumeStream();
      } finally {
        busy.current = false;
      }
    };

    // Opening the chat while its turn runs (a reload, or back from another
    // app): the history so far is on screen, the rest streams in.
    void reconnect(["running"]);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (latest.current.status !== "error") return;
      if (attempts.current >= MAX_ATTEMPTS) return;
      attempts.current += 1;
      void reconnect(["running", "finished"]);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [threadId]);

  // A stream that fails while the page is visible (the network blipped, or the
  // phone woke up and the browser reported the dropped request): reconnect.
  useEffect(() => {
    if (status !== "error" || stopped.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (attempts.current >= MAX_ATTEMPTS) return;
    attempts.current += 1;
    const timer = window.setTimeout(() => {
      if (busy.current) return;
      busy.current = true;
      void (async () => {
        try {
          const state = await fetchChatRunState(threadId);
          if (state !== "running" && state !== "finished") return;
          if (latest.current.status !== "error") return;
          latest.current.setMessages((messages) => messagesBeforeTurn(messages));
          await latest.current.resumeStream();
        } finally {
          busy.current = false;
        }
      })();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [status, threadId]);

  return {
    /** Call with Stop, so the turn is not reconnected to afterwards. */
    markStopped: () => {
      stopped.current = true;
    },
  };
}
