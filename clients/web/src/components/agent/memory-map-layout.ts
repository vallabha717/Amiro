import type {
  AgentMemoryEdge,
  AgentMemoryNode,
} from "./agent-memory-view";

/* -------------------------------------------------------------------------- */
/* Memory map layout: pure, deterministic 2D atlas geometry.                   */
/*                                                                             */
/* No DOM, no React, no animation. Given the same memories in the same order,  */
/* the same positions come back, so the atlas is stable between renders.       */
/* -------------------------------------------------------------------------- */

/**
 * How many memories the map shows initially. 60 legible cards cannot fit
 * 1100x600 without shrinking text to microscopic size, so the initial slice
 * is bounded to 20 balanced across categories with explicit hidden counts
 * and a Show more control. Fit view resets to 1:1 readable, never
 * scale-to-fit-all.
 */
export const MAP_PAGE_SIZE = 20;

/** Upper bound offered by Show more before the reader scrolls/pans. */
export const MAP_PAGE_MAX = 60;

/** Compact atlas card: fits a 3x2 overview grid at legible 1:1 text. */
export const MAP_NODE_WIDTH = 300;
export const MAP_NODE_HEIGHT = 92;

export const MAP_COLUMNS = 3;
const MAP_HEADER_HEIGHT = 96;
const MAP_CLUSTER_PAD_X = 14;
const MAP_CLUSTER_PAD_Y = 14;
const MAP_NODE_GAP_X = 14;
const MAP_NODE_GAP_Y = 12;
const MAP_CLUSTER_GAP_X = 24;
const MAP_CLUSTER_GAP_Y = 24;
const MAP_MARGIN = 24;

export const MAP_CLUSTER_ORDER = [
  "fact",
  "preference",
  "entity",
  "correction",
  "other",
] as const;

export type MapClusterKey = (typeof MAP_CLUSTER_ORDER)[number];

export interface MapClusterInfo {
  key: MapClusterKey;
  singular: string;
  /** Plural label shown on the cluster header. */
  plural: string;
  description: string;
  color: string;
}

/**
 * Same hues as the memory view so the atlas matches the cards. Local copy on
 * purpose: this module stays dependency-free apart from the shared types.
 */
export const MAP_CLUSTER_INFO: Record<MapClusterKey, MapClusterInfo> = {
  fact: {
    key: "fact",
    singular: "Fact",
    plural: "Facts",
    description: "Durable truths about people, projects, and how things work.",
    color: "#467CC8",
  },
  preference: {
    key: "preference",
    singular: "Preference",
    plural: "Preferences",
    description: "How the user likes things done and which defaults to pick.",
    color: "#7A5AF5",
  },
  entity: {
    key: "entity",
    singular: "Entity",
    plural: "Entities",
    description: "People, projects, tools, and places worth remembering.",
    color: "#0E9B8B",
  },
  correction: {
    key: "correction",
    singular: "Correction",
    plural: "Corrections",
    description: "Fixes to past mistakes and what to do instead next time.",
    color: "#E86B40",
  },
  other: {
    key: "other",
    singular: "Other",
    plural: "Other",
    description: "Anything useful that fits nowhere else.",
    color: "#8D99A5",
  },
};

export function normalizeMapCategory(category: string): MapClusterKey {
  return (
    MAP_CLUSTER_ORDER as readonly string[]
  ).includes(category)
    ? (category as MapClusterKey)
    : "other";
}

export function clusterInfo(category: string): MapClusterInfo {
  return MAP_CLUSTER_INFO[normalizeMapCategory(category)];
}

export interface PositionedMemoryNode {
  memory: AgentMemoryNode;
  cluster: MapClusterKey;
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export interface PositionedCluster {
  info: MapClusterInfo;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MemoryMapLayout {
  nodes: PositionedMemoryNode[];
  clusters: PositionedCluster[];
  width: number;
  height: number;
  byId: Map<string, PositionedMemoryNode>;
}

/**
 * Lay memories out as a 3x2 atlas grid of category regions: three region
 * columns on the first row, two on the second. Every category is visible in
 * one overview without horizontal scrolling on desktop, and mobile pans a
 * readable slice instead of shrinking the atlas. Nodes flow row-first inside
 * each region in input order, so positions are stable and never overlap.
 */
export function layoutMemoryMap(
  memories: AgentMemoryNode[],
  options?: { nodeWidth?: number; nodeHeight?: number; columns?: number },
): MemoryMapLayout {
  const nodeWidth = options?.nodeWidth ?? MAP_NODE_WIDTH;
  const nodeHeight = options?.nodeHeight ?? MAP_NODE_HEIGHT;
  const columns = options?.columns ?? MAP_COLUMNS;

  const groups = new Map<MapClusterKey, AgentMemoryNode[]>();
  for (const key of MAP_CLUSTER_ORDER) groups.set(key, []);
  for (const memory of memories) {
    groups.get(normalizeMapCategory(memory.category))?.push(memory);
  }

  const activeKeys = MAP_CLUSTER_ORDER.filter(
    (key) => (groups.get(key)?.length ?? 0) > 0,
  );

  // Widest region decides the shared region cell so the grid stays aligned.
  // Single column while each region holds few cards: three narrow regions
  // fit 1100px at 1:1 so the whole overview stays visible without shrinking.
  const maxNodes = activeKeys.reduce(
    (max, key) => Math.max(max, groups.get(key)?.length ?? 0),
    0,
  );
  const innerCols = maxNodes <= 4 ? 1 : 2;
  const innerRows = Math.max(1, Math.ceil(maxNodes / innerCols));
  const regionWidth =
    MAP_CLUSTER_PAD_X * 2 + innerCols * nodeWidth + (innerCols - 1) * MAP_NODE_GAP_X;
  const regionHeight =
    MAP_HEADER_HEIGHT +
    MAP_CLUSTER_PAD_Y +
    innerRows * nodeHeight +
    (innerRows - 1) * MAP_NODE_GAP_Y;

  const clusters: PositionedCluster[] = [];
  const nodes: PositionedMemoryNode[] = [];
  const byId = new Map<string, PositionedMemoryNode>();

  activeKeys.forEach((key, index) => {
    const items = groups.get(key) ?? [];
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = MAP_MARGIN + col * (regionWidth + MAP_CLUSTER_GAP_X);
    const y = MAP_MARGIN + row * (regionHeight + MAP_CLUSTER_GAP_Y);

    clusters.push({
      info: MAP_CLUSTER_INFO[key],
      count: items.length,
      x,
      y,
      width: regionWidth,
      height: regionHeight,
    });

    items.forEach((memory, i) => {
      const ic = i % innerCols;
      const ir = Math.floor(i / innerCols);
      const nx = x + MAP_CLUSTER_PAD_X + ic * (nodeWidth + MAP_NODE_GAP_X);
      const ny = y + MAP_HEADER_HEIGHT + ir * (nodeHeight + MAP_NODE_GAP_Y);
      const placed: PositionedMemoryNode = {
        memory,
        cluster: key,
        x: nx,
        y: ny,
        width: nodeWidth,
        height: nodeHeight,
        cx: nx + nodeWidth / 2,
        cy: ny + nodeHeight / 2,
      };
      nodes.push(placed);
      byId.set(memory.id, placed);
    });
  });

  const gridCols = Math.min(columns, Math.max(1, activeKeys.length));
  const gridRows = Math.max(1, Math.ceil(activeKeys.length / columns));
  const width =
    activeKeys.length === 0
      ? MAP_MARGIN * 2 + regionWidth
      : MAP_MARGIN * 2 +
        gridCols * regionWidth +
        (gridCols - 1) * MAP_CLUSTER_GAP_X;
  const height =
    activeKeys.length === 0
      ? MAP_MARGIN * 2 + regionHeight
      : MAP_MARGIN * 2 +
        gridRows * regionHeight +
        (gridRows - 1) * MAP_CLUSTER_GAP_Y;

  return { nodes, clusters, width, height, byId };
}

/* -------------------------------------------------------------------------- */
/* Visibility helpers: explicit counts, never silent omissions.                */
/* -------------------------------------------------------------------------- */

export interface VisibleSlice {
  visible: AgentMemoryNode[];
  hiddenCount: number;
  total: number;
}

/**
 * Balanced initial slice: round-robin across fixed category order so every
 * non-empty category is represented, with an explicit hidden remainder per
 * category. Stable and input-order preserving within each category.
 */
export function balanceMemories(
  memories: AgentMemoryNode[],
  limit: number,
): VisibleSlice {
  const safe = Math.max(0, Math.floor(limit));
  const groups = new Map<MapClusterKey, AgentMemoryNode[]>();
  for (const key of MAP_CLUSTER_ORDER) groups.set(key, []);
  for (const memory of memories) {
    groups.get(normalizeMapCategory(memory.category))?.push(memory);
  }
  const active = MAP_CLUSTER_ORDER.filter(
    (key) => (groups.get(key)?.length ?? 0) > 0,
  );
  const visible: AgentMemoryNode[] = [];
  const cursors = new Map<MapClusterKey, number>(active.map((k) => [k, 0]));
  while (visible.length < safe) {
    let added = false;
    for (const key of active) {
      if (visible.length >= safe) break;
      const items = groups.get(key) ?? [];
      const cursor = cursors.get(key) ?? 0;
      if (cursor < items.length) {
        visible.push(items[cursor]);
        cursors.set(key, cursor + 1);
        added = true;
      }
    }
    if (!added) break;
  }
  return {
    visible,
    hiddenCount: Math.max(0, memories.length - visible.length),
    total: memories.length,
  };
}

/** Hidden remainder per cluster key, for honest collapsed counts. */
export function hiddenByCluster(
  memories: AgentMemoryNode[],
  visibleIds: Set<string>,
): Record<MapClusterKey, number> {
  const hidden = {} as Record<MapClusterKey, number>;
  for (const key of MAP_CLUSTER_ORDER) hidden[key] = 0;
  for (const memory of memories) {
    if (!visibleIds.has(memory.id)) {
      hidden[normalizeMapCategory(memory.category)] += 1;
    }
  }
  return hidden;
}

/** First `limit` memories, with an explicit hidden remainder. */
export function limitMemories(
  memories: AgentMemoryNode[],
  limit: number,
): VisibleSlice {
  const safe = Math.max(0, Math.floor(limit));
  return {
    visible: memories.slice(0, safe),
    hiddenCount: Math.max(0, memories.length - safe),
    total: memories.length,
  };
}

/** Undirected adjacency from the supplied edges only. Nothing is invented. */
export function buildAdjacency(
  edges: AgentMemoryEdge[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!map.has(edge.source)) map.set(edge.source, new Set());
    if (!map.has(edge.target)) map.set(edge.target, new Set());
    map.get(edge.source)?.add(edge.target);
    map.get(edge.target)?.add(edge.source);
  }
  return map;
}

/** Direct neighbor ids of one memory, from the supplied edges only. */
export function directNeighborIds(
  edges: AgentMemoryEdge[],
  selectedId: string,
): string[] {
  const neighbors = buildAdjacency(edges).get(selectedId);
  return neighbors ? [...neighbors] : [];
}

export interface FocusSubset {
  /** Selected memory plus its actual neighbors, in input order. */
  visible: AgentMemoryNode[];
  neighborIds: string[];
  /** Selected id when it exists in the input, else null. */
  selectedFound: boolean;
}

/** Focus set for one selection: the memory itself plus real neighbors. */
export function focusSubset(
  memories: AgentMemoryNode[],
  edges: AgentMemoryEdge[],
  selectedId: string,
): FocusSubset {
  const neighbors = new Set(directNeighborIds(edges, selectedId));
  const selected = memories.find((m) => m.id === selectedId) ?? null;
  const neighborMemories = memories.filter(
    (m) => m.id !== selectedId && neighbors.has(m.id),
  );
  return {
    visible: selected ? [selected, ...neighborMemories] : neighborMemories,
    neighborIds: [...neighbors].filter((id) =>
      memories.some((m) => m.id === id),
    ),
    selectedFound: selected !== null,
  };
}

/**
 * Keep only edges whose endpoints are both on screen. Supplied edges are
 * never redrawn to invented endpoints.
 */
export function edgesBetweenVisible(
  edges: AgentMemoryEdge[],
  visibleIds: Set<string>,
): AgentMemoryEdge[] {
  return edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
}

export interface EdgeKindCounts {
  explicit: number;
  tag: number;
  category: number;
  other: number;
  total: number;
}

/**
 * Honest counts for the legend, grouped by supplied kind. The native
 * backend may provide kind "category" edges: those are counted as
 * category, never folded into tag.
 */
export function countEdgesByKind(edges: AgentMemoryEdge[]): EdgeKindCounts {
  let explicit = 0;
  let tag = 0;
  let category = 0;
  let other = 0;
  for (const edge of edges) {
    if (edge.kind === "explicit") explicit += 1;
    else if (edge.kind === "tag") tag += 1;
    else if (edge.kind === "category") category += 1;
    else other += 1;
  }
  return { explicit, tag, category, other, total: edges.length };
}

/* -------------------------------------------------------------------------- */
/* Text helpers for the content-preview cards.                                 */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace and cut to a readable preview length. */
export function previewText(content: string, maxChars = 110): string {
  const single = content.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return `${single.slice(0, maxChars - 1).trimEnd()}...`;
}

/**
 * Greedy word-wrap for SVG <text> lines. Pure and deterministic so cards
 * render the same preview on every render.
 */
export function previewLines(
  content: string,
  charsPerLine = 32,
  maxLines = 3,
): string[] {
  const words = content.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index];
    const piece =
      word.length > charsPerLine
        ? word.slice(0, charsPerLine - 1) + "-"
        : word;
    const next = current ? `${current} ${piece}` : piece;
    if (next.length <= charsPerLine) {
      current = next;
      index += 1;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
      // If this was the last allowed line, truncate the remainder honestly.
      if (lines.length === maxLines - 1) {
        const rest = words.slice(index).join(" ");
        if (rest.length <= charsPerLine) {
          lines.push(rest);
        } else {
          const tail = rest.slice(0, charsPerLine - 3).trimEnd();
          lines.push(`${tail}...`);
        }
        return lines.slice(0, maxLines);
      }
      continue;
    }
    // Single oversized word on an empty line.
    lines.push(piece);
    index += 1;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}
