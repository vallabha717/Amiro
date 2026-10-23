import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/queries/use-skills", () => ({
  useSkills: () => ({
    data: {
      items: [
        { name: "visualize", description: "Draw charts", scope: "user", source: "bundled" },
        { name: "release-notes", description: "Write notes", scope: "project", source: "project" },
      ],
    },
    error: undefined,
    isLoading: false,
  }),
}));

import { SkillPalette } from "./skill-palette";

const base = { top: 400, left: 0, onSelect: () => {}, onClose: () => {} };

describe("SkillPalette", () => {
  it("lists the runtime's commands above skills when commands are enabled", () => {
    const html = renderToStaticMarkup(createElement(SkillPalette, { ...base, query: "", onCommand: () => {} }));
    expect(html).toContain('data-testid="skill-palette-group-commands"');
    expect(html).toContain('data-testid="skill-palette-command-compact"');
    expect(html).toContain("/compact");
    expect(html).toContain("commands.compact");
    expect(html.indexOf("skill-palette-command-compact")).toBeLessThan(html.indexOf("skill-palette-item-visualize"));
  });

  it("filters commands and skills by what was typed", () => {
    const html = renderToStaticMarkup(createElement(SkillPalette, { ...base, query: "vis", onCommand: () => {} }));
    expect(html).not.toContain("skill-palette-command-");
    expect(html).toContain('data-testid="skill-palette-item-visualize"');
    expect(html).not.toContain("skill-palette-item-release-notes");
  });

  it("offers only skills where commands cannot run", () => {
    const html = renderToStaticMarkup(createElement(SkillPalette, { ...base, query: "" }));
    expect(html).not.toContain("skill-palette-group-commands");
    expect(html).toContain('data-testid="skill-palette-group-project"');
  });
});
