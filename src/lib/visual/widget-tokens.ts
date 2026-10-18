/**
 * Design-token bridge for sandboxed widget iframes.
 *
 * A `srcdoc` iframe rendered without `allow-same-origin` is its own document
 * with no access to the host's stylesheets, so a widget cannot read the app's
 * CSS custom properties. This module snapshots the host's *resolved* token
 * values off `document.documentElement` and emits them as a `:root` block the
 * widget can reference through the same variable names the app uses
 * (`var(--surface-lift)`, `var(--font-sans)`, …).
 *
 * Because the values are resolved at snapshot time, the widget automatically
 * matches whichever theme is active — the caller re-snapshots and remounts the
 * iframe when the host's theme changes.
 *
 * Two things make this robust where the plain Vellum version was not:
 *
 * 1. **Every token has a built-in default.** Amiro never declares Vellum's
 *    `--surface-*` / `--content-*` / `--border-*` / `--system-*` vocabulary,
 *    so a naive snapshot would emit an empty `:root` block and every
 *    `var(--surface-lift)` inside the fragment would fall back to its
 *    guaranteed-invalid initial value. The defaults here (mirrored from
 *    Vellum's `packages/design-library/src/tokens.css`) ensure a token always
 *    resolves to a valid colour/radius/font.
 * 2. **Amiro's own tokens are borrowed where they overlap.** When the host
 *    declares `--background`, `--foreground`, `--card`, `--muted`, `--border`
 *    or `--primary` (the shadcn vocabulary Amiro themes with), those resolved
 *    values are used for the matching semantic token so the widget reads as
 *    native rather than as a Vellum-coloured panel.
 *
 * The semantic tokens flip with the theme on their own. The palette ramps do
 * not: every stop is one constant colour, so a light 100 fill authored for the
 * light reading arrives on a dark canvas as a washed-out pastel sticker. Inside
 * the frame the ramps are therefore made theme-adaptive — under a dark scheme
 * each ramp variable is emitted carrying its mirrored stop's value (see
 * {@link WIDGET_RAMP_DARK_MIRROR}), so a matched triple authored once against
 * the light reading (light fill, mid border, dark text) renders natively as a
 * soft dark tint with light text.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Window/getComputedStyle
 */

const RAMP_STEPS = [
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
] as const;

/** Neutral ramps carry an extra lightest step; the accents start at 100. */
const NEUTRAL_PALETTES = ["moss", "stone"] as const;
const ACCENT_PALETTES = ["forest", "emerald", "danger", "amber"] as const;

const NEUTRAL_RAMP_STEPS: readonly string[] = ["50", ...RAMP_STEPS];

const PALETTE_PROPERTIES: readonly string[] = [
  ...NEUTRAL_PALETTES.flatMap((palette) =>
    NEUTRAL_RAMP_STEPS.map((step) => `--color-${palette}-${step}`),
  ),
  ...ACCENT_PALETTES.flatMap((palette) =>
    RAMP_STEPS.map((step) => `--color-${palette}-${step}`),
  ),
];

/**
 * For each ramp variable, the variable whose value it carries under a dark
 * scheme: the stop reflected through the middle of its own ramp. Ramps are
 * paired within themselves, so the mapping is symmetric — reading it in either
 * direction gives the same table.
 *
 * The accents run 100–950 (10 stops), pairing 100/950, 200/900, 300/800,
 * 400/700 and 500/600. The neutrals carry an extra 50 (11 stops), pairing
 * 50/950, 100/900, 200/800, 300/700, 400/600 and leaving 500 on itself.
 */
export const WIDGET_RAMP_DARK_MIRROR: ReadonlyMap<string, string> = new Map(
  [
    ...NEUTRAL_PALETTES.map(
      (palette) => [palette, NEUTRAL_RAMP_STEPS] as const,
    ),
    ...ACCENT_PALETTES.map(
      (palette) => [palette, RAMP_STEPS as readonly string[]] as const,
    ),
  ].flatMap(([palette, steps]) =>
    steps.map((step, index) => [
      `--color-${palette}-${step}`,
      `--color-${palette}-${steps[steps.length - 1 - index]}`,
    ]),
  ),
);

/**
 * The custom properties exposed to widgets. Deliberately an allowlist rather
 * than a sweep of every declared property: the widget contract is a stable,
 * documented token vocabulary, and app-internal layout variables
 * (`--chat-max-width`, `--avatar-accent`, …) are not part of it.
 */
export const WIDGET_TOKEN_PROPERTIES: readonly string[] = [
  // Surfaces
  "--surface-base",
  "--surface-lift",
  "--surface-overlay",
  "--surface-active",
  "--surface-hover",
  "--surface-sunken",
  // Content
  "--content-default",
  "--content-emphasised",
  "--content-secondary",
  "--content-tertiary",
  "--content-quiet",
  "--content-strong",
  "--content-faint",
  "--content-disabled",
  "--content-inset",
  // Borders
  "--border-base",
  "--border-subtle",
  "--border-element",
  "--border-hover",
  "--border-disabled",
  "--border-active",
  // System / status
  "--system-positive-strong",
  "--system-positive-weak",
  "--system-positive-on-weak",
  "--system-negative-strong",
  "--system-negative-weak",
  "--system-negative-on-weak",
  "--system-negative-hover",
  "--system-mid-strong",
  "--system-mid-weak",
  "--system-info-strong",
  "--system-info-weak",
  // Fonts
  "--font-sans",
  "--font-mono",
  "--font-serif",
  // Radius
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius-xxl",
  "--radius-pill",
  // Palettes
  ...PALETTE_PROPERTIES,
];

/**
 * Built-in light/dark defaults for the semantic (theme-flipping) tokens,
 * mirrored from Vellum's `packages/design-library/src/tokens.css`. Used only
 * when neither the host's stylesheet nor Amiro's own tokens provide a value,
 * so a token can never resolve to guaranteed-invalid inside a widget.
 */
const SEMANTIC_TOKEN_DEFAULTS: Record<string, { light: string; dark: string }> =
  {
    // Surfaces
    "--surface-base": { light: "#F6F5F4", dark: "#17191C" },
    "--surface-lift": { light: "#FFFFFF", dark: "#24292E" },
    "--surface-overlay": { light: "#FDFDFC", dark: "#1C2024" },
    "--surface-active": { light: "#F2F0EE", dark: "#444D56" },
    "--surface-hover": {
      light: "rgba(185, 180, 172, 0.08)",
      dark: "rgba(233, 230, 226, 0.06)",
    },
    "--surface-sunken": { light: "#F6F5F4", dark: "#1C2024" },
    // Content
    "--content-default": { light: "#24292E", dark: "#F6F5F4" },
    "--content-emphasised": { light: "#161616", dark: "#FDFDFC" },
    "--content-secondary": { light: "#5A6672", dark: "#A9B2BB" },
    "--content-tertiary": { light: "#71808E", dark: "#8D99A5" },
    "--content-quiet": { light: "#8D99A5", dark: "#A9B2BB" },
    "--content-strong": { light: "#24292E", dark: "#E9E6E2" },
    "--content-faint": { light: "#A9B2BB", dark: "#8D99A5" },
    "--content-disabled": { light: "#CFCCC9", dark: "#5A6672" },
    "--content-inset": { light: "#FDFDFC", dark: "#17191C" },
    // Borders
    "--border-base": { light: "#F2F0EE", dark: "#24292E" },
    "--border-subtle": { light: "#E9E6E2", dark: "#2D3339" },
    "--border-element": { light: "#CFCCC9", dark: "#5A6672" },
    "--border-hover": { light: "#F6F5F4", dark: "#2D3339" },
    "--border-disabled": { light: "#E9E6E2", dark: "#1C2024" },
    "--border-active": { light: "#2D3339", dark: "#F6F5F4" },
    // System / status
    "--system-positive-strong": { light: "#277E41", dark: "#309C50" },
    "--system-positive-weak": { light: "#E9F2EC", dark: "#2C3A31" },
    "--system-positive-on-weak": { light: "#277E41", dark: "#309C50" },
    "--system-negative-strong": { light: "#DA491A", dark: "#DA491A" },
    "--system-negative-weak": { light: "#F7DAC9", dark: "#4F2D24" },
    "--system-negative-on-weak": { light: "#DA491A", dark: "#E86B40" },
    "--system-negative-hover": { light: "#E86B40", dark: "#AB3F1C" },
    "--system-mid-strong": { light: "#F1B21E", dark: "#F1B21E" },
    "--system-mid-weak": { light: "#FCF3DD", dark: "#4B3D1E" },
    "--system-info-strong": { light: "#467CC8", dark: "#467CC8" },
    "--system-info-weak": { light: "#CEDAEC", dark: "#2A3A50" },
    // Type
    "--font-sans": {
      light: '"DM Sans", system-ui, sans-serif',
      dark: '"DM Sans", system-ui, sans-serif',
    },
    "--font-mono": {
      light: '"DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      dark: '"DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    "--font-serif": {
      light: '"Instrument Serif", serif',
      dark: '"Instrument Serif", serif',
    },
    // Radius
    "--radius-xs": { light: "2px", dark: "2px" },
    "--radius-sm": { light: "4px", dark: "4px" },
    "--radius-md": { light: "8px", dark: "8px" },
    "--radius-lg": { light: "12px", dark: "12px" },
    "--radius-xl": { light: "16px", dark: "16px" },
    "--radius-xxl": { light: "20px", dark: "20px" },
    "--radius-pill": { light: "999px", dark: "999px" },
  };

/**
 * Built-in palette stops. Constant across themes: under a dark scheme each
 * variable is re-pointed at its mirrored stop by {@link WIDGET_RAMP_DARK_MIRROR}
 * rather than swapped for a different colour.
 */
const PALETTE_TOKEN_DEFAULTS: Record<string, string> = {
  // Moss — neutral
  "--color-moss-50": "#F6F5F4",
  "--color-moss-100": "#E9E6E2",
  "--color-moss-200": "#CFCCC9",
  "--color-moss-300": "#A9B2BB",
  "--color-moss-400": "#71808E",
  "--color-moss-500": "#444D56",
  "--color-moss-600": "#2D3339",
  "--color-moss-700": "#24292E",
  "--color-moss-800": "#1C2024",
  "--color-moss-900": "#17191C",
  "--color-moss-950": "#111214",
  // Stone — neutral
  "--color-stone-50": "#F6F5F4",
  "--color-stone-100": "#F2F0EE",
  "--color-stone-200": "#E9E6E2",
  "--color-stone-300": "#CFCCC9",
  "--color-stone-400": "#A9B2BB",
  "--color-stone-500": "#8D99A5",
  "--color-stone-600": "#71808E",
  "--color-stone-700": "#5A6672",
  "--color-stone-800": "#24292E",
  "--color-stone-900": "#17191C",
  "--color-stone-950": "#111214",
  // Forest — accent
  "--color-forest-100": "#E9F2EC",
  "--color-forest-200": "#D0F0DA",
  "--color-forest-300": "#A4E2B5",
  "--color-forest-400": "#6ECF87",
  "--color-forest-500": "#3DB85E",
  "--color-forest-600": "#2E9A4E",
  "--color-forest-700": "#277E41",
  "--color-forest-800": "#1B5E30",
  "--color-forest-900": "#1C251F",
  "--color-forest-950": "#0D2818",
  // Emerald — accent
  "--color-emerald-100": "#E9F2EC",
  "--color-emerald-200": "#D0F0DA",
  "--color-emerald-300": "#A4E2B5",
  "--color-emerald-400": "#6ECF87",
  "--color-emerald-500": "#3DB85E",
  "--color-emerald-600": "#2E9A4E",
  "--color-emerald-700": "#277E41",
  "--color-emerald-800": "#1B5E30",
  "--color-emerald-900": "#1C251F",
  "--color-emerald-950": "#0D2818",
  // Danger — accent
  "--color-danger-100": "#FFF3EE",
  "--color-danger-200": "#FFE4D5",
  "--color-danger-300": "#F7DAC9",
  "--color-danger-400": "#F9C0A2",
  "--color-danger-500": "#F39B74",
  "--color-danger-600": "#E86B40",
  "--color-danger-700": "#DA491A",
  "--color-danger-800": "#AB3F1C",
  "--color-danger-900": "#803017",
  "--color-danger-950": "#4E281D",
  // Amber — accent
  "--color-amber-100": "#FDF8EE",
  "--color-amber-200": "#FCF3DD",
  "--color-amber-300": "#FCE9A0",
  "--color-amber-400": "#F9D978",
  "--color-amber-500": "#F5C94E",
  "--color-amber-600": "#F1B21E",
  "--color-amber-700": "#C9990F",
  "--color-amber-800": "#8C7225",
  "--color-amber-900": "#6B5520",
  "--color-amber-950": "#4B3D1E",
};

/**
 * Amiro's own shadcn-vocabulary token to borrow for a given Vellum token when
 * the host declares it. Amiro themes `--background`, `--foreground`, `--card`,
 * `--muted`, `--border` and `--primary`; mapping those onto the matching Vellum
 * semantic token is what makes an inline visual read as native. Tokens absent
 * from this table fall straight through to the built-in defaults.
 */
const AMIRO_TOKEN_SOURCES: Record<string, string> = {
  "--surface-base": "--background",
  "--surface-overlay": "--card",
  "--surface-lift": "--card",
  "--surface-sunken": "--muted",
  "--surface-active": "--muted",
  "--content-default": "--foreground",
  "--content-emphasised": "--foreground",
  "--content-strong": "--foreground",
  "--border-base": "--border",
  "--border-subtle": "--border",
  "--border-element": "--border",
  "--border-active": "--primary",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
};

/**
 * Base document styles every widget inherits: a transparent page so the host
 * transcript's background shows through, zero margin so the auto-height
 * reporter measures content rather than chrome, and the app's own type
 * defaults.
 */
const WIDGET_BASE_STYLES =
  "html{margin:0}" +
  "body{margin:0;padding:6px 10px;background:transparent;color:var(--content-default);" +
  "font-family:var(--font-sans);font-size:16px;line-height:1.6}" +
  "*,*::before,*::after{box-sizing:border-box}";

/**
 * Strip characters that would let a token value terminate the declaration or
 * escape the `<style>` element. Token values come from the app's own
 * stylesheet, so this is belt-and-braces rather than a live threat — but the
 * snapshot is serialized into untrusted-adjacent HTML, so it is sanitized on
 * the way out.
 */
function sanitizeTokenValue(value: string): string {
  return value.replace(/[<>{};\\]/g, "").trim();
}

const VAR_REFERENCE_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]*)?\)/g;

/**
 * Resolve a token value to a concrete string.
 *
 * Amiro declares `--font-sans: var(--font-fraunces)`, so a raw snapshot of a
 * borrowed token can itself be a `var()` reference that would be dead inside a
 * frame that does not define the referenced property. This expands nested
 * `var()` references against the same computed style and returns an empty
 * string when a reference cannot be resolved, letting the caller fall through
 * to the next source or to the built-in default.
 */
function resolveTokenValue(
  computed: CSSStyleDeclaration,
  raw: string | undefined,
): string {
  let value = sanitizeTokenValue(raw ?? "");
  for (let depth = 0; depth < 6 && value.includes("var("); depth += 1) {
    let missing = false;
    const next = value.replace(VAR_REFERENCE_RE, (_match, name: string) => {
      const resolved = sanitizeTokenValue(computed.getPropertyValue(name));
      if (!resolved) {
        missing = true;
        return "";
      }
      return resolved;
    });
    if (missing || next === value) {
      return "";
    }
    value = next;
  }
  return value.includes("var(") ? "" : value;
}

/** The built-in default for one token, or "" when it has none. */
function defaultTokenValue(
  property: string,
  colorScheme: "light" | "dark",
): string {
  return (
    PALETTE_TOKEN_DEFAULTS[property] ??
    SEMANTIC_TOKEN_DEFAULTS[property]?.[colorScheme] ??
    ""
  );
}

/**
 * The `color-scheme` a widget declares. Every theme but `light` is a dark
 * family, and the declaration is what makes the iframe's scrollbars, form
 * controls and default canvas match the host.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme
 */
export function colorSchemeForTheme(theme: string): "light" | "dark" {
  return theme === "light" ? "light" : "dark";
}

/**
 * Detect the active colour scheme off the live document, so callers do not have
 * to know how Amiro encodes its theme. Recognises the `dark` class next-themes
 * toggles, a `data-theme` attribute (Amiro's themes plus Vellum's `velvet`), and
 * the OS preference as a last resort.
 */
export function detectColorScheme(root?: Element | null): "light" | "dark" {
  const element =
    root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!element) {
    return "light";
  }
  if (element.classList?.contains("dark")) {
    return "dark";
  }
  const dataTheme = element.getAttribute("data-theme");
  if (dataTheme) {
    return colorSchemeForTheme(dataTheme);
  }
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

/**
 * Read the resolved values of {@link WIDGET_TOKEN_PROPERTIES} off `root`
 * (defaulting to the document element).
 *
 * Resolution order for every token: a value the host declares outright wins;
 * otherwise Amiro's own token it borrows from; otherwise the built-in default.
 * The result therefore always carries every property, so a widget can never
 * reference a token that resolves to guaranteed-invalid. Under the dark scheme
 * each ramp variable is emitted carrying its mirrored stop's value.
 */
export function readWidgetTokens(
  root?: Element | null,
  colorScheme: "light" | "dark" = "light",
): Record<string, string> {
  const element =
    root ?? (typeof document === "undefined" ? null : document.documentElement);
  const computed =
    element && typeof getComputedStyle === "function"
      ? getComputedStyle(element)
      : null;
  const tokens: Record<string, string> = {};

  for (const property of WIDGET_TOKEN_PROPERTIES) {
    const source =
      colorScheme === "dark"
        ? (WIDGET_RAMP_DARK_MIRROR.get(property) ?? property)
        : property;

    let value = "";
    if (computed) {
      value = resolveTokenValue(computed, computed.getPropertyValue(source));
      if (!value) {
        const amiroSource = AMIRO_TOKEN_SOURCES[property];
        if (amiroSource) {
          value = resolveTokenValue(
            computed,
            computed.getPropertyValue(amiroSource),
          );
        }
      }
    }
    if (!value) {
      value = defaultTokenValue(source, colorScheme);
    }
    if (value) {
      tokens[property] = value;
    }
  }

  return tokens;
}

/** Serialize a token snapshot into the `<style>` block prepended to a widget. */
export function buildWidgetStyleTag(
  tokens: Record<string, string>,
  colorScheme: "light" | "dark",
): string {
  const declarations = Object.entries(tokens)
    .map(([property, value]) => `${property}:${value};`)
    .join("");
  return `<style>:root{color-scheme:${colorScheme};${declarations}}${WIDGET_BASE_STYLES}</style>`;
}

/** A token snapshot serialized for injection, plus whether it carries values. */
export interface WidgetStyleSnapshot {
  /** The `<style>` block to prepend to the widget document. */
  style: string;
  /**
   * Whether the host resolved any token. Always `true` here because every
   * token carries a built-in default; kept in the API so callers written
   * against the Vellum contract still compile.
   */
  resolved: boolean;
}

/** Snapshot the host's tokens for `theme` and serialize them in one step. */
export function buildWidgetStyle(
  theme: string,
  root?: Element | null,
): WidgetStyleSnapshot {
  const colorScheme = colorSchemeForTheme(theme);
  const tokens = readWidgetTokens(root, colorScheme);
  return {
    style: buildWidgetStyleTag(tokens, colorScheme),
    resolved: Object.keys(tokens).length > 0,
  };
}
