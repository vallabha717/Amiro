import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TraitCycleRow } from "./trait-cycle-row";

describe("TraitCycleRow visible arrow controls", () => {
  it("renders Previous/Next buttons with accessible names and visible value", () => {
    const html = renderToStaticMarkup(
      createElement(TraitCycleRow, {
        label: "Theme",
        value: "Midnight",
        colorHex: "var(--sidebar-primary)",
        valueTestId: "agent-theme-value",
        prevTestId: "agent-prev-theme",
        nextTestId: "agent-next-theme",
        onPrev: () => {},
        onNext: () => {},
      }),
    );
    expect(html).toContain('aria-label="Previous Theme"');
    expect(html).toContain('aria-label="Next Theme"');
    expect(html).toContain('data-testid="agent-prev-theme"');
    expect(html).toContain('data-testid="agent-next-theme"');
    expect(html).toContain('data-testid="agent-theme-value"');
    expect(html).toContain("Midnight");
    expect(html).toContain("var(--sidebar-primary)");
    expect(html).not.toContain("sr-only");
  });

  it("renders Form row with visible value and prev/next testids", () => {
    const html = renderToStaticMarkup(
      createElement(TraitCycleRow, {
        label: "Form",
        value: "Headphones",
        valueTestId: "agent-form-value",
        prevTestId: "agent-prev-body-shape",
        nextTestId: "agent-next-body-shape",
        onPrev: () => {},
        onNext: () => {},
      }),
    );
    expect(html).toContain('data-testid="agent-form-value"');
    expect(html).toContain('data-testid="agent-prev-body-shape"');
    expect(html).toContain('data-testid="agent-next-body-shape"');
    expect(html).toContain("Headphones");
  });

  it("supports aria-live on visible value for screen reader updates", () => {
    const html = renderToStaticMarkup(
      createElement(TraitCycleRow, {
        label: "Theme",
        value: "Zinc",
        valueTestId: "agent-theme-value",
        onPrev: () => {},
        onNext: () => {},
      }),
    );
    expect(html).toContain('aria-live="polite"');
  });
});
