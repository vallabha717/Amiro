import type { ConceptNodeKind } from "./types";

export const VIRTUAL_CENTER = { x: 600, y: 450 } as const;

/** Node fill/stroke color per taxonomy kind. Values are the resolved hex of
 * Vellum brand tokens (canvas `fillStyle` can't read CSS `var()`), so nodes
 * read consistently across light/dark; labels use theme tokens. */
export const NODE_KIND_COLORS: Record<ConceptNodeKind, string> = {
  concept: "#467CC8",
  skill: "#DB4B77",
  capability: "#0E9B8B",
  pending: "#F1B21E",
  other: "#8D99A5",
};

/** Categorical fills for concept clusters/themes, indexed by the compact
 * cluster id from `detectClusters`. Ten hues derived from Vellum's brand
 * ramps/accent tokens, ordered so adjacent cluster ids contrast. */
export const CLUSTER_PALETTE: string[] = [
  "#467CC8", // system-info-strong — blue
  "#E86B40", // danger-600 / system-negative-hover — orange
  "#7A5AF5", // violet — fills a brand hue gap; distinct from node-kind colors
  "#22B8CF", // cyan — distinct from capability teal + skill pink
  "#3DB85E", // forest-500 — green
  "#E9C91A", // feed-thread-strong — yellow
  "#E83F5B", // velvet primary-base — brand red
  "#6ECF87", // forest-400 — mint
  "#F39B74", // danger-500 — peach
  "#F5C94E", // amber-500 — gold
];

const NODE_KIND_LABELS: Record<ConceptNodeKind, string> = {
  concept: "Concept",
  skill: "Skill",
  capability: "Capability",
  pending: "Pending",
  other: "Other",
};

export function nodeKindLabel(kind: ConceptNodeKind): string {
  return NODE_KIND_LABELS[kind];
}

export const EDGE_LINK_COLOR = "var(--muted-foreground)";
export const EDGE_LEARNED_COLOR = "#F1B21E";
