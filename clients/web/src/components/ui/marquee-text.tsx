"use client";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "lib/utils";

/**
 * Single-line text wrapper that scrolls (marquee-style) when the parent row
 * (`.group` or `.group/thread`) is hovered AND the text overflows its container
 * — matching Vellum's `MarqueeText` (`packages/design-library/src/components/panel-item/marquee-text.tsx`).
 *
 * Renders two sibling spans inside the overflow container so the idle /
 * reduced-motion state gets a real ellipsis truncation, and hovering smoothly
 * slides the overflowing text horizontally and back without layout shift.
 */
export interface MarqueeTextProps {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

const SCROLL_PX_PER_SECOND = 50;
const MIN_SCROLL_DURATION_MS = 2000;
const SCROLL_FRACTION_OF_ITERATION = 0.8;

export function MarqueeText({
  children,
  className,
  "data-testid": testId,
}: MarqueeTextProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const measure = () => {
      const overflow = inner.scrollWidth - container.clientWidth;
      setOverflowPx(overflow > 0 ? overflow : 0);
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(container);
      observer.observe(inner);
      return () => observer.disconnect();
    }
  }, [children]);

  const canScroll = overflowPx > 0;
  const scrollMs = Math.max(
    MIN_SCROLL_DURATION_MS,
    Math.round(((overflowPx * 2) / SCROLL_PX_PER_SECOND) * 1000),
  );
  const totalMs = Math.round(scrollMs / SCROLL_FRACTION_OF_ITERATION);
  const scrollStyle: CSSProperties | undefined = canScroll
    ? ({
        "--panelitem-marquee-distance": `${overflowPx}px`,
        "--panelitem-marquee-duration": `${totalMs}ms`,
      } as CSSProperties)
    : undefined;

  return (
    <span
      data-slot="marquee-text"
      data-testid={testId}
      data-can-scroll={canScroll ? "true" : "false"}
      ref={containerRef}
      className={cn(
        "group/marquee relative block min-w-0 flex-1 overflow-hidden",
        className,
      )}
    >
      <span className="block truncate motion-safe:group-hover/thread:invisible motion-safe:group-hover/marquee:invisible">
        {children}
      </span>
      <span
        ref={innerRef}
        aria-hidden
        data-slot="marquee-text-animated"
        className={cn(
          "absolute top-0 left-0 invisible block whitespace-nowrap",
          "motion-safe:group-hover/thread:visible motion-safe:group-hover/marquee:visible",
          canScroll &&
            "motion-safe:group-hover/thread:animate-panelitem-marquee motion-safe:group-hover/marquee:animate-panelitem-marquee",
        )}
        style={scrollStyle}
      >
        {children}
      </span>
    </span>
  );
}
