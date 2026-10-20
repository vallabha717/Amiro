"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_VEGA_PALETTE,
  VEGA_PALETTE_STORAGE_KEY,
  type VegaPaletteId,
  isVegaPalette,
} from "@/lib/vega-themes";

const EVENT = "vega-palette-change";

function readPalette(): VegaPaletteId {
  if (typeof window === "undefined") return DEFAULT_VEGA_PALETTE;
  try {
    const stored = window.localStorage.getItem(VEGA_PALETTE_STORAGE_KEY);
    return isVegaPalette(stored) ? stored : DEFAULT_VEGA_PALETTE;
  } catch {
    return DEFAULT_VEGA_PALETTE;
  }
}

/** The VegaAI palette on <html data-theme>, persisted like app.vegaai.dev. */
export function useVegaPalette() {
  const [palette, setPaletteState] = useState<VegaPaletteId>(readPalette);

  const setPalette = useCallback((next: VegaPaletteId) => {
    try {
      window.localStorage.setItem(VEGA_PALETTE_STORAGE_KEY, next);
    } catch {}
    document.documentElement.setAttribute("data-theme", next);
    setPaletteState(next);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }, []);

  useEffect(() => {
    const sync = (e: Event) =>
      setPaletteState((e as CustomEvent<VegaPaletteId>).detail);
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);

  return { palette, setPalette };
}
