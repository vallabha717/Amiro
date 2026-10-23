import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentMemoryEdge,
  AgentMemoryNode,
} from "./agent-memory-view";
import {
  MAP_CLUSTER_INFO,
  MAP_CLUSTER_ORDER,
  MAP_PAGE_MAX,
  MAP_PAGE_SIZE,
  balanceMemories,
  buildAdjacency,
  clusterInfo,
  countEdgesByKind,
  directNeighborIds,
  edgesBetweenVisible,
  focusSubset,
  hiddenByCluster,
  layoutMemoryMap,
  normalizeMapCategory,
  previewLines,
  previewText,
} from "./memory-map-layout";

/**
 * The MemoryMap atlas is the advanced default lens for agent memory: stable
 * category columns with plural labels, content-preview cards, and only the
 * supplied edges. These guards lock the pure geometry and visibility rules so
 * the map never overlaps, never invents clusters or links, and never hides
 * memories silently. The component shape is asserted against source because
 * this repo has no DOM test environment.
 */

const mapSource = readFileSync(
  path.join(import.meta.dirname, "memory-map.tsx"),
  "utf8",
);

function memory(overrides: Partial<AgentMemoryNode> = {}): AgentMemoryNode {
  return {
    id: "m1",
    content: "Deploys through the Go sidecar on port 8080",
    category: "fact",
    scope: "global",
    scopeLabel: "Global",
    tags: ["deploy"],
    source: "manual",
    trust: "0.8",
    strength: 4,
    confidence: 0.7,
    accessCount: 3,
    reinforcements: 2,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function edge(overrides: Partial<AgentMemoryEdge> = {}): AgentMemoryEdge {
  return {
    id: "e1",
    source: "m1",
    target: "m2",
    kind: "explicit",
    ...overrides,
  };
}

describe("memory map layout is stable and non-overlapping", () => {
  it("places every memory in exactly one node with the same ids", () => {
    const items = [
      memory({ id: "m1", category: "fact" }),
      memory({ id: "m2", category: "preference" }),
      memory({ id: "m3", category: "entity" }),
      memory({ id: "m4", category: "correction" }),
      memory({ id: "m5", category: "mystery" }),
    ];
    const layout = layoutMemoryMap(items);
    expect(layout.nodes).toHaveLength(items.length);
    expect(layout.nodes.map((n) => n.memory.id).sort()).toEqual(
      items.map((m) => m.id).sort(),
    );
    expect(layout.byId.size).toBe(items.length);
    // Unknown categories fold into the honest "other" bucket, never invented.
    expect(layout.byId.get("m5")?.cluster).toBe("other");
    expect(normalizeMapCategory("mystery")).toBe("other");
  });

  it("returns identical positions for identical input order", () => {
    const items = [
      memory({ id: "m1", category: "fact" }),
      memory({ id: "m2", category: "fact" }),
      memory({ id: "m3", category: "entity" }),
    ];
    const first = layoutMemoryMap(items);
    const second = layoutMemoryMap(items);
    expect(second.nodes.map((n) => [n.x, n.y, n.cx, n.cy])).toEqual(
      first.nodes.map((n) => [n.x, n.y, n.cx, n.cy]),
    );
  });

  it("lays regions in a 3-column grid so every category stays visible", () => {
    const items = [
      memory({ id: "m1", category: "fact" }),
      memory({ id: "m2", category: "preference" }),
      memory({ id: "m3", category: "entity" }),
      memory({ id: "m4", category: "correction" }),
      memory({ id: "m5", category: "other" }),
    ];
    const layout = layoutMemoryMap(items);
    expect(layout.clusters).toHaveLength(5);
    const ys = layout.clusters.map((c) => c.y);
    // Two rows: first three regions share a row, last two share the second.
    expect(new Set(ys).size).toBe(2);
    // 1100px desktop fits the full overview at 1:1 (3 narrow regions).
    expect(layout.width).toBeLessThanOrEqual(1100);
  });

  it("never overlaps cards within a region", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      memory({ id: `f${i}`, category: "fact" }),
    );
    const layout = layoutMemoryMap(items);
    const boxes = layout.nodes.map((n) => ({
      x0: n.x,
      y0: n.y,
      x1: n.x + n.width,
      y1: n.y + n.height,
    }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap =
          a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
        expect(overlap).toBe(false);
      }
    }
  });

  it("keeps cluster columns in a fixed order with plural counts", () => {
    const layout = layoutMemoryMap([
      memory({ id: "m1", category: "entity" }),
      memory({ id: "m2", category: "fact" }),
    ]);
    const keys = layout.clusters.map((c) => c.info.key);
    expect(keys.indexOf("fact")).toBeLessThan(keys.indexOf("entity"));
    for (const cluster of layout.clusters) {
      expect(cluster.info.plural.length).toBeGreaterThan(0);
      expect(cluster.count).toBeGreaterThan(0);
    }
    expect(MAP_CLUSTER_ORDER).toContain("other");
    expect(MAP_CLUSTER_INFO.fact.plural).toBe("Facts");
    expect(MAP_CLUSTER_INFO.preference.plural).toBe("Preferences");
    expect(MAP_CLUSTER_INFO.entity.plural).toBe("Entities");
    expect(MAP_CLUSTER_INFO.correction.plural).toBe("Corrections");
    expect(clusterInfo("fact").description.length).toBeGreaterThan(0);
  });

  it("wraps previews deterministically within line limits", () => {
    const lines = previewLines("one two three four five six seven", 10, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
    expect(previewLines("same input", 12, 3)).toEqual(
      previewLines("same input", 12, 3),
    );
    expect(previewText("  a   b  ", 10)).toBe("a b");
  });
});

describe("memory map visibility is explicit, never silent", () => {
  it("bounds the initial page to 20 balanced, with Show more to 60", () => {
    expect(MAP_PAGE_SIZE).toBe(20);
    expect(MAP_PAGE_MAX).toBe(60);
    const items = Array.from({ length: 75 }, (_, i) =>
      memory({ id: `m${i}`, category: i % 2 === 0 ? "fact" : "entity" }),
    );
    const initial = balanceMemories(items, MAP_PAGE_SIZE);
    expect(initial.visible).toHaveLength(20);
    expect(initial.hiddenCount).toBe(55);
    expect(initial.total).toBe(75);
    // Balanced: both categories represented in the first slice.
    const cats = new Set(initial.visible.map((m) => m.category));
    expect(cats.has("fact")).toBe(true);
    expect(cats.has("entity")).toBe(true);
    const expanded = balanceMemories(items, MAP_PAGE_MAX);
    expect(expanded.visible).toHaveLength(60);
    expect(expanded.hiddenCount).toBe(15);
  });

  it("reports honest per-category hidden counts", () => {
    const items = [
      memory({ id: "m1", category: "fact" }),
      memory({ id: "m2", category: "fact" }),
      memory({ id: "m3", category: "entity" }),
    ];
    const hidden = hiddenByCluster(items, new Set(["m1"]));
    expect(hidden.fact).toBe(1);
    expect(hidden.entity).toBe(1);
    expect(hidden.preference).toBe(0);
  });

  it("focuses only the selected memory plus actual neighbors", () => {
    const items = [
      memory({ id: "m1" }),
      memory({ id: "m2" }),
      memory({ id: "m3" }),
    ];
    const edges = [edge({ id: "e1", source: "m1", target: "m2" })];
    const subset = focusSubset(items, edges, "m1");
    expect(subset.selectedFound).toBe(true);
    expect(subset.visible.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(subset.neighborIds).toEqual(["m2"]);
    expect(directNeighborIds(edges, "m3")).toEqual([]);
  });

  it("builds adjacency from supplied edges only", () => {
    const adjacency = buildAdjacency([
      edge({ id: "e1", source: "a", target: "b", kind: "explicit" }),
      edge({ id: "e2", source: "a", target: "c", kind: "tag", label: "deploy" }),
    ]);
    expect([...(adjacency.get("a") ?? [])].sort()).toEqual(["b", "c"]);
    expect([...(adjacency.get("b") ?? [])]).toEqual(["a"]);
    expect(countEdgesByKind([
      edge({ kind: "explicit" }),
      edge({ id: "e2", kind: "tag" }),
      edge({ id: "e3", source: "x", target: "y", kind: "category" }),
    ])).toEqual({ explicit: 1, tag: 1, category: 1, other: 0, total: 3 });
  });

  it("keeps only edges whose endpoints are both visible", () => {
    const edges = [
      edge({ id: "e1", source: "m1", target: "m2" }),
      edge({ id: "e2", source: "m1", target: "m9" }),
    ];
    const kept = edgesBetweenVisible(edges, new Set(["m1", "m2"]));
    expect(kept.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("MemoryMap component contract", () => {
  it("exports the named MemoryMap with the required props", () => {
    expect(mapSource).toContain("export function MemoryMap");
    expect(mapSource).toContain("memories: AgentMemoryNode[]");
    expect(mapSource).toContain("edges: AgentMemoryEdge[]");
    expect(mapSource).toContain("selectedId: string | null");
    expect(mapSource).toContain("onSelect: (id: string) => void");
  });

  it("renders Vellum 2.5D force-directed concept graph behind an accessible list", () => {
    expect(mapSource).toContain("buildForceLayout");
    expect(mapSource).toContain("detectClusters");
    expect(mapSource).toContain('data-testid="memory-map-list-item"');
    expect(mapSource).toContain("title={memory.content}");
  });

  it("draws supplied edges with ConceptGraphLegend and empty state", () => {
    expect(mapSource).toContain("ConceptGraphLegend");
    expect(mapSource).toContain("RecencyLens");
    expect(mapSource).toContain("No memories match");
  });

  it("supports focus, zoom, orbit drag, and accessible browse disclosure", () => {
    expect(mapSource).toContain('data-testid="memory-map"');
    expect(mapSource).toContain('data-testid="memory-map-focus"');
    expect(mapSource).toContain('data-testid="memory-map-load-more"');
    expect(mapSource).toContain('aria-label="Zoom in"');
    expect(mapSource).toContain('aria-label="Zoom out"');
    expect(mapSource).toContain('aria-label="Fit view"');
    expect(mapSource).toContain("No memories match");
    expect(mapSource).toContain("Category group");
    expect(mapSource).toContain('role="region"');
    expect(mapSource).not.toContain('role="application"');
    expect(mapSource).toContain("Browse visible memories");
    expect(mapSource).toContain('data-testid="memory-map-browse"');
  });
});
