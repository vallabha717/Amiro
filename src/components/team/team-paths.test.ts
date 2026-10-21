import { describe, expect, it } from "vitest";
import { agentSpacePath, teamThreadPath } from "./team-paths";

describe("team paths", () => {
  it("opens an agent's Team thread beside the list", () => {
    expect(teamThreadPath("main")).toBe("/team?agent=main");
    expect(teamThreadPath("a&b")).toBe("/team?agent=a%26b");
  });

  it("opens the main agent's space as Amiro itself", () => {
    expect(agentSpacePath("main")).toBe("/");
  });

  it("opens a team agent's space as Amiro scoped to it", () => {
    expect(agentSpacePath("abc")).toBe("/?agent=abc");
  });
});
