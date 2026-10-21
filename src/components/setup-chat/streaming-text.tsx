"use client";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useEffect, useRef, useState } from "react";

/** Characters revealed per frame (~60 fps): a brisk, readable typing pace. */
const CHARS_PER_FRAME = 2;

/**
 * Types `text` out like a streamed reply, then calls `onDone` once. The
 * setup chat's lines are written in the app (no model is connected yet during
 * first-run setup), so this is presentation only. Reduced motion shows the
 * whole line at once. The full text is always in the accessible name, so
 * screen readers hear it once, not letter by letter.
 */
export function StreamingText({
  text,
  onDone,
  instant,
}: {
  text: string;
  onDone?: () => void;
  /** Show it finished, e.g. for turns already answered. */
  instant?: boolean;
}) {
  const reduce = usePrefersReducedMotion();
  const skip = instant || reduce;
  const [shown, setShown] = useState(skip ? text.length : 0);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (skip) {
      setShown(text.length);
      return;
    }
    setShown(0);
    let frame = 0;
    let count = 0;
    const tick = () => {
      count = Math.min(text.length, count + CHARS_PER_FRAME);
      setShown(count);
      if (count < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, skip]);

  const finished = shown >= text.length;
  useEffect(() => {
    if (finished && !done.current) {
      done.current = true;
      onDoneRef.current?.();
    }
  }, [finished]);

  return (
    <p
      className="whitespace-pre-line text-[15px] leading-relaxed"
      aria-label={text}
      data-streaming={finished ? "done" : "typing"}
    >
      <span aria-hidden>{text.slice(0, shown)}</span>
      {!finished && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-current"
        />
      )}
    </p>
  );
}
