import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { chatFilesFrom } from "./chat-files";

const msg = (role: "user" | "assistant", ...parts: any[]): UIMessage =>
  ({ id: Math.random().toString(), role, parts }) as UIMessage;
const text = (t: string) => ({ type: "text", text: t });

describe("chatFilesFrom", () => {
  it("collects code spans, links and bare paths, once each", () => {
    const files = chatFilesFrom([
      msg("user", text("open `reports/q3.xlsx` please")),
      msg(
        "assistant",
        text("Made [the deck](out/deck.pptx) and saved to ~/.amiro/workspace/out/notes.docx. Also `reports/q3.xlsx`."),
      ),
    ]);
    expect(files.map((f) => f.path).sort()).toEqual(["out/deck.pptx", "out/notes.docx", "reports/q3.xlsx"]);
  });

  it("reads the files a tool touched", () => {
    const files = chatFilesFrom([
      msg("assistant", { type: "tool-write", state: "output-available", toolCallId: "1", input: { path: "a/b.md", content: "x" } }),
    ]);
    expect(files).toEqual([{ path: "a/b.md", name: "b.md" }]);
  });

  it("ignores code samples, urls, system paths and plain words", () => {
    const files = chatFilesFrom([
      msg(
        "assistant",
        text("```\ncat src/app.ts\n```\nSee https://x.com/a.pdf, /etc/hosts.txt, version 1.2 and `useState`."),
      ),
    ]);
    expect(files).toEqual([]);
  });
});
