"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useThemeStyle } from "./use-theme-style";

/** Resolve the agent accent (its chosen colour, else the sidebar token) to
 * sRGB for canvas and legacy tone helpers. */
export function readSidebarAccent(): string {
  const style = getComputedStyle(document.body);
  const color =
    style.getPropertyValue("--agent-accent").trim() ||
    style.getPropertyValue("--sidebar-primary").trim();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context || !color) return "#18181b";
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
}

/** No second palette or identity-write effect. The app theme owns Agent colors. */
export function useAgentTheme() {
  const { themeStyle } = useThemeStyle();
  const { resolvedTheme } = useTheme();
  const [accentHex, setAccentHex] = useState("#18181b");

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAccentHex(readSidebarAccent()));
    };
    const observer = new MutationObserver(update);
    const options = {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    };
    observer.observe(document.documentElement, options);
    observer.observe(document.body, options);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [themeStyle, resolvedTheme]);

  return { accentHex };
}
