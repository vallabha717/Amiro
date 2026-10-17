import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_THEMES } from "../const";
import {
  OPENDOTS_DEFAULT_TINT,
  OPENDOTS_DEFAULT_VARIANT,
  OPENDOTS_VARIANTS,
  bodyShapeToVariant,
  openDotVariantById,
  openDotVariantForTraits,
} from "./opendots-catalog";

describe("OpenDots catalog and assets", () => {
  it("defines exactly four plush character variants", () => {
    expect(OPENDOTS_VARIANTS.length).toBe(4);
    const ids = OPENDOTS_VARIANTS.map((v) => v.id);
    expect(ids).toEqual(["blue", "mint", "orange", "purple"]);
    expect(OPENDOTS_DEFAULT_VARIANT.id).toBe("blue");
  });

  it("has existing, non-empty PNG asset files for every variant", () => {
    for (const variant of OPENDOTS_VARIANTS) {
      expect(variant.src).toMatch(/^\/agent\/opendots\/[a-z]+\.png$/);
      const diskPath = path.join(
        process.cwd(),
        "public",
        variant.src.replace(/^\//, ""),
      );
      expect(existsSync(diskPath), `${variant.id} sprite file must exist`).toBe(
        true,
      );
      const stat = statSync(diskPath);
      expect(stat.size, `${variant.id} sprite file size`).toBeGreaterThan(1000);

      // Verify PNG header magic bytes: 0x89 0x50 0x4E 0x47
      const buffer = readFileSync(diskPath);
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50);
      expect(buffer[2]).toBe(0x4e);
      expect(buffer[3]).toBe(0x47);
    }
  });

  it("maps all legacy body shapes deterministically onto plush variants", () => {
    expect(bodyShapeToVariant("blob")).toBe("blue");
    expect(bodyShapeToVariant("urchin")).toBe("blue");
    expect(bodyShapeToVariant("sprout")).toBe("mint");
    expect(bodyShapeToVariant("star")).toBe("orange");
    expect(bodyShapeToVariant("cloud")).toBe("purple");
    expect(bodyShapeToVariant("ghost")).toBe("blue");

    // Fallbacks
    expect(bodyShapeToVariant(undefined)).toBe("blue");
    expect(bodyShapeToVariant(null)).toBe("blue");
    expect(bodyShapeToVariant("non-existent-shape")).toBe("blue");
  });

  it("resolves variant objects for character traits", () => {
    const starVariant = openDotVariantForTraits({ bodyShape: "star" });
    expect(starVariant.id).toBe("orange");
    expect(starVariant.label).toBe("Orange");
    expect(starVariant.src).toBe("/agent/opendots/orange.png");

    const fallbackVariant = openDotVariantForTraits(null);
    expect(fallbackVariant.id).toBe("blue");

    expect(openDotVariantById("mint").id).toBe("mint");
    expect(openDotVariantById("invalid").id).toBe("blue");
  });

  it("sets the default avatar tint token to --sidebar-primary", () => {
    expect(OPENDOTS_DEFAULT_TINT).toBe("var(--sidebar-primary)");
  });
});

describe("Theme synchronization contract", () => {
  it("declares all 22 base themes in const.ts", () => {
    expect(BASE_THEMES).toHaveLength(22);
    expect(BASE_THEMES).toContain("default");
    expect(BASE_THEMES).toContain("blue");
    expect(BASE_THEMES).toContain("orange");
    expect(BASE_THEMES).toContain("pink");
    expect(BASE_THEMES).toContain("cyberpunk-neon");
    expect(BASE_THEMES).toContain("tropical-paradise");
    expect(BASE_THEMES).toContain("midnight");
    expect(BASE_THEMES).toContain("ultraviolet");
    expect(BASE_THEMES).toContain("honey");
  });

  it("defines --sidebar-primary in globals.css for light and dark themes", () => {
    const cssPath = path.join(process.cwd(), "src/app/globals.css");
    const css = readFileSync(cssPath, "utf8");

    // Every theme in BASE_THEMES should have styling in globals.css
    for (const theme of BASE_THEMES) {
      if (theme === "default") {
        expect(css).toMatch(/--sidebar-primary:\s*[^;]+;/);
      } else {
        expect(css).toContain(`[data-theme="${theme}"]`);
      }
    }
  });
});
