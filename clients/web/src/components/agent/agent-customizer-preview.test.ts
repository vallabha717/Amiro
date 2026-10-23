import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(
  path.join(import.meta.dirname, "agent-customizer-modal.tsx"),
  "utf8",
);

describe("agent customizer draft preview", () => {
  it("drives the preview backdrop, glow and avatar tint from the draft colour", () => {
    expect(modalSource).toContain("const previewAccent = accentHexForColorId(colorId)");
    expect(modalSource).toContain("${previewAccent}");
    expect(modalSource).toContain("accentColor={previewAccent}");
  });

  it("does not hardcode the preview backdrop or glow to the saved accent", () => {
    expect(modalSource).not.toContain("${AGENT_ACCENT} 28%");
    expect(modalSource).not.toContain("style={{ backgroundColor: AGENT_ACCENT }}");
  });

  it("drives the sidebar theme from the color cycler", () => {
    expect(modalSource).toContain("COLOR_TO_SIDEBAR_THEME");
    const colorSection = modalSource.slice(modalSource.indexOf('label="Color"'));
    expect(colorSection).toContain("COLOR_TO_SIDEBAR_THEME");
    expect(colorSection).toContain("setThemeDraft");
  });

  it("keeps Surprise me colors paired with their matching theme", () => {
    const randomize = modalSource.slice(
      modalSource.indexOf("const handleRandomize"),
      modalSource.indexOf("const handleImageUpload"),
    );
    expect(randomize).toContain("setThemeDraft(COLOR_TO_SIDEBAR_THEME[c])");
    expect(randomize).not.toContain("BASE_THEMES");
  });

  it("keeps the header and Save footer fixed with only the middle scrolling", () => {
    const headerAt = modalSource.indexOf("Fixed header: title never scrolls");
    const scrollAt = modalSource.indexOf('data-testid="agent-customizer-scroll"');
    const footerAt = modalSource.indexOf("Sticky footer");
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(scrollAt).toBeGreaterThan(headerAt);
    expect(footerAt).toBeGreaterThan(scrollAt);
    expect(modalSource).toContain("min-h-0 flex-1 overflow-y-auto");
  });

  it("shows Color first with no Theme row; the theme is automatic", () => {
    expect(modalSource.indexOf('label="Color"')).toBeGreaterThanOrEqual(0);
    expect(modalSource.indexOf('label="Color"')).toBeLessThan(
      modalSource.indexOf('label="Form"'),
    );
    expect(modalSource).not.toContain('label="Theme"');
    expect(modalSource).not.toContain("agent-theme-value");
  });
});
