/** Node taxonomy the renderer colors by. Unknown backend kinds fall to "other".
 * "pending" marks buffer entries consolidation has not yet filed into concept
 * pages — drawn dash-ringed so "saved but not filed" reads at a glance. */
export type ConceptNodeKind =
  | "concept"
  | "skill"
  | "capability"
  | "pending"
  | "other";

/** Edge taxonomy the renderer styles by. */
export type ConceptEdgeKind = "link" | "learned" | "other";

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  radius: number;
}

/**
 * A force-laid-out graph node in 3D. Satisfies {@link PositionedNode}
 * (id/x/y/radius); `z` is the depth axis the renderer rotates/projects through.
 */
export interface GraphLayoutNode extends PositionedNode {
  /** Depth coordinate (centered at 0); rotated + projected by the renderer. */
  z: number;
  label: string;
  kind: ConceptNodeKind;
  summary?: string;
  /** Number of incident edges — drives node size and hover neighborhoods. */
  degree: number;
  updatedAtMs?: number;
}

export interface GraphLayoutEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: ConceptEdgeKind;
  description?: string;
  directed: boolean;
}

export interface GraphLayout {
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
}

export interface MemoryGraphNodeInput {
  id: string;
  label: string;
  summary?: string;
  kind?: string;
  weight?: number;
  updatedAtMs?: number;
}

export interface MemoryGraphEdgeInput {
  source: string;
  target: string;
  kind?: string;
  weight?: number;
  description?: string;
  directed?: boolean;
}

export interface MemoryGraphInput {
  nodes: MemoryGraphNodeInput[];
  edges: MemoryGraphEdgeInput[];
  truncated?: boolean;
}
