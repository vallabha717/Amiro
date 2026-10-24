import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./markdown-blocks";

describe("splitMarkdownBlocks", () => {
  it("splits paragraphs on blank lines", () => {
    expect(splitMarkdownBlocks("first para\n\nsecond para")).toEqual([
      "first para",
      "second para",
    ]);
  });

  it("keeps a fenced code block whole, blank lines and all", () => {
    const md = [
      "Here is code:",
      "",
      "```js",
      "const a = 1;",
      "",
      "console.log(a);",
      "```",
      "",
      "Done.",
    ].join("\n");

    expect(splitMarkdownBlocks(md)).toEqual([
      "Here is code:",
      "```js\nconst a = 1;\n\nconsole.log(a);\n```",
      "Done.",
    ]);
  });

  // While streaming, the closing fence has not arrived yet. The partial block
  // must stay one block, or the renderer flashes raw backticks mid-reply.
  it("keeps an unterminated code fence as a single block", () => {
    const md = "Intro\n\n```py\nprint(1)\n\nprint(2)";
    expect(splitMarkdownBlocks(md)).toEqual([
      "Intro",
      "```py\nprint(1)\n\nprint(2)",
    ]);
  });

  it("keeps a list's items together as one block", () => {
    const md = "- one\n- two\n- three";
    expect(splitMarkdownBlocks(md)).toEqual([md]);
  });

  it("keeps a table together as one block", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    expect(splitMarkdownBlocks(md)).toEqual([md]);
  });

  it("returns nothing for empty input", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n  \n")).toEqual([]);
  });

  // The property that matters for streaming: as text grows one character at a
  // time, every block except the last must stay byte-identical, so memoized
  // blocks never invalidate.
  it("leaves earlier blocks stable as the document grows", () => {
    const full = "First block.\n\nSecond block.\n\nThird block being written";
    let previous: string[] = [];
    for (let i = 1; i <= full.length; i++) {
      const blocks = splitMarkdownBlocks(full.slice(0, i));
      // every completed block must match what it was on the prior tick
      for (let b = 0; b < blocks.length - 1; b++) {
        if (previous[b] !== undefined && b < previous.length - 1) {
          expect(blocks[b]).toBe(previous[b]);
        }
      }
      previous = blocks;
    }
    expect(previous).toEqual([
      "First block.",
      "Second block.",
      "Third block being written",
    ]);
  });
});
