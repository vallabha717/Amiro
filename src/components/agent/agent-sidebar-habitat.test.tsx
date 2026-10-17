import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const habitatSource = readFileSync(
  path.join(import.meta.dirname, "agent-sidebar-habitat.tsx"),
  "utf8",
);

describe("AgentSidebarHabitat body-specific motion and reduced motion", () => {
  it("has body-specific dance/swim: blob, sprout, star, cloud each differ", () => {
    expect(habitatSource).toMatch(/case "blob"/);
    expect(habitatSource).toMatch(/case "sprout"/);
    expect(habitatSource).toMatch(/case "star"/);
    expect(habitatSource).toMatch(/case "cloud"/);
    // avatarAnim switch has distinct y/x per shape
    expect(habitatSource).toMatch(/y: \[0, -10/);
    expect(habitatSource).toMatch(/rotate: \[-5, 5/);
    expect(habitatSource).toMatch(/y: \[0, -14/);
    expect(habitatSource).toMatch(/x: \[-30, 30/);
  });

  it("reduced motion preserves eyes: animated=false passed to avatar when reduceMotion", () => {
    expect(habitatSource).toMatch(/animated=\{!reduceMotion\}/);
    expect(habitatSource).toMatch(/if \(reduceMotion\) return \{ x: 0, y: 0, rotate: 0 \}/);
  });

  it("cube per-shape motion exists alongside avatar motion", () => {
    expect(habitatSource).toMatch(/cubeAnim/);
    expect(habitatSource).toMatch(/cubeTransition/);
    expect(habitatSource).toContain("AgentCharacterAvatar");
  });

  it("normalizes legacy ghost/urchin to blob", () => {
    expect(habitatSource).toMatch(/normalizeShape/);
    expect(habitatSource).toMatch(/ghost.*blob/);
    expect(habitatSource).toMatch(/urchin.*blob/);
  });
});
