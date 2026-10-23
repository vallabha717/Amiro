"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { useThemeStyle } from "@/hooks/use-theme-style";
import {
  COLOR_TO_SIDEBAR_THEME,
  accentHexForColorId,
} from "@/lib/agent/character-catalog";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
export const ThemeStyleProvider = React.memo(function ({
  children,
}: {
  children: React.ReactNode;
}) {
  const { themeStyle, setThemeStyle } = useThemeStyle();
  const [mounted, setMounted] = React.useState(false);

  // App colours come from the VegaAI palette on <html data-theme>
  // (useVegaPalette). The agent theme stays a stored preference; it no longer
  // paints <body>, where its palette would override the chosen one.
  React.useLayoutEffect(() => {
    document.body.removeAttribute("data-theme");
    setMounted(true);
  }, [themeStyle]);

  if (!mounted) {
    return null;
  }

  return (
    <>
      <IdentityThemeSync current={themeStyle} apply={setThemeStyle} />
      <AgentAccentSync />
      {children}
    </>
  );
});

/**
 * Hydrate the initial saved color and subsequent identity color changes.
 * A local theme render alone must never reapply a cached identity color.
 */
export function IdentityThemeSync({
  current,
  apply,
}: {
  current: string;
  apply: (theme: string) => void;
}) {
  const { data: identity } = useAgentIdentity();
  const savedColor = identity?.traits?.color;
  const lastColor = React.useRef<string | undefined>(undefined);
  const wanted = (
    savedColor ? COLOR_TO_SIDEBAR_THEME[savedColor] : undefined
  ) as string | undefined;
  React.useEffect(() => {
    if (!savedColor || lastColor.current === savedColor) return;
    lastColor.current = savedColor;
    if (wanted && wanted !== current) apply(wanted);
  }, [savedColor, wanted, current, apply]);
  return null;
}

/** Readable text on a #RRGGBB fill (WCAG relative luminance). */
function foregroundFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? "#17171c" : "#ffffff";
}

/**
 * Paint the agent's own colour (picked in onboarding or the customizer) into
 * `--agent-accent` on <html>, so the plush and every Agent surface in the app
 * match what was chosen, whatever app palette is active.
 */
export function AgentAccentSync() {
  const { data: identity } = useAgentIdentity();
  const hex = accentHexForColorId(identity?.traits?.color);
  React.useLayoutEffect(() => {
    const root = document.documentElement.style;
    if (!hex) {
      root.removeProperty("--agent-accent");
      root.removeProperty("--agent-accent-foreground");
      return;
    }
    root.setProperty("--agent-accent", hex);
    root.setProperty("--agent-accent-foreground", foregroundFor(hex));
  }, [hex]);
  return null;
}

ThemeStyleProvider.displayName = "ThemeStyleProvider";
