"use client";

/**
 * Tells the backend which chat this tab has on screen, so a reply the user is
 * watching is not notified and opening a chat clears its reply notifications.
 * Vellum's `use-web-presence-report.ts`, cut down to what Amiro needs.
 *
 * A tab counts as present when it is visible, focused, and was touched in
 * the last {@link IDLE_AFTER_MS}: a tab left open on a second monitor is not
 * someone reading. The backend trusts a report for three minutes, so a
 * present tab re-reports every {@link REFRESH_MS}; a closed or idle one
 * simply ages out and notifications resume. Every failure is ignored: a
 * missed report only means a notification the user did not strictly need.
 */

import { useEffect, useRef } from "react";
import { appStore } from "@/app/store";
import { reportPresence, type PresenceReport } from "@/lib/backend/notifications-api";

export const IDLE_AFTER_MS = 10 * 60_000;
export const REFRESH_MS = 60_000;

const CLIENT_ID_KEY = "amiro.presence.clientId";
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/** Whether the user is at this tab right now. */
export function isPresent(state: {
  visible: boolean;
  focused: boolean;
  lastInputAt: number;
  now: number;
}): boolean {
  return state.visible && state.focused && state.now - state.lastInputAt <= IDLE_AFTER_MS;
}

/**
 * Sends reports one at a time, newest wins. Two posts racing could land out
 * of order and leave the backend thinking the user is still on a chat they
 * left, which would swallow that chat's next notification.
 */
export function createPresenceQueue(
  send: (report: PresenceReport) => Promise<unknown>,
) {
  let inFlight = false;
  let queued: PresenceReport | null = null;
  let last: string | null = null;
  const flush = async () => {
    inFlight = true;
    try {
      while (queued) {
        const next = queued;
        queued = null;
        try {
          await send(next);
          last = JSON.stringify(next);
        } catch {
          // Best effort: the backend fails open on a missing report.
        }
      }
    } finally {
      inFlight = false;
    }
  };
  return {
    /** Queue a report. `force` re-sends an unchanged one (the refresh tick). */
    push(report: PresenceReport, force = false) {
      if (!force && !inFlight && !queued && JSON.stringify(report) === last) return;
      queued = report;
      if (!inFlight) void flush();
    },
  };
}

function clientId(): string {
  const fresh = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const stored = sessionStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    const id = fresh();
    sessionStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return fresh();
  }
}

/** Mount once per signed-in tab (the notification bell does). */
export function usePresenceReport(): void {
  const threadId = appStore((state) => state.currentThreadId);
  const threadRef = useRef<string | null>(threadId ?? null);
  const lastInputRef = useRef(0);
  const queueRef = useRef<ReturnType<typeof createPresenceQueue> | null>(null);
  const idRef = useRef<string>("");

  const report = (force = false) => {
    if (typeof document === "undefined" || !queueRef.current) return;
    queueRef.current.push(
      {
        clientId: idRef.current,
        visible: isPresent({
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
          lastInputAt: lastInputRef.current,
          now: Date.now(),
        }),
        threadId: threadRef.current,
      },
      force,
    );
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    if (typeof window === "undefined") return;
    idRef.current = clientId();
    queueRef.current = createPresenceQueue(reportPresence);
    // Opening the page is the user arriving.
    lastInputRef.current = Date.now();

    const onInput = () => {
      const wasIdle = Date.now() - lastInputRef.current > IDLE_AFTER_MS;
      lastInputRef.current = Date.now();
      if (wasIdle) reportRef.current();
    };
    const onChange = () => reportRef.current();
    for (const name of INPUT_EVENTS) {
      window.addEventListener(name, onInput, { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    const tick = window.setInterval(() => reportRef.current(true), REFRESH_MS);
    return () => {
      for (const name of INPUT_EVENTS) {
        window.removeEventListener(name, onInput, { capture: true });
      }
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.clearInterval(tick);
    };
  }, []);

  // Report at once when the open chat changes, including leaving every chat.
  useEffect(() => {
    threadRef.current = threadId ?? null;
    reportRef.current();
  }, [threadId]);
}
