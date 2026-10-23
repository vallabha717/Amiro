import { describe, expect, it } from "vitest";
import { matchSkills } from "./skill-palette";

const skills = [
  { name: "start-the-day", description: "Daily briefing: weather, headlines and your calendar." },
  { name: "weather", description: "Current conditions and forecasts." },
  { name: "visualize", displayName: "Charts & diagrams", description: "Inline visuals." },
];

describe("matchSkills", () => {
  it("lists everything for an empty query", () => {
    expect(matchSkills(skills, " ")).toHaveLength(3);
  });

  it("puts name-prefix matches before description matches", () => {
    expect(matchSkills(skills, "weath").map((s) => s.name)).toEqual(["weather", "start-the-day"]);
  });

  it("matches display names and descriptions, case-insensitively", () => {
    expect(matchSkills(skills, "CHARTS").map((s) => s.name)).toEqual(["visualize"]);
    expect(matchSkills(skills, "headlines").map((s) => s.name)).toEqual(["start-the-day"]);
    expect(matchSkills(skills, "zzz")).toEqual([]);
  });
});
