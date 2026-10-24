import { describe, expect, it } from "vitest";
import type { WorkLogRow } from "./work-log";
import { summarizeWork } from "./work-summary";

const group = (
  kind: "command" | "search" | "edit" | "explore" | "other",
  count: number,
): WorkLogRow => ({
  type: "group",
  kind,
  glances: Array.from({ length: count }, () => ({ text: "x", failed: false })),
  children: null,
});

describe("summarizeWork", () => {
  it("chains phrases like 'Ran 4 commands, used a tool'", () => {
    expect(summarizeWork([group("command", 4), group("other", 1)], false)).toBe(
      "Ran 4 commands, used a tool",
    );
  });

  it("leads with thinking and adds up groups of the same kind", () => {
    expect(
      summarizeWork(
        [group("explore", 4), group("edit", 3), group("edit", 7)],
        true,
      ),
    ).toBe("Thought, read 4 files, edited 10 files");
  });

  it("names a lone web search", () => {
    expect(summarizeWork([group("search", 1)], false)).toBe("Searched the web");
  });
});
