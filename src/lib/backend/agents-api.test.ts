import { describe, expect, it } from "vitest";
import {
  type AgentThread,
  agentPagePath,
  sortAgentThreads,
  teamPath,
} from "./agents-api";

describe("team agent paths", () => {
  it("opens the main agent on the bare Team view", () => {
    expect(teamPath("main")).toBe("/team");
    expect(teamPath("abc")).toBe("/team?agent=abc");
  });

  it("encodes ids in query parameters", () => {
    expect(agentPagePath("a&b")).toBe("/team/agent?id=a%26b");
  });
});

describe("sortAgentThreads", () => {
  it("pins the channel above newer chats", () => {
    const threads: AgentThread[] = [
      { id: "old", title: "Old", channel: false, lastMessageAt: "2026-01-01" },
      { id: "chan", title: "Scout", channel: true, lastMessageAt: "2025-01-01" },
      { id: "new", title: "New", channel: false, lastMessageAt: "2026-06-01" },
    ];
    expect(sortAgentThreads(threads).map((t) => t.id)).toEqual([
      "chan",
      "new",
      "old",
    ]);
  });
});
