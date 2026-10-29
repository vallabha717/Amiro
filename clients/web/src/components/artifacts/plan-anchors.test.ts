import { describe, expect, it } from "vitest";
import {
  anchorState,
  blockId,
  commentsByBlock,
  normalizeQuote,
  planBlocks,
} from "./plan-anchors";

const PLAN = `## Phase 1

Add the propose_plan tool with no server executor.

| file | change |
| --- | --- |
| plan.go | new tool |
| tools.go | wire it up |

## Phase 2

Build the artifact pane.`;

describe("planBlocks", () => {
  it("keeps a table as one block so a comment can name a row", () => {
    const blocks = planBlocks(PLAN);
    const table = blocks.find((b) => b.source.includes("| plan.go |"));
    expect(table).toBeDefined();
    expect(table!.source).toContain("| tools.go |");
  });

  it("tags each block with the heading above it", () => {
    const blocks = planBlocks(PLAN);
    const pane = blocks.find((b) => b.source.includes("artifact pane"));
    expect(pane?.section).toBe("Phase 2");
    const table = blocks.find((b) => b.source.includes("| plan.go |"));
    expect(table?.section).toBe("Phase 1");
  });

  it("gives identical text the same id and different text a different one", () => {
    expect(blockId("hello")).toBe(blockId("hello"));
    expect(blockId("hello")).not.toBe(blockId("hello "));
  });
});

describe("anchorState", () => {
  const blocks = planBlocks(PLAN);

  it("attaches a quote that is still in the plan", () => {
    const state = anchorState(
      { quote: "no server executor", blockId: "whatever" },
      blocks,
    );
    expect(state.kind).toBe("attached");
  });

  // The point of quoting rather than indexing: a revision that reorders or
  // rewrites everything above the anchor must not move the comment.
  it("re-attaches after the plan is rewritten around it", () => {
    const revised = planBlocks(
      `## Rewritten intro\n\nEntirely new opening paragraph.\n\n## Phase 1\n\nAdd the propose_plan tool with no server executor.`,
    );
    const state = anchorState(
      { quote: "no server executor", blockId: blocks[1].id },
      revised,
    );
    expect(state.kind).toBe("attached");
  });

  it("matches across a line wrap", () => {
    const wrapped = planBlocks(
      "Add the propose_plan tool\nwith no server executor.",
    );
    expect(
      anchorState({ quote: "tool with no server", blockId: "x" }, wrapped).kind,
    ).toBe("attached");
  });

  // Reported, not dropped. A comment vanishing looks like the app lost it,
  // when what happened is the agent answered the objection by deleting the
  // thing objected to -- which the user needs to see and confirm.
  it("reports a quote the agent removed as outdated", () => {
    const revised = planBlocks("## Phase 1\n\nThe tool now runs server-side.");
    const state = anchorState(
      { quote: "no server executor", blockId: blocks[1].id },
      revised,
    );
    expect(state.kind).toBe("outdated");
  });

  // The quote comes from the rendered page, the blocks are markdown source.
  it("attaches a quote taken from formatted text", () => {
    const formatted = planBlocks(
      "## Steps\n\n- Run a **soft opening** week for [friends](https://x.test) with `oat milk` tastings\n\n| Day | Event |\n| --- | --- |\n| Fri | Launch party |",
    );
    for (const quote of [
      "Run a soft opening week for friends with oat milk tastings",
      "Fri Launch party",
      "Steps",
    ]) {
      expect(anchorState({ quote, blockId: "x" }, formatted).kind).toBe(
        "attached",
      );
    }
  });

  it("attaches a selection dragged across two blocks to the first", () => {
    const span = planBlocks(
      "## Goal\n\nOpen Brew & Bloom in Pune.\n\n- Book the space\n- Hire baristas",
    );
    const state = anchorState(
      { quote: "Open Brew & Bloom in Pune. Book the space", blockId: "x" },
      span,
    );
    expect(state).toEqual({
      kind: "attached",
      blockId: span.find((b) => b.source.startsWith("Open"))!.id,
    });
  });

  it("matches a capped quote by its visible part", () => {
    const long = `${"word ".repeat(60)}end`;
    const quote = normalizeQuote(long);
    expect(anchorState({ quote, blockId: "x" }, planBlocks(long)).kind).toBe(
      "attached",
    );
  });

  it("treats an empty quote as outdated rather than matching everything", () => {
    expect(anchorState({ quote: "   ", blockId: "x" }, blocks).kind).toBe(
      "outdated",
    );
  });
});

describe("commentsByBlock", () => {
  it("splits comments into attached and outdated", () => {
    const blocks = planBlocks(PLAN);
    const { attached, outdated } = commentsByBlock(
      [
        { id: "1", quote: "artifact pane", note: "too broad", blockId: "x" },
        { id: "2", quote: "a thing never written", note: "?", blockId: "y" },
      ],
      blocks,
    );
    expect(outdated.map((c) => c.id)).toEqual(["2"]);
    expect([...attached.values()].flat().map((c) => c.id)).toEqual(["1"]);
  });
});

describe("normalizeQuote", () => {
  it("collapses whitespace so a wrapped selection still matches", () => {
    expect(normalizeQuote("  two\n  lines  ")).toBe("two lines");
  });

  // A selection long enough to cover half the document is a copy, not an
  // anchor, and it would match nothing after any revision.
  it("caps a runaway selection", () => {
    const long = "x".repeat(500);
    const quote = normalizeQuote(long);
    expect(quote.length).toBeLessThanOrEqual(241);
    expect(quote.endsWith("…")).toBe(true);
  });
});
