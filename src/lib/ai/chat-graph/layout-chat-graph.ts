import { ChatGraphNode } from "app-types/chat-graph";
import {
  CHAT_GRAPH_CARD_SPACING,
  CHAT_GRAPH_COLUMN_GAP,
  getEstimatedNodeHeight,
  getEstimatedNodeWidth,
} from "./derive-chat-graph";

export type ChatGraphLayoutBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Stacks each lane's cards into a column using their real measured sizes.
 *
 * `deriveChatGraph` can only guess heights, and a card's true height swings
 * wildly with its content (a rendered chart, a long response, a tool result),
 * so a guess-based layout inevitably overlaps once a guess runs short.
 * Re-flowing from measured sizes is what actually guarantees the gaps hold;
 * the estimates are only a fallback for cards not measured yet.
 *
 * Lanes carrying a single card (INPUT, OUTPUT) simply land on the spine at
 * y = 0; an execution lane stacks downwards from it. Empty lanes cost no
 * horizontal space, so a turn that ran no steps closes up naturally.
 */
export function layoutChatGraph(
  nodes: ChatGraphNode[],
): Map<string, ChatGraphLayoutBox> {
  const columns = new Map<number, ChatGraphNode[]>();
  for (const node of nodes) {
    const lane = node.data.laneIndex ?? 0;
    const column = columns.get(lane);
    if (column) column.push(node);
    else columns.set(lane, [node]);
  }

  const boxes = new Map<string, ChatGraphLayoutBox>();
  let columnX = 0;

  for (const lane of [...columns.keys()].sort((a, b) => a - b)) {
    // Insertion order within a lane is already the execution order.
    const column = columns.get(lane)!;
    const sized = column.map((node) => ({
      node,
      width: node.measured?.width || getEstimatedNodeWidth(node.data),
      height: node.measured?.height || getEstimatedNodeHeight(node.data),
    }));
    const columnWidth = Math.max(...sized.map((entry) => entry.width));

    // Every lane is centred on the same horizontal axis (y = 0), so a lone
    // INPUT or OUTPUT card lines up with the middle of the execution column
    // beside it and the spine stays level across the whole graph.
    const stackHeight =
      sized.reduce((total, entry) => total + entry.height, 0) +
      CHAT_GRAPH_CARD_SPACING * Math.max(0, sized.length - 1);

    let y = -stackHeight / 2;
    for (const { node, width, height } of sized) {
      // Centre narrower cards inside a column widened by a chart card.
      boxes.set(node.id, {
        x: columnX + (columnWidth - width) / 2,
        y,
        width,
        height,
      });
      y += height + CHAT_GRAPH_CARD_SPACING;
    }
    columnX += columnWidth + CHAT_GRAPH_COLUMN_GAP;
  }

  return boxes;
}
