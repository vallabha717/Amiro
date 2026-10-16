/**
 * Unified Agent / sidebar theme colors.
 *
 * The Agent no longer owns an independent aura palette. Every Agent surface
 * uses the active sidebar theme token so a sidebar theme change is instantly
 * visible on the Agent with no backend write or effect loop.
 *
 * - For DOM / CSS use `AGENT_ACCENT` (`var(--sidebar-primary)`) and
 *   `AGENT_ACCENT_FG` directly — no hex concatenation.
 * - For canvas / `toneForBg` (which parses `#RRGGBB`) use the resolved hex
 *   from `useAgentTheme`. `color-mix` is used for translucent washes
 *   instead of `${hex}18`-style alpha suffixes.
 */
export const AGENT_ACCENT = "var(--sidebar-primary)" as const;
export const AGENT_ACCENT_FG = "var(--sidebar-primary-foreground)" as const;

/** Translucent wash via CSS `color-mix` — never hex alpha concatenation. */
export function agentWash(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `color-mix(in srgb, ${AGENT_ACCENT} ${p}%, transparent)`;
}

export function agentMixWith(otherVar: string, accentPercent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(accentPercent)));
  return `color-mix(in srgb, ${AGENT_ACCENT} ${p}%, ${otherVar})`;
}
