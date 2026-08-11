import { describe, it, expect } from "vitest";
import { ChatGraphNode, ChatGraphNodeKind } from "app-types/chat-graph";
import {
  CHAT_GRAPH_CARD_SPACING,
  CHAT_GRAPH_COLUMN_GAP,
} from "./derive-chat-graph";
import { ChatGraphLayoutBox, layoutChatGraph } from "./layout-chat-graph";

function node(
  id: string,
  laneIndex: number,
  measured?: { width: number; height: number },
  kind: ChatGraphNodeKind = "tool",
): ChatGraphNode {
  return {
    id,
    type: "chatGraphNode",
    position: { x: 0, y: 0 },
    measured,
    data: {
      kind,
      label: id,
      status: "success",
      messageId: id,
      turnIndex: 0,
      laneIndex,
    },
  } as ChatGraphNode;
}

function overlaps(a: ChatGraphLayoutBox, b: ChatGraphLayoutBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function expectNoOverlap(boxes: Map<string, ChatGraphLayoutBox>) {
  const entries = [...boxes.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      expect(
        overlaps(a, b),
        `${idA} ${JSON.stringify(a)} overlaps ${idB} ${JSON.stringify(b)}`,
      ).toBe(false);
    }
  }
}

describe("layoutChatGraph", () => {
  it("returns nothing for an empty graph", () => {
    expect(layoutChatGraph([]).size).toBe(0);
  });

  it("stacks a column using measured heights, never overlapping", () => {
    const boxes = layoutChatGraph([
      node("a", 0, { width: 288, height: 140 }),
      node("b", 0, { width: 288, height: 620 }),
      node("c", 0, { width: 288, height: 95 }),
    ]);

    const a = boxes.get("a")!;
    const b = boxes.get("b")!;
    const c = boxes.get("c")!;
    expect(b.y - (a.y + a.height)).toBe(CHAT_GRAPH_CARD_SPACING);
    expect(c.y - (b.y + b.height)).toBe(CHAT_GRAPH_CARD_SPACING);
    expectNoOverlap(boxes);
  });

  it("centres every lane on the spine so INPUT/OUTPUT face the column's middle", () => {
    const boxes = layoutChatGraph([
      node("input", 0, { width: 288, height: 180 }, "prompt"),
      node("step-1", 1, { width: 288, height: 300 }),
      node("step-2", 1, { width: 288, height: 500 }),
      node("step-3", 1, { width: 288, height: 220 }),
      node("output", 2, { width: 288, height: 180 }, "response"),
    ]);

    const centreOf = (id: string) => {
      const box = boxes.get(id)!;
      return box.y + box.height / 2;
    };

    // The execution column spans from the top of its first card to the bottom
    // of its last; INPUT and OUTPUT sit level with that span's midpoint.
    const first = boxes.get("step-1")!;
    const last = boxes.get("step-3")!;
    const columnCentre = (first.y + (last.y + last.height)) / 2;

    expect(centreOf("input")).toBeCloseTo(columnCentre, 6);
    expect(centreOf("output")).toBeCloseTo(columnCentre, 6);
    expect(centreOf("input")).toBeCloseTo(centreOf("output"), 6);

    // A centred column straddles the axis rather than hanging below it.
    expect(first.y).toBeLessThan(0);
    expect(last.y + last.height).toBeGreaterThan(0);
    expectNoOverlap(boxes);
  });

  it("keeps the vertical gap exact regardless of how tall a card measures", () => {
    // A rendered chart or a long table can be far taller than any estimate.
    const boxes = layoutChatGraph([
      node("tall", 0, { width: 384, height: 2400 }, "chart"),
      node("after", 0, { width: 288, height: 180 }),
    ]);

    const tall = boxes.get("tall")!;
    const after = boxes.get("after")!;
    expect(after.y - (tall.y + tall.height)).toBe(CHAT_GRAPH_CARD_SPACING);
    expectNoOverlap(boxes);
  });

  it("separates lanes by the column gap and centres narrow cards", () => {
    const boxes = layoutChatGraph([
      node("t0-chart", 0, { width: 384, height: 400 }, "chart"),
      node("t0-tool", 0, { width: 288, height: 200 }),
      node("t1", 1, { width: 288, height: 200 }),
    ]);

    // The chart widens the column; the narrower card centres inside it.
    expect(boxes.get("t0-chart")!.x).toBe(0);
    expect(boxes.get("t0-tool")!.x).toBe((384 - 288) / 2);
    expect(boxes.get("t1")!.x).toBe(384 + CHAT_GRAPH_COLUMN_GAP);
    expectNoOverlap(boxes);
  });

  it("falls back to estimates for cards React Flow has not measured yet", () => {
    const boxes = layoutChatGraph([node("a", 0), node("b", 0)]);
    expect(boxes.get("a")!.height).toBeGreaterThan(0);
    expectNoOverlap(boxes);
  });

  it("never overlaps across a mixed, unevenly sized multi-lane graph", () => {
    const kinds: ChatGraphNodeKind[] = [
      "prompt",
      "llm",
      "tool",
      "chart",
      "code",
      "http",
      "response",
    ];
    const nodes: ChatGraphNode[] = [];
    for (let lane = 0; lane < 6; lane++) {
      for (let i = 0; i < 7; i++) {
        const kind = kinds[i];
        nodes.push(
          node(
            `l${lane}-n${i}`,
            lane,
            // Deliberately erratic sizes, including a zero-height card.
            { width: kind === "chart" ? 384 : 288, height: (i * 137) % 700 },
            kind,
          ),
        );
      }
    }
    expectNoOverlap(layoutChatGraph(nodes));
  });
});
