/**
 * The VegaAI palettes (app.vegaai.dev ui/lib/constants/themes.ts). "default"
 * is Graphite; each id matches a `[data-theme="..."]` block pair in
 * app/globals.css §2. The palette is independent of light/dark mode and of
 * the agent's colour.
 */
export const VEGA_PALETTES = [
  { id: "default", label: "Graphite" },
  { id: "mist", label: "Sapphire" },
  { id: "sage", label: "Jade" },
  { id: "clay", label: "Amber" },
  { id: "obsidian", label: "Obsidian" },
  { id: "deep-ocean", label: "Deep Ocean" },
  { id: "midnight-violet", label: "Midnight Violet" },
  { id: "warm-stone", label: "Warm Stone" },
  { id: "terminal", label: "Terminal" },
  { id: "aurora", label: "Aurora" },
  { id: "cobalt", label: "Cobalt" },
] as const;

export type VegaPaletteId = (typeof VEGA_PALETTES)[number]["id"];

export const DEFAULT_VEGA_PALETTE: VegaPaletteId = "default";

/** Same localStorage key as app.vegaai.dev, so the choice reads the same. */
export const VEGA_PALETTE_STORAGE_KEY = "vega-theme-style";

export function isVegaPalette(id: unknown): id is VegaPaletteId {
  return VEGA_PALETTES.some((p) => p.id === id);
}

/**
 * Stamps the stored palette onto <html> before first paint (inlined in the
 * root layout), so a non-default palette never flashes Graphite first.
 */
export const VEGA_PALETTE_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  VEGA_PALETTE_STORAGE_KEY,
)});var ok=${JSON.stringify(VEGA_PALETTES.map((p) => p.id))};document.documentElement.setAttribute("data-theme",ok.indexOf(t)>-1?t:${JSON.stringify(
  DEFAULT_VEGA_PALETTE,
)});}catch(e){}})();`;
