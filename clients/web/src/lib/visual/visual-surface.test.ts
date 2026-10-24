import { afterEach, describe, expect, it } from "vitest";

import { parseInlineVisuals } from "@/components/visual/visual-surface";
import {
  WIDGET_CSP_META,
  buildLinkInterceptorScript,
  buildStoragePolyfill,
  buildWidgetHeightReporterScript,
  buildWidgetPromptScript,
  buildWidgetWidthFitScript,
  injectWidgetBridge,
  isRelayableExternalHref,
  jsonForScript,
} from "@/lib/visual/sandbox-bridge";
import {
  WIDGET_RAMP_DARK_MIRROR,
  WIDGET_TOKEN_PROPERTIES,
  buildWidgetStyle,
  buildWidgetStyleTag,
  colorSchemeForTheme,
  detectColorScheme,
  readWidgetTokens,
} from "@/lib/visual/widget-tokens";

// ---------------------------------------------------------------------------
// widget-tokens
// ---------------------------------------------------------------------------

describe("widget-tokens", () => {
  it("exposes the full Vellum token vocabulary", () => {
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--surface-lift");
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--content-default");
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--border-element");
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--system-positive-strong");
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--radius-pill");
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--color-forest-950");
    expect(WIDGET_TOKEN_PROPERTIES).toContain("--color-moss-50");
  });

  it("resolves every token in both themes even without a host document", () => {
    for (const scheme of ["light", "dark"] as const) {
      const tokens = readWidgetTokens(null, scheme);
      for (const property of WIDGET_TOKEN_PROPERTIES) {
        expect(
          tokens[property],
          `${property} missing in ${scheme}`,
        ).toBeTruthy();
      }
      expect(Object.keys(tokens)).toHaveLength(WIDGET_TOKEN_PROPERTIES.length);
    }
  });

  it("falls back to light defaults when no element and no scheme is given", () => {
    const tokens = readWidgetTokens();
    expect(tokens["--surface-lift"]).toBe("#FFFFFF");
    expect(tokens["--surface-base"]).toBe("#F6F5F4");
    expect(tokens["--content-default"]).toBe("#24292E");
    expect(tokens["--border-base"]).toBe("#F2F0EE");
    expect(tokens["--radius-lg"]).toBe("12px");
    expect(tokens["--font-serif"]).toContain("Instrument Serif");
  });

  it("uses the dark defaults for the dark scheme", () => {
    const tokens = readWidgetTokens(null, "dark");
    expect(tokens["--surface-lift"]).toBe("#24292E");
    expect(tokens["--surface-base"]).toBe("#17191C");
    expect(tokens["--content-default"]).toBe("#F6F5F4");
    expect(tokens["--border-element"]).toBe("#5A6672");
    expect(tokens["--radius-lg"]).toBe("12px");
  });

  it("mirrors palette ramps within themselves under a dark scheme", () => {
    expect(WIDGET_RAMP_DARK_MIRROR.get("--color-forest-100")).toBe(
      "--color-forest-950",
    );
    expect(WIDGET_RAMP_DARK_MIRROR.get("--color-forest-950")).toBe(
      "--color-forest-100",
    );
    expect(WIDGET_RAMP_DARK_MIRROR.get("--color-moss-50")).toBe(
      "--color-moss-950",
    );
    expect(WIDGET_RAMP_DARK_MIRROR.get("--color-moss-500")).toBe(
      "--color-moss-500",
    );
    expect(WIDGET_RAMP_DARK_MIRROR.get("--color-amber-600")).toBe(
      "--color-amber-500",
    );
  });

  it("emits mirrored ramp values inside a dark snapshot", () => {
    const light = readWidgetTokens(null, "light");
    const dark = readWidgetTokens(null, "dark");
    // forest-100 (light fill) becomes forest-950 (dark fill)
    expect(light["--color-forest-100"]).toBe("#E9F2EC");
    expect(dark["--color-forest-100"]).toBe("#0D2818");
    // moss-50 pairs with moss-950
    expect(light["--color-moss-50"]).toBe("#F6F5F4");
    expect(dark["--color-moss-50"]).toBe("#111214");
    // Accents pair 100/950, 200/900, … so danger-900 (light text on a
    // danger-100 fill) becomes danger-200 (light text on the mirrored fill).
    expect(light["--color-danger-900"]).toBe("#803017");
    expect(dark["--color-danger-900"]).toBe("#FFE4D5");
  });

  it("maps a theme name to a color scheme", () => {
    expect(colorSchemeForTheme("light")).toBe("light");
    expect(colorSchemeForTheme("dark")).toBe("dark");
    expect(colorSchemeForTheme("velvet")).toBe("dark");
    expect(colorSchemeForTheme("anything-else")).toBe("dark");
  });

  it("detects the colour scheme without a document as light", () => {
    expect(detectColorScheme()).toBe("light");
    expect(detectColorScheme(null)).toBe("light");
  });

  it("reads the dark class and data-theme attribute off a root element", () => {
    const darkClassRoot = {
      classList: { contains: (name: string) => name === "dark" },
      getAttribute: () => null,
    } as unknown as Element;
    expect(detectColorScheme(darkClassRoot)).toBe("dark");

    const dataThemeRoot = {
      classList: { contains: () => false },
      getAttribute: (name: string) => (name === "data-theme" ? "dark" : null),
    } as unknown as Element;
    expect(detectColorScheme(dataThemeRoot)).toBe("dark");

    const lightRoot = {
      classList: { contains: () => false },
      getAttribute: (name: string) => (name === "data-theme" ? "light" : null),
    } as unknown as Element;
    expect(detectColorScheme(lightRoot)).toBe("light");
  });

  it("serializes a snapshot into a :root style block", () => {
    const tag = buildWidgetStyleTag({ "--surface-lift": "#fff" }, "light");
    expect(tag).toContain("<style>");
    expect(tag).toContain("color-scheme:light");
    expect(tag).toContain("--surface-lift:#fff;");
    expect(tag).toContain("body{margin:0");
  });

  it("reports a resolved snapshot for either theme", () => {
    expect(buildWidgetStyle("light").resolved).toBe(true);
    expect(buildWidgetStyle("dark").resolved).toBe(true);
  });

  describe("with a host document", () => {
    const originalGetComputedStyle = globalThis.getComputedStyle;

    afterEach(() => {
      if (originalGetComputedStyle) {
        globalThis.getComputedStyle = originalGetComputedStyle;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).getComputedStyle;
      }
    });

    function stubComputedStyle(map: Record<string, string>): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).getComputedStyle = () => ({
        getPropertyValue: (property: string) => map[property] ?? "",
      });
    }

    const stubRoot = {
      classList: { contains: () => false },
      getAttribute: () => null,
    } as unknown as Element;

    it("borrows Amiro's own semantic tokens when present", () => {
      stubComputedStyle({
        "--background": "oklch(0.5 0 0)",
        "--foreground": "#111111",
        "--card": "#ffffff",
        "--muted": "#eeeeee",
        "--border": "#dddddd",
        "--primary": "#000000",
      });
      const tokens = readWidgetTokens(stubRoot, "light");
      expect(tokens["--surface-base"]).toBe("oklch(0.5 0 0)");
      expect(tokens["--surface-lift"]).toBe("#ffffff");
      expect(tokens["--surface-sunken"]).toBe("#eeeeee");
      expect(tokens["--content-default"]).toBe("#111111");
      expect(tokens["--border-base"]).toBe("#dddddd");
      expect(tokens["--border-active"]).toBe("#000000");
    });

    it("resolves nested var() references for borrowed font tokens", () => {
      stubComputedStyle({
        "--font-sans": "var(--font-fraunces)",
        "--font-fraunces": '"Fraunces", serif',
        "--font-mono": '"Geist Mono", monospace',
      });
      const tokens = readWidgetTokens(stubRoot, "light");
      expect(tokens["--font-sans"]).toBe('"Fraunces", serif');
      expect(tokens["--font-mono"]).toBe('"Geist Mono", monospace');
    });

    it("falls back to the default when a var() reference cannot resolve", () => {
      stubComputedStyle({ "--font-sans": "var(--not-defined)" });
      const tokens = readWidgetTokens(stubRoot, "light");
      expect(tokens["--font-sans"]).toContain("DM Sans");
    });

    it("prefers a host-declared Vellum token over the borrowed one", () => {
      stubComputedStyle({
        "--background": "#ffffff",
        "--surface-lift": "#abcdef",
      });
      const tokens = readWidgetTokens(stubRoot, "light");
      expect(tokens["--surface-lift"]).toBe("#abcdef");
    });
  });
});

// ---------------------------------------------------------------------------
// sandbox-bridge
// ---------------------------------------------------------------------------

describe("sandbox-bridge", () => {
  it("escapes script-breaking sequences when serializing for a script tag", () => {
    const serialized = jsonForScript({ html: "</script><!--" });
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("<\\/script>");
    expect(serialized).toContain("<\\!--");
  });

  it("only allows relayable external link schemes", () => {
    expect(isRelayableExternalHref("https://example.com")).toBe(true);
    expect(isRelayableExternalHref("http://example.com")).toBe(true);
    expect(isRelayableExternalHref("mailto:a@b.com")).toBe(true);
    expect(isRelayableExternalHref("tel:+123")).toBe(true);
    expect(isRelayableExternalHref("javascript:alert(1)")).toBe(false);
    expect(isRelayableExternalHref("data:text/html,x")).toBe(false);
    expect(isRelayableExternalHref("blob:https://x")).toBe(false);
    expect(isRelayableExternalHref(42)).toBe(false);
    expect(isRelayableExternalHref(null)).toBe(false);
  });

  it("builds a storage polyfill for both web storage APIs", () => {
    const polyfill = buildStoragePolyfill();
    expect(polyfill).toContain("<script>");
    expect(polyfill).toContain("localStorage");
    expect(polyfill).toContain("sessionStorage");
    expect(polyfill).toContain("getItem");
    expect(polyfill).toContain("setItem");
  });

  it("exposes sendPrompt and the applet bridge", () => {
    const script = buildWidgetPromptScript("frame-1");
    expect(script).toContain("window.sendPrompt = function(text)");
    expect(script).toContain("window.applet = {");
    expect(script).toContain("sendPrompt: window.sendPrompt");
    expect(script).toContain("action: function(action, args)");
    expect(script).toContain("'vellum_widget_prompt'");
    expect(script).toContain("'applet_action'");
    expect(script).toContain('"frame-1"');
  });

  it("reports content height through postMessage", () => {
    const script = buildWidgetHeightReporterScript("frame-2");
    expect(script).toContain("vellum_widget_height");
    expect(script).toContain("window.parent.postMessage");
    expect(script).toContain("ResizeObserver");
    expect(script).toContain('"frame-2"');
  });

  it("shrinks a too-wide widget to fit", () => {
    const script = buildWidgetWidthFitScript();
    expect(script).toContain("__vellumWidgetZoom");
    expect(script).toContain("body.style.zoom");
  });

  it("relays external links to the parent instead of opening them", () => {
    const relayed = buildLinkInterceptorScript("frame-3", {
      relayExternal: true,
    });
    expect(relayed).toContain("vellum_open_link");
    expect(relayed).not.toContain("window.open(rawHref");
    expect(relayed).toContain('"frame-3"');

    const direct = buildLinkInterceptorScript("frame-3");
    expect(direct).toContain("window.open(rawHref");
  });

  it("denies network and form egress with the widget CSP", () => {
    expect(WIDGET_CSP_META).toContain("default-src 'none'");
    expect(WIDGET_CSP_META).toContain("script-src 'unsafe-inline'");
    expect(WIDGET_CSP_META).toContain("base-uri 'none'");
    expect(WIDGET_CSP_META).toContain("form-action 'none'");
  });

  it("injects the whole widget bridge around a bare fragment", () => {
    const out = injectWidgetBridge(
      "<div>hello</div>",
      "frame-4",
      "<style>x</style>",
    );
    expect(out).toContain(WIDGET_CSP_META);
    expect(out).toContain("localStorage");
    expect(out).toContain("window.sendPrompt");
    expect(out).toContain("window.applet");
    expect(out).toContain("vellum_widget_height");
    expect(out).toContain("vellum_widget_prompt");
    expect(out).toContain("vellum_open_link");
    expect(out).toContain("<style>x</style>");
    expect(out).toContain("<div>hello</div>");
    // The CSP must precede the model-authored fragment so it governs it.
    expect(out.indexOf(WIDGET_CSP_META)).toBeLessThan(
      out.indexOf("<div>hello</div>"),
    );
    // The height reporter must follow the fragment so body is populated.
    expect(out.indexOf("<div>hello</div>")).toBeLessThan(
      out.indexOf("vellum_widget_height"),
    );
  });
});

// ---------------------------------------------------------------------------
// parseInlineVisuals
// ---------------------------------------------------------------------------

describe("parseInlineVisuals", () => {
  it("returns null when there is nothing to parse", () => {
    expect(parseInlineVisuals("just prose, no visuals")).toBeNull();
    expect(parseInlineVisuals("")).toBeNull();
  });

  it("parses a ui_show visual with a JSON body", () => {
    const text =
      'Before.\n<ui_show surface_type="visual">{"html": "<div>x</div>", "height": 320, "title": "Flow"}</ui_show>\nAfter.';
    const segments = parseInlineVisuals(text);
    expect(segments).not.toBeNull();
    expect(segments).toHaveLength(3);
    expect(segments?.[0]).toEqual({ type: "text", content: "Before.\n" });
    const visual = segments?.[1];
    expect(visual?.type).toBe("visual");
    if (visual?.type === "visual") {
      expect(visual.html).toBe("<div>x</div>");
      expect(visual.height).toBe(320);
      expect(visual.title).toBe("Flow");
      expect(visual.id).toMatch(/^inline-visual-\d+$/);
    }
    expect(segments?.[2]).toEqual({ type: "text", content: "\nAfter." });
  });

  it("parses a ui_show visual with a raw HTML body", () => {
    const text =
      '<ui_show surface_type="visual"><svg width="100%"></svg></ui_show>';
    const segments = parseInlineVisuals(text);
    expect(segments).toHaveLength(1);
    const visual = segments?.[0];
    if (visual?.type === "visual") {
      expect(visual.html).toBe('<svg width="100%"></svg>');
      expect(visual.height).toBeUndefined();
    }
  });

  it("reads height and title from attributes", () => {
    const text =
      '<ui_show surface_type="visual" height="240" title="Bars"><div></div></ui_show>';
    const segments = parseInlineVisuals(text);
    const visual = segments?.[0];
    if (visual?.type === "visual") {
      expect(visual.height).toBe(240);
      expect(visual.title).toBe("Bars");
    }
  });

  it("parses a fenced visual block with a JSON body", () => {
    const text =
      'Lead.\n```visual\n{"html": "<p>hi</p>", "height": 180}\n```\nTail.';
    const segments = parseInlineVisuals(text);
    expect(segments).not.toBeNull();
    const visual = segments?.find((s) => s.type === "visual");
    if (visual?.type === "visual") {
      expect(visual.html).toBe("<p>hi</p>");
      expect(visual.height).toBe(180);
    }
  });

  it("parses a fenced visual block with a raw HTML body", () => {
    const text = "```visual\n<div>raw</div>\n```";
    const segments = parseInlineVisuals(text);
    expect(segments).toHaveLength(1);
    const visual = segments?.[0];
    if (visual?.type === "visual") {
      expect(visual.html).toBe("<div>raw</div>");
    }
  });

  it("leaves non-visual ui_show surfaces in the text", () => {
    const text =
      '<ui_show surface_type="card">{"title": "not a visual"}</ui_show>';
    expect(parseInlineVisuals(text)).toBeNull();
  });

  it("leaves malformed JSON in the text", () => {
    const text = '<ui_show surface_type="visual">{not json}</ui_show>';
    expect(parseInlineVisuals(text)).toBeNull();
  });

  it("parses multiple blocks into ordered segments", () => {
    const text =
      'A\n<ui_show surface_type="visual"><b>1</b></ui_show>\nB\n```visual\n<i>2</i>\n```\nC';
    const segments = parseInlineVisuals(text);
    const kinds = segments?.map((s) => s.type);
    expect(kinds).toEqual(["text", "visual", "text", "visual", "text"]);
    const visualIds = segments
      ?.filter((s) => s.type === "visual")
      .map((s) => s.id);
    expect(visualIds?.[0]).not.toBe(visualIds?.[1]);
  });
});

describe("inline visual recovery", () => {
  it("renders a ui_show payload whose html has unescaped quotes", async () => {
    const { parseInlineVisuals, salvageVisualJson } = await import(
      "@/components/visual/visual-surface"
    );
    const broken =
      '{"html": "<div style="display:flex"><b class="x">Hi</b></div>", "height": 110}';
    expect(salvageVisualJson(broken)).toEqual({
      html: '<div style="display:flex"><b class="x">Hi</b></div>',
      height: 110,
    });
    const segments = parseInlineVisuals(
      `Here it is. <ui_show surface_type="visual">${broken}</ui_show> Done.`,
    );
    expect(segments?.some((s: any) => s.type === "visual")).toBe(true);
    expect(JSON.stringify(segments)).not.toContain("ui_show");
    // Well-formed JSON still wins, escaped quotes intact.
    expect(salvageVisualJson('{"title": "t"}')).toBeNull();
  });
});
