"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/** Backlog is drained roughly this fast while text is still streaming. */
export const STREAM_CATCH_UP_MS = 250;
/** Once the stream has ended, whatever is left is flushed within this window. */
export const FLUSH_CATCH_UP_MS = 150;
/** Floor so a tiny backlog still reveals at a readable ~120 chars/s. */
const MIN_CHARS_PER_MS = 0.12;
/** Extend a cut up to this many chars so it lands on a word end, not mid-word. */
const WORD_SNAP_CHARS = 6;

/**
 * Pure pacing step: how many characters of `target` should be visible after
 * `dtMs` more milliseconds, given `shown` are visible now.
 *
 * The reveal rate scales with the backlog (backlog / catchUpMs), so a big
 * 100ms-throttled chunk drains in about `catchUpMs` instead of lagging ever
 * further behind, while a trickle still advances at a calm minimum speed.
 */
export function nextRevealLength(
  shown: number,
  target: string,
  dtMs: number,
  catchUpMs: number = STREAM_CATCH_UP_MS,
): number {
  const end = target.length;
  // Target shrank or caught up: never overshoot it.
  if (shown >= end) return end;
  const from = Math.max(0, shown);
  // A long gap (hidden tab: rAF is paused) means the user wasn't watching.
  if (dtMs >= catchUpMs) return end;
  const dt = Math.max(0, dtMs);
  const backlog = end - from;
  const advance = Math.max(MIN_CHARS_PER_MS * dt, (backlog * dt) / catchUpMs);
  let next = Math.min(end, from + Math.max(1, Math.ceil(advance)));

  // Prefer ending on a word boundary so partial words don't flicker in.
  if (next < end && !/\s/.test(target[next])) {
    const limit = Math.min(end, next + WORD_SNAP_CHARS);
    let i = next;
    while (i < limit && !/\s/.test(target[i])) i++;
    // Only snap when the boundary is real; at `end` the word may still be growing.
    if (i < end && i <= limit) next = i;
  }
  // Never split a surrogate pair (emoji) across frames.
  const code = target.charCodeAt(next - 1);
  if (next < end && code >= 0xd800 && code <= 0xdbff) next += 1;
  return Math.max(from, next);
}

/**
 * Smooths bursty streamed text into a steady character reveal.
 *
 * useChat is throttled (100ms), so text lands in visible chunks. While
 * `streaming`, characters are revealed per animation frame; when it stops the
 * remainder flushes quickly and the exact full text is returned. Finished
 * messages (streaming false from the start) do no work at all.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const reduced = usePrefersReducedMotion();
  const [len, setLen] = useState(() => (streaming ? 0 : text.length));
  const lenRef = useRef(len);
  const prevTextRef = useRef(text);
  const lastFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) return;
    // Not a prefix extension (edited / replaced / shrunk): show it as-is.
    if (!text.startsWith(prevTextRef.current)) {
      prevTextRef.current = text;
      lenRef.current = text.length;
      setLen(text.length);
      return;
    }
    prevTextRef.current = text;
    if (lenRef.current >= text.length) {
      lastFrameRef.current = null;
      return;
    }

    const catchUp = streaming ? STREAM_CATCH_UP_MS : FLUSH_CATCH_UP_MS;
    let raf = 0;
    const tick = (now: number) => {
      const dt = lastFrameRef.current == null ? 16 : now - lastFrameRef.current;
      lastFrameRef.current = now;
      const next = nextRevealLength(lenRef.current, text, dt, catchUp);
      if (next !== lenRef.current) {
        lenRef.current = next;
        setLen(next);
      }
      if (next < text.length) raf = requestAnimationFrame(tick);
      else lastFrameRef.current = null;
    };
    raf = requestAnimationFrame(tick);
    // Cancelling on cleanup also guarantees no setState after unmount.
    return () => cancelAnimationFrame(raf);
  }, [text, streaming, reduced]);

  if (reduced || (!streaming && len >= text.length)) return text;
  return text.slice(0, Math.min(len, text.length));
}
