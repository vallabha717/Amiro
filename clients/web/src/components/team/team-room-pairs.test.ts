import type { TeamRoomMessage } from "@/lib/backend/team-room-api";
import { describe, expect, it } from "vitest";
import { pairMessages } from "./team-room-pairs";

const at = "2026-10-27T10:00:00Z";
const user = (id: string, to: string[]): TeamRoomMessage => ({
  id,
  from: { type: "user", id: "u1", name: "Asha" },
  to,
  text: id,
  hop: 0,
  createdAt: at,
});
const agent = (
  id: string,
  from: string,
  to: string[],
  replyTo?: string,
): TeamRoomMessage => ({
  id,
  from: { type: "agent", id: from, name: from },
  to,
  text: id,
  hop: 1,
  createdAt: at,
  replyTo,
});

describe("pairMessages", () => {
  const room: TeamRoomMessage[] = [
    user("ask", ["main"]),
    agent("handoff", "main", ["scout"], "ask"),
    agent("answer", "scout", [], "handoff"),
    agent("to-user", "scout", [], "ask"),
    agent("other", "main", ["writer"], "ask"),
    {
      id: "notice",
      from: { type: "system" },
      to: [],
      text: "",
      hop: 2,
      createdAt: at,
      kind: "empty",
      agentId: "writer",
      replyTo: "other",
    },
  ];

  it("keeps hand-offs between the two and the answers to them", () => {
    expect(pairMessages(room, "main", "scout").map((m) => m.id)).toEqual([
      "handoff",
      "answer",
    ]);
    expect(pairMessages(room, "scout", "main").map((m) => m.id)).toEqual([
      "handoff",
      "answer",
    ]);
  });

  it("includes a notice about one agent answering the other", () => {
    expect(pairMessages(room, "main", "writer").map((m) => m.id)).toEqual([
      "other",
      "notice",
    ]);
  });

  it("leaves out the person's messages and replies to them", () => {
    expect(pairMessages(room, "scout", "writer")).toEqual([]);
  });
});
