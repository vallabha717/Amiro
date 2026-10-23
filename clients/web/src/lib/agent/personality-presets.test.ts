import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const studioSource = readFileSync(
  path.join(import.meta.dirname, "../../components/agent/agent-personality-studio.tsx"),
  "utf8",
);

describe("personality presets", () => {
  it("declares exactly 7 presets including 3 new ones", () => {
    const matches = [...studioSource.matchAll(/id:\s*"(midnight-strategist|studio-dreamer|field-engineer|operator|companion|hacker|balanced)"/g)];
    const ids = matches.map((m) => m[1]);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toContain("midnight-strategist");
    expect(ids).toContain("studio-dreamer");
    expect(ids).toContain("field-engineer");
  });

  it("has no em dash in source (uses hyphen only)", () => {
    expect(studioSource).not.toMatch(/—/);
  });

  it("preset values are within 0-100 and have all 5 axes", () => {
    const blocks = [...studioSource.matchAll(/values:\s*\{([^}]+)\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const b of blocks) {
      const body = b[1] ?? "";
      const keys = ["companionCoworker", "genzBoomer", "executeCollaborate", "playfulSerious", "politeUnfiltered"];
      for (const k of keys) {
        expect(body).toContain(k);
      }
      const nums = [...body.matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]));
      for (const n of nums) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
      }
    }
  });
});
