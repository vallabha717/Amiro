import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { messagesBeforeTurn, recoveryFor } from "./use-resume-chat-turn";

const msg = (id: string, role: UIMessage["role"]): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: id }],
});

describe("messagesBeforeTurn", () => {
  it("drops the partial reply after the last user message", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2-partial", "assistant"),
    ];
    expect(messagesBeforeTurn(messages).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  it("keeps everything when the user message is last", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")];
    expect(messagesBeforeTurn(messages)).toBe(messages);
  });

  it("never empties a chat that has no user message", () => {
    const messages = [msg("a1", "assistant")];
    expect(messagesBeforeTurn(messages)).toBe(messages);
  });
});

describe("recoveryFor", () => {
  it("replays a turn the server still has, loads history otherwise", () => {
    expect(recoveryFor("running")).toBe("replay");
    expect(recoveryFor("finished")).toBe("replay");
    expect(recoveryFor("none")).toBe("reload-history");
  });
});
