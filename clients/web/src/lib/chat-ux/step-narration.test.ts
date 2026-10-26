import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { narrateStep, thoughtPreview } from "./step-narration";

const t = createTranslator({
  locale: "en",
  messages: en,
  namespace: "ChatStream.Narrate",
}) as unknown as Parameters<typeof narrateStep>[0];

const searchOutput = [
  "Provider: Bing",
  'Query: "bun release"',
  "",
  "1. **Bun 1.2**",
  "   https://bun.sh/blog/bun-v1.2",
  "   Release notes.",
  "",
  "2. **Bun on GitHub**",
  "   https://github.com/oven-sh/bun/releases",
  "   Releases.",
].join("\n");

describe("narrateStep", () => {
  it("tells a web search in present tense, then past tense with its sources", () => {
    expect(
      narrateStep(t, "websearch", { input: { query: "bun release" }, output: undefined, status: "pending" }).title,
    ).toBe("Searching the web for “bun release”");
    const done = narrateStep(t, "websearch", {
      input: { query: "bun release" },
      output: searchOutput,
      status: "success",
    });
    expect(done.title).toBe("Searched “bun release”");
    expect(done.kind).toBe("search");
    expect(done.detail).toMatch(/2 results from bun\.sh, github\.com/);
  });

  it("shows a command's first line of output as its result", () => {
    const n = narrateStep(t, "bash", {
      input: { command: "uname -m" },
      output: "x86_64\n",
      status: "success",
    });
    expect(n.title).toBe("Ran uname -m");
    expect(n.detail).toBe("x86_64");
    expect(n.kind).toBe("command");
  });

  it("names the file an edit touched and its line counts", () => {
    const n = narrateStep(t, "edit_file", {
      input: { path: "/tmp/runtime-compare.md" },
      output: { path: "/tmp/runtime-compare.md", added: 3, removed: 1 },
      status: "success",
    });
    expect(n.title).toBe("Edited runtime-compare.md");
    expect(n.detail).toBe("+3 −1");
  });

  it("recognises the question card behind a generic mcp call", () => {
    const n = narrateStep(t, "mcp", {
      input: { server: "amiro", tool: "ui_ask_user", arguments: { questions: [{}, {}] } },
      output: undefined,
      status: "pending",
    });
    expect(n.kind).toBe("ask");
    expect(n.title).toBe("Asking you 2 questions");
  });

  it("uses the model's intent for tools it has no sentence for", () => {
    const n = narrateStep(t, "some_tool", {
      input: { intent: "Record runtime decision state" },
      output: {},
      status: "success",
    });
    expect(n.title).toBe("Record runtime decision state");
    expect(n.detail).toBe("some tool");
  });

  it("says plainly when a step failed", () => {
    expect(
      narrateStep(t, "websearch", { input: { query: "x" }, output: undefined, status: "error" }).title,
    ).toBe("Web search failed for “x”");
  });
});

describe("thoughtPreview", () => {
  it("keeps the first sentence without markdown", () => {
    expect(thoughtPreview("**Plan:** search three times. Then compare.")).toBe(
      "Plan: search three times.",
    );
  });
});
