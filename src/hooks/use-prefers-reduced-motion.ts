"use client";

import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Live `prefers-reduced-motion` state.
 *
 * framer-motion's own `useReducedMotion` reads the media query once, at mount
 * (`useState(prefersReducedMotion.current)`), so anything that turns the setting
 * on after the page has loaded keeps animating. The Agent habitat is a
 * long-lived element on a page the user may leave open, and the browser
 * acceptance test flips the setting at runtime, so this hook stays subscribed
 * and re-renders when the preference changes.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}
