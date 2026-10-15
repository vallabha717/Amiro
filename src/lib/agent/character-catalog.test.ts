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
