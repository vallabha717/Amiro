import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(
  path.join(import.meta.dirname, "app-sidebar-skills.tsx"),
  "utf8",
);

describe("sidebar selected-pill accent sync", () => {
  it("paints the active pill with the Amiro theme color, not a generic accent", () => {
    expect(sidebarSource).toContain("activePillStyle");
    expect(sidebarSource).toContain("agentWash(14)");
    expect(sidebarSource).toContain("var(--sidebar-primary) 45%");
    expect(sidebarSource).not.toContain("bg-accent");
  });

  it("adopts the saved agent color's theme on fresh browsers", () => {
    const providerSource = readFileSync(
      path.join(import.meta.dirname, "theme-provider.tsx"),
      "utf8",
    );
    expect(providerSource).toContain("IdentityThemeSync");
    expect(providerSource).toContain("COLOR_TO_SIDEBAR_THEME[savedColor]");
  });

  it("applies the active style to all four quick-jump pills", () => {
    for (const route of [
      "/agent/personality",
      "/agent/superpowers",
      "/agent/memory",
      "/agent/workspace",
    ]) {
      expect(sidebarSource).toContain(`pathname.startsWith("${route}")`);
    }
    expect(sidebarSource.match(/activePillStyle/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
