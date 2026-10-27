import { describe, expect, it } from "vitest";
import { insertMention, matchAgents, mentionQuery } from "./team-room-mentions";

describe("mentionQuery", () => {
  it("finds the @word before the caret", () => {
    expect(mentionQuery("hi @sc", 6)).toBe("sc");
    expect(mentionQuery("@", 1)).toBe("");
    expect(mentionQuery("@Scout please", 6)).toBe("Scout");
  });

  it("ignores emails and finished words", () => {
    expect(mentionQuery("mail a@b", 8)).toBeNull();
    expect(mentionQuery("@Scout please", 13)).toBeNull();
    expect(mentionQuery("", 0)).toBeNull();
  });
});

describe("insertMention", () => {
  it("completes the word being typed", () => {
    expect(insertMention("hi @sc", 6, "Scout")).toEqual({ text: "hi @Scout ", caret: 10 });
  });

  it("adds a mention at the caret with a separating space", () => {
    expect(insertMention("hello", 5, "Writer Bot")).toEqual({
      text: "hello @Writer Bot ",
      caret: 18,
    });
    expect(insertMention("", 0, "Scout")).toEqual({ text: "@Scout ", caret: 7 });
  });

  it("keeps the text after the caret", () => {
    expect(insertMention("@sc find it", 3, "Scout")).toEqual({
      text: "@Scout find it",
      caret: 7,
    });
  });
});

describe("matchAgents", () => {
  const agents = [{ name: "Amiro" }, { name: "Scout" }, { name: "Mascot" }];
  it("puts prefix matches first", () => {
    expect(matchAgents(agents, "sc").map((a) => a.name)).toEqual(["Scout", "Mascot"]);
    expect(matchAgents(agents, "").map((a) => a.name)).toEqual(["Amiro", "Scout", "Mascot"]);
  });
});
