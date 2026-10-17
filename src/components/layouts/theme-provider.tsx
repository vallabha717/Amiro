"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { useThemeStyle } from "@/hooks/use-theme-style";
import { COLOR_TO_SIDEBAR_THEME } from "@/lib/agent/character-catalog";

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

  React.useLayoutEffect(() => {
    if (document.body.getAttribute("data-theme") !== themeStyle) {
      document.body.setAttribute("data-theme", themeStyle);
    }
    setMounted(true);
  }, [themeStyle]);

  if (!mounted) {
    return null;
  }

  return (
    <>
      <IdentityThemeSync current={themeStyle} apply={setThemeStyle} />
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

ThemeStyleProvider.displayName = "ThemeStyleProvider";
