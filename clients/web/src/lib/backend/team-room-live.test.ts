import { describe, expect, it } from "vitest";
import type { TeamRoom, TeamRoomMessage } from "./team-room-api";
import { applyTeamRoomEvent, parseSseFrames } from "./team-room-live";

const message = (id: string, extra: Partial<TeamRoomMessage> = {}): TeamRoomMessage => ({
  id,
  from: { type: "agent", id: "scout", name: "Scout" },
  to: [],
  text: id,
  hop: 1,
  createdAt: "2026-10-27T10:00:00Z",
  ...extra,
});
const draft = { id: "d1", agentId: "scout", replyTo: "ask", text: "Kor", tool: null, startedAt: "t" };
const room: TeamRoom = { messages: [message("ask")], working: ["scout"], drafts: [], maxHops: 4 };

describe("parseSseFrames", () => {
  it("returns complete frames and keeps the unfinished rest", () => {
    const { events, rest } = parseSseFrames('data: {"type":"a"}\n\n:keepalive\n\ndata: {"type"');
    expect(events).toEqual(['{"type":"a"}']);
    expect(rest).toBe('data: {"type"');
  });

  it("handles CRLF and drops non-JSON data", () => {
    const { events } = parseSseFrames('data: {"x":1}\r\n\r\ndata: keepalive\n\n');
    expect(events).toEqual(['{"x":1}']);
  });
});

describe("applyTeamRoomEvent", () => {
  it("adds a draft, then swaps it for the finished reply", () => {
    const typing = applyTeamRoomEvent(room, { type: "draft", draft });
    expect(typing.drafts).toEqual([draft]);
    const longer = applyTeamRoomEvent(typing, { type: "draft", draft: { ...draft, text: "Koregaon" } });
    expect(longer.drafts.map((d) => d.text)).toEqual(["Koregaon"]);
    const done = applyTeamRoomEvent(longer, {
      type: "message",
      message: message("reply", { draftId: "d1", replyTo: "ask" }),
    });
    expect(done.drafts).toEqual([]);
    expect(done.messages.map((m) => m.id)).toEqual(["ask", "reply"]);
  });

  it("never duplicates a message and ignores a late draft frame", () => {
    const done = applyTeamRoomEvent(room, { type: "message", message: message("reply", { draftId: "d1" }) });
    const twice = applyTeamRoomEvent(done, { type: "message", message: message("reply", { draftId: "d1" }) });
    expect(twice.messages).toHaveLength(2);
    expect(applyTeamRoomEvent(twice, { type: "draft", draft }).drafts).toEqual([]);
  });

  it("replaces everything on a snapshot and tracks who is working", () => {
    const snap = applyTeamRoomEvent(room, { type: "snapshot", messages: [], working: [], drafts: [draft], maxHops: 4 });
    expect(snap).toEqual({ messages: [], working: [], drafts: [draft], maxHops: 4 });
    expect(applyTeamRoomEvent(snap, { type: "working", working: ["main"] }).working).toEqual(["main"]);
    expect(applyTeamRoomEvent(snap, { type: "draft.end", id: "d1" }).drafts).toEqual([]);
  });
});
