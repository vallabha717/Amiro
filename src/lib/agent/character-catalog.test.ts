import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AVATAR_COLORS,
  DEFAULT_CHARACTER_TRAITS,
  PERSONALITY_AXES,
  composeCharacterSvg,
  computeTransforms,
  getCharacterComponents,
  relativeLuminance,
  resolveDefinitions,
  summarizePersonality,
  toneForBg,
  unionBBox,
} from "./character-catalog";

const catalog = getCharacterComponents();

/**
 * The aura swatch had two connected defects that a browser timeout hid: the
 * cobalt swatch stored the legacy alias "blue" while the adapter only accepts
 * the catalog ids, so that one swatch could not be saved, and its test id was
 * derived from the alias, which is why the live acceptance script could not
 * find `agent-color-cobalt` at all. These read the real sources instead of a
 * copy so the alias cannot reappear unnoticed on either side.
 */
const adapterSource = readFileSync(
  path.join(import.meta.dirname, "../../../adapter/src/routes/agent.mjs"),
  "utf8",
);
const customizerSource = readFileSync(
  path.join(
    import.meta.dirname,
    "../../components/agent/agent-customizer-modal.tsx",
  ),
  "utf8",
);

function adapterValidColors(): string[] {
  const match = adapterSource.match(
    /const VALID_COLORS = new Set\(\[([^\]]*)\]\)/,
  );
  expect(match, "adapter must declare VALID_COLORS").not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

/**
 * Count `<path>` elements that are direct children of the root `<svg>`. The
 * adapter asserts `svg[width="82"] > path` === 1, so the character must expose
 * exactly one silhouette path and nothing else at the top level.
 */
function directPathCount(svg: string): number {
  let depth = 0;
  let count = 0;
  const tag = /<(\/?)([a-zA-Z]+)\b[^>]*?(\/?)>/g;
  let match: RegExpExecArray | null = tag.exec(svg);
  while (match !== null) {
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    if (closing) {
      depth -= 1;
    } else {
      if (depth === 1 && match[2] === "path") {
        count += 1;
      }
      if (!selfClosing) {
        depth += 1;
      }
    }
    match = tag.exec(svg);
  }
  return count;
}

function countOf(svg: string, element: string): number {
  return svg.split(`<${element}`).length - 1;
}

describe("Agent character catalog", () => {
  it("provides unique, renderable default traits", () => {
    expect(
      resolveDefinitions(
        catalog,
        DEFAULT_CHARACTER_TRAITS.bodyShape,
        DEFAULT_CHARACTER_TRAITS.eyeStyle,
        DEFAULT_CHARACTER_TRAITS.color,
      ),
    ).not.toBeNull();
    for (const items of [
      catalog.bodyShapes,
      catalog.eyeStyles,
      catalog.colors,
    ]) {
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    }
  });
  it("renders every body and gaze combination at sidebar and hero sizes", () => {
    for (const body of catalog.bodyShapes) {
      for (const eyes of catalog.eyeStyles) {
        for (const size of [22, 82, 236]) {
          const transforms = computeTransforms(body, eyes, catalog, size);
          expect(JSON.stringify(transforms)).not.toMatch(/NaN|Infinity/);
          expect(
            composeCharacterSvg(catalog, body.id, eyes.id, "orange", size),
          ).toContain("<svg");
        }
      }
    }
  });
  it("exposes exactly one direct silhouette path plus a dot lattice", () => {
    for (const body of catalog.bodyShapes) {
      for (const eyes of catalog.eyeStyles) {
        for (const size of [22, 82, 236]) {
          const svg = composeCharacterSvg(
            catalog,
            body.id,
            eyes.id,
            "orange",
            size,
          );
          expect(svg, `${body.id}/${eyes.id}/${size} must render`).toContain(
            `<svg`,
          );
          expect(
            directPathCount(svg!),
            `${body.id}/${eyes.id}/${size} must expose one body path`,
          ).toBe(1);
          // The lattice follows the same field at every size.
          expect(countOf(svg!, "circle")).toBeGreaterThan(0);
        }
      }
    }
  });
  it("keeps the character geometry generated from field maths", () => {
    for (const body of catalog.bodyShapes) {
      expect(body.viewBox.width).toBe(body.viewBox.height);
      expect(body.field.harmonics.length).toBeGreaterThan(0);
      // Only generated move/curve commands, and nowhere near third-party scale.
      expect(body.svgPath).toMatch(/^M[\d.\-\s]+(?:C[\d.\-\s]+)+Z$/);
      expect(body.svgPath.length).toBeLessThan(4000);
    }
    const seen = new Set<string>();
    for (const style of catalog.eyeStyles) {
      expect(style.paths.length).toBeGreaterThan(0);
      for (const mark of style.paths) {
        expect(mark.svgPath).not.toMatch(/nan|undefined|Infinity/i);
        expect(mark.svgPath.length).toBeLessThan(600);
      }
      seen.add(JSON.stringify(style.paths));
    }
    // Every gaze must have its own distinct set of marks.
    expect(seen.size).toBe(catalog.eyeStyles.length);
  });
  it("rejects unknown traits instead of inserting arbitrary SVG", () => {
    expect(
      composeCharacterSvg(catalog, "<script>", "grumpy", "orange"),
    ).toBeNull();
    expect(
      composeCharacterSvg(catalog, "blob", "unknown", "orange"),
    ).toBeNull();
    expect(
      composeCharacterSvg(catalog, "blob", "grumpy", "unknown"),
    ).toBeNull();
  });
  it("chooses readable foregrounds for every avatar color", () => {
    for (const color of AVATAR_COLORS) {
      const tone = toneForBg(color.hex);
      const a = relativeLuminance(tone.fg);
      const b = relativeLuminance(tone.bg);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps personality summaries bounded for malformed persisted values", () => {
    const values = Object.fromEntries(
      PERSONALITY_AXES.map((axis) => [axis.id, NaN]),
    );
    expect(summarizePersonality(values)).not.toMatch(/NaN|Infinity/);
    expect(summarizePersonality({ playfulSerious: -90 })).toContain(
      "100% Playful",
    );
    expect(summarizePersonality({ playfulSerious: 190 })).toContain(
      "100% Serious",
    );
  });
  it("unions empty and offset geometry safely", () => {
    expect(unionBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(
      unionBBox([
        { x: -2, y: 5, w: 4, h: 10 },
        { x: 1, y: -1, w: 8, h: 2 },
      ]),
    ).toEqual({ x: -2, y: -1, w: 11, h: 16 });
  });
});

describe("aura swatch save path", () => {
  it("offers the adapter exactly the colors the adapter accepts", () => {
    const valid = adapterValidColors();
    expect(valid.length).toBeGreaterThan(0);
    for (const color of AVATAR_COLORS) {
      expect(valid, `${color.id} must be an accepted trait`).toContain(
        color.id,
      );
    }
    expect(new Set(valid).size).toBe(valid.length);
  });

  it("sends the catalog id rather than an alias the server rejects", () => {
    // The save payload preserves the legacy trait through the resolver.
    expect(customizerSource).toMatch(
      /const traits: CharacterTraits = \{\s*bodyShape,\s*eyeStyle,\s*color: legacyColor,?\s*\};/,
    );
    expect(customizerSource).toMatch(
      /const legacyColor = resolveColorId\(identity\.traits\.color\)/,
    );
    // ...and the resolver must map any alias to a catalog id.
    const resolver = customizerSource.match(
      /function resolveColorId\(colorId: string\): string \{\s*return ([^;]+);/,
    );
    expect(resolver, "resolveColorId must exist").not.toBeNull();
    // The alias it rewrites (left of ?) must NOT be a valid trait, which is
    // what made the raw value un-saveable; the replacement (right of ?) must be
    // one, or the adapter rejects the write.
    const valid = adapterValidColors();
    const body = resolver?.[1] ?? "";
    const [aliasPart = "", targetPart = ""] = body.split("?");
    const aliases = [...aliasPart.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    const targets = [...targetPart.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(aliases.length).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(valid, `${alias} must not reach the adapter`).not.toContain(alias);
    }
    for (const target of targets) {
      expect(valid, `${target} must be an accepted trait`).toContain(target);
    }
  });

  it("labels every theme option in the customizer with its own theme id", () => {
    // The customizer offers the unified sidebar themes instead of separate color swatches.
    expect(customizerSource).toMatch(
      /data-testid={`agent-theme-\$\{t\}`}/,
    );
    expect(customizerSource).toMatch(/setThemeDraft\(t\)/);
  });
});
