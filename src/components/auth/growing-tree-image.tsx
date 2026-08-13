"use client";

import { useEffect, useRef } from "react";

// Reference photo (public/images-removebg-preview.png) recolored via a CSS
// mask: the PNG's alpha channel becomes the silhouette, `background-color:
// currentColor` supplies the color, so it tracks the theme (light/dark) for
// free through the ancestor `text-foreground/*` class -- no per-theme JS,
// no canvas recolor pass, no WebGL. A rAF loop scales the masked silhouette
// from a seed up to full size and back down, looping forever.

const PAUSE_MS = 900;
const GROW_MS = 2600;
const HOLD_MS = 5200;
const SHRINK_MS = 1500;
const CYCLE_MS = PAUSE_MS + GROW_MS + HOLD_MS + SHRINK_MS;
const MIN_SCALE = 0.05;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInCubic(t: number): number {
  return t ** 3;
}

function growthScale(elapsedMs: number): number {
  const t = elapsedMs % CYCLE_MS;
  if (t < PAUSE_MS) return MIN_SCALE;

  const grow = t - PAUSE_MS;
  if (grow < GROW_MS) {
    return MIN_SCALE + (1 - MIN_SCALE) * easeOutCubic(grow / GROW_MS);
  }

  const hold = grow - GROW_MS;
  if (hold < HOLD_MS) return 1;

  const shrink = hold - HOLD_MS;
  return 1 - (1 - MIN_SCALE) * easeInCubic(Math.min(shrink / SHRINK_MS, 1));
}

export function GrowingTreeImage({ className }: { className?: string }) {
  const scaleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scaleRef.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.transform = "scale(1)";
      return;
    }

    let frameId: number;
    const start = performance.now();
    const tick = (now: number) => {
      el.style.transform = `scale(${growthScale(now - start)})`;
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <div
      className={className}
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        boxSizing: "border-box",
        // Clearance below the trunk so the tree's own ground line doesn't
        // run into the caption text sitting just under this panel.
        paddingBottom: "12%",
      }}
    >
      <div
        ref={scaleRef}
        style={{
          width: "100%",
          height: "100%",
          transformOrigin: "50% 100%",
          transform: `scale(${MIN_SCALE})`,
          willChange: "transform",
          backgroundColor: "currentColor",
          WebkitMaskImage: "url(/images-removebg-preview.png)",
          maskImage: "url(/images-removebg-preview.png)",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center bottom",
          maskPosition: "center bottom",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
      />
    </div>
  );
}
