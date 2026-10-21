import { describe, expect, it } from "vitest";
import { type AgentThread, sortAgentThreads } from "./agents-api";

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
