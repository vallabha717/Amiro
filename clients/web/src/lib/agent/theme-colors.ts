/**
 * Unified Agent / sidebar theme colors.
 *
 * Every Agent surface (the plush, its habitat, the voice room) uses the
 * colour picked for the agent in onboarding or the customizer:
 * `--agent-accent`, which AgentAccentSync sets on <html> from the saved
 * identity. Before an identity loads it falls back to the sidebar accent.
 *
 * - For DOM / CSS use `AGENT_ACCENT` (`var(--agent-accent)`) and
 *   `AGENT_ACCENT_FG` directly — no hex concatenation.
 * - For canvas / `toneForBg` (which parses `#RRGGBB`) use the resolved hex
 *   from `useAgentTheme`. `color-mix` is used for translucent washes
 *   instead of `${hex}18`-style alpha suffixes.
 */
export const AGENT_ACCENT =
  "var(--agent-accent, var(--sidebar-primary))" as const;
export const AGENT_ACCENT_FG =
  "var(--agent-accent-foreground, var(--sidebar-primary-foreground))" as const;

/** Translucent wash via CSS `color-mix` — never hex alpha concatenation. */
export function agentWash(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `color-mix(in srgb, ${AGENT_ACCENT} ${p}%, transparent)`;
}

export function agentMixWith(otherVar: string, accentPercent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(accentPercent)));
  return `color-mix(in srgb, ${AGENT_ACCENT} ${p}%, ${otherVar})`;
}
