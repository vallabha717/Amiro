import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLOR_TO_SIDEBAR_THEME } from "./character-catalog";

const css = readFileSync(
  new URL("../../app/globals.css", import.meta.url),
  "utf8",
);
const scaffoldAt = css.indexOf("/* Agent palettes share");
const darkAt = css.indexOf("\n.dark {");
const legacy = css.slice(0, scaffoldAt);
const scaffold = css.slice(scaffoldAt);

function declarations(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
}

function palette(theme: string, dark: boolean) {
  const source = dark ? legacy.slice(darkAt) : legacy.slice(0, darkAt);
  const tokens: Record<string, string> = {};
  for (const block of source.matchAll(
    /\[data-theme="([^"]+)"\]\s*\{([^}]+)\}/g,
  )) {
    if (block[1] === theme) Object.assign(tokens, declarations(block[2]));
  }
  // Apply the opt-in shared rules in CSS source order, just as the cascade does.
  for (const block of scaffold.matchAll(
    /(:root|\.dark)\s+:is\(([^)]+)\)\s*\{([^}]+)\}/g,
  )) {
    if (
      (!dark && block[1] === ".dark") ||
      !block[2].includes(`[data-theme="${theme}"]`)
    )
      continue;
    Object.assign(tokens, declarations(block[3]));
  }
  function resolve(value: string, depth = 0): string {
    if (depth > 10) throw new Error("Cyclic palette token");
    return value.replace(/var\((--[\w-]+)\)/g, (_, key: string) => {
      if (!tokens[key]) throw new Error(`Missing ${key} in ${theme}`);
      return resolve(tokens[key], depth + 1);
    });
  }
  return Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [key, resolve(value)]),
  );
}

function luminance(color: string) {
  const match = color.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
  if (!match) throw new Error(`Not a resolved HSL color: ${color}`);
  const h = Number(match[1]) / 60;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const rgb =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  const linear = rgb.map((channel) => {
    const v = channel + l - c / 2;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

const mappings = {
  green: "zen-garden",
  orange: "orange",
  pink: "pink",
  purple: "ultraviolet",
  teal: "misty-harbor",
  yellow: "honey",
  indigo: "space-odyssey",
  cobalt: "blue",
  black: "midnight",
};

describe("coordinated agent theme palettes", () => {
  it("covers the real catalog's nine color-to-theme mappings", () => {
    expect(COLOR_TO_SIDEBAR_THEME).toMatchObject(mappings);
    expect(Object.keys(mappings)).toHaveLength(9);
  });

  for (const dark of [false, true]) {
    describe(dark ? "dark" : "light", () => {
      it("has nine unique surfaces and selected washes", () => {
        for (const token of [
          "--background",
          "--secondary",
          "--sidebar-accent",
        ]) {
          const colors = Object.values(mappings).map(
            (theme) => palette(theme, dark)[token],
          );
          expect(new Set(colors).size, token).toBe(9);
        }
      });
      for (const theme of Object.values(mappings)) {
        it(`${theme} coordinates secondary/sidebar and keeps readable text`, () => {
          const p = palette(theme, dark);
          expect(p["--secondary"]).toBe(p["--sidebar-accent"]);
          expect(p["--secondary-foreground"]).toBe(
            p["--sidebar-accent-foreground"],
          );
          expect(p["--sidebar-accent"]).not.toBe(p["--sidebar"]);
          const pairs = [
            ["background", "foreground"],
            ["card", "card-foreground"],
            ["popover", "popover-foreground"],
            ["secondary", "secondary-foreground"],
            ["sidebar", "sidebar-foreground"],
            ["sidebar-accent", "sidebar-accent-foreground"],
            ["accent", "accent-foreground"],
            ["muted", "muted-foreground"],
          ];
          // Pink's pre-existing primary is deliberately not redesigned.
          if (theme !== "pink")
            pairs.push(
              ["primary", "primary-foreground"],
              ["sidebar-primary", "sidebar-primary-foreground"],
            );
          for (const [bg, fg] of pairs) {
            expect(
              contrast(p[`--${bg}`], p[`--${fg}`]),
              `${theme} ${bg}/${fg}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        });
      }
      it("preserves the established pink secondary and sidebar palette", () => {
        const p = palette("pink", dark);
        expect(p["--secondary"]).toBe(
          dark ? "hsl(310 70% 45%)" : "hsl(310 70% 85%)",
        );
        expect(p["--background"]).toBe(
          dark ? "hsl(340 50% 8%)" : "hsl(340 100% 99%)",
        );
      });
    });
  }
});
