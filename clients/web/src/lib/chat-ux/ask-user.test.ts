import { describe, expect, it } from "vitest";
import { formatAskUserReply, isAnswered, parseAskUser } from "./ask-user";

const card = {
  questions: [
    {
      id: "q1",
      question: "Which database?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Relational {fast}" },
        { label: "SQLite", description: null },
      ],
      multiSelect: false,
    },
  ],
};
const text = `Showed the user a question card.\n\nASK_USER ${JSON.stringify(card)}`;

describe("parseAskUser", () => {
  it("reads the card from a plain text result", () => {
    const parsed = parseAskUser(text);
    expect(parsed?.questions[0].question).toBe("Which database?");
    expect(parsed?.questions[0].options.map((o) => o.label)).toEqual([
      "Postgres",
      "SQLite",
    ]);
  });

  it("reads the card from an MCP content array", () => {
    const parsed = parseAskUser({ content: [{ type: "text", text }] });
    expect(parsed?.questions).toHaveLength(1);
  });

  it("keeps braces inside strings from ending the JSON early", () => {
    expect(parseAskUser(text)?.questions[0].options[0].description).toBe(
      "Relational {fast}",
    );
  });

  it("returns null without a card or for a broken one", () => {
    expect(parseAskUser("no card here")).toBeNull();
    expect(parseAskUser("ASK_USER {\"questions\": [")).toBeNull();
    expect(parseAskUser(undefined)).toBeNull();
  });
});

describe("formatAskUserReply", () => {
  it("writes one line per question with picks and the other answer", () => {
    const req = parseAskUser(text)!;
    expect(
      formatAskUserReply(req, { q1: { selected: ["SQLite"], other: "or DuckDB" } }),
    ).toBe("- Which database? → SQLite, or DuckDB");
    expect(formatAskUserReply(req, {})).toBe("- Which database? → (no answer)");
  });

  it("isAnswered needs a pick or non-blank other text", () => {
    expect(isAnswered({ selected: [] })).toBe(false);
    expect(isAnswered({ selected: [], other: "  " })).toBe(false);
    expect(isAnswered({ selected: ["A"] })).toBe(true);
  });
});
