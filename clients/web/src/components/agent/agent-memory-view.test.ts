import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIST_PAGE_SIZE,
  matchesSearch,
  normalizeCategory,
  paginateMemories,
  withinRecency,
  type AgentMemoryNode,
} from "./agent-memory-view";

/**
 * Memory opens as a labeled, interactive map. Cards remain a paginated
 * alternative, and technical detail stays opt-in. These guards preserve the
 * read-only contract, shared filters, and keyboard detail workflow while pure
 * layout tests cover graph geometry and bounded exploration separately.
 *
 * There is no DOM test environment in this repo (see agent-truthfulness.test.ts),
 * so structure is asserted against the source and behaviour against the
 * exported pure helpers.
 */

const memorySource = readFileSync(
  path.join(import.meta.dirname, "agent-memory-view.tsx"),
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

describe("AgentMemoryView default is the readable map", () => {
  it("opens in map with cards as an alternative on every screen size", () => {
    expect(memorySource).toContain('useState<ViewMode>("map")');
    expect(memorySource).toContain("<MemoryMap");
    expect(memorySource).not.toContain("hidden items-center gap-0.5");
    expect(memorySource).toContain('{ id: "cards", label: "Cards"');
    expect(memorySource).toContain('{ id: "map", label: "Map"');
    // One clear primary view, not a cramped permanent split.
    expect(memorySource).not.toContain('useState<ViewMode>("split")');
  });

  it("retains map selection when closing the inspector so neighborhood focus is usable", () => {
    expect(memorySource).toContain("selectedId={mapSelectionId}");
    expect(memorySource).toContain("setMapSelectionId(id)");
    expect(memorySource).toContain("onSelect={handleSelect}");
    expect(memorySource).toContain("onClose={() => setSelectedId(null)}");
  });

  it("cards use a responsive grid with readable text, scope, tags and connections", () => {
    expect(memorySource).toContain(
      "grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3",
    );
    expect(memorySource).toContain("line-clamp-5");
    expect(memorySource).toContain("connectionCounts={connectionCounts}");
    expect(memorySource).toContain("memory.tags.slice(0, 3)");
    expect(memorySource).toContain("{scopeLabel}");
  });

  it("keeps 'What Amiro remembers' and the memory endpoint", () => {
    expect(memorySource).toContain("What Amiro remembers");
    expect(memorySource).toContain("/api/agent/memory");
  });

  it("no longer renders duplicated stat or category chip rows", () => {
    expect(memorySource).not.toContain("StatPill");
    expect(memorySource).not.toContain("categoryPills");
  });

  it("renders a single list with load-more pagination", () => {
    expect(memorySource).toContain('data-testid="memory-list"');
    expect(memorySource).toContain('data-testid="memory-card"');
    expect(memorySource).toContain('data-testid="memory-load-more"');
    expect(memorySource).toContain("paginateMemories");
  });

  it("moves technical numbers behind an opt-in technical details section", () => {
    expect(memorySource).toContain('data-testid="memory-technical-details"');
    expect(memorySource).toContain("Technical details");
    // The primary detail view still shows the content itself.
    expect(memorySource).toContain("{memory.content}");
  });

  it("keeps writable mutations confirmation-only and hidden when read-only", () => {
    expect(memorySource).toContain(
      "const isReadOnly = data?.readOnly !== false;",
    );
    expect(memorySource).toContain("{!isReadOnly && (");
    expect(memorySource).toContain("Forget this memory?");
    expect(memorySource).toContain('data-testid="memory-reinforce-button"');
  });

  it("keeps honest error states and delegates to a labeled map without an idle canvas loop", () => {
    expect(memorySource).toContain("Administrator Access Required");
    expect(memorySource).toContain("<MemoryMap");
    expect(memorySource).not.toContain('getContext("2d")');
  });
});

describe("AgentMemoryView keyboard and motion accessibility", () => {
  it("uses plain toggle buttons, not tabs without roving keys", () => {
    expect(memorySource).toContain('role="group"');
    expect(memorySource).toContain("aria-pressed={value === option.id}");
    expect(memorySource).not.toContain('role="tablist"');
    expect(memorySource).not.toContain('role="tab"');
  });

  it("moves focus into the detail panel and restores it on close", () => {
    expect(memorySource).toContain("previouslyFocusedRef");
    expect(memorySource).toContain("drawerRef.current?.focus()");
    expect(memorySource).toContain("tabIndex={-1}");
  });

  it("honours reduced motion for the detail panel", () => {
    expect(memorySource).toContain("useReducedMotion");
    expect(memorySource).toContain("reduceMotion ? { opacity: 0 }");
  });
});

describe("paginateMemories", () => {
  const items = Array.from({ length: 158 }, (_, i) => i);

  it("shows only the first page by default", () => {
    const page = paginateMemories(items, LIST_PAGE_SIZE);
    expect(page).toHaveLength(LIST_PAGE_SIZE);
    expect(page[0]).toBe(0);
    expect(page.at(-1)).toBe(LIST_PAGE_SIZE - 1);
  });

  it("grows the page when asked for more", () => {
    expect(paginateMemories(items, LIST_PAGE_SIZE * 2)).toHaveLength(
      LIST_PAGE_SIZE * 2,
    );
  });

  it("clamps to the available memories and never throws on odd input", () => {
    expect(paginateMemories(items, 10_000)).toHaveLength(items.length);
    expect(paginateMemories(items, 0)).toHaveLength(0);
    expect(paginateMemories(items, -5)).toHaveLength(0);
    expect(paginateMemories(items, Number.NaN)).toHaveLength(items.length);
  });
});

describe("normalizeCategory", () => {
  it("keeps known categories and folds everything else into other", () => {
    expect(normalizeCategory("fact")).toBe("fact");
    expect(normalizeCategory("correction")).toBe("correction");
    expect(normalizeCategory("entity")).toBe("entity");
    expect(normalizeCategory("mystery")).toBe("other");
    expect(normalizeCategory("")).toBe("other");
  });
});

describe("matchesSearch", () => {
  it("matches content, tags, category, and scope label case-insensitively", () => {
    const m = memory();
    expect(matchesSearch(m, "sidecar")).toBe(true);
    expect(matchesSearch(m, "DEPLOY")).toBe(true);
    expect(matchesSearch(m, "fact")).toBe(true);
    expect(matchesSearch(m, "global")).toBe(true);
    expect(matchesSearch(m, "missing")).toBe(false);
  });

  it("treats an empty query as a match", () => {
    expect(matchesSearch(memory(), "")).toBe(true);
  });
});

describe("withinRecency", () => {
  it("always includes memories for the all lens", () => {
    expect(
      withinRecency(memory({ updatedAt: "2000-01-01T00:00:00Z" }), "all"),
    ).toBe(true);
  });

  it("excludes stale memories for the recent lenses", () => {
    const old = memory({ updatedAt: "2000-01-01T00:00:00Z" });
    expect(withinRecency(old, "24h")).toBe(false);
    expect(withinRecency(old, "7d")).toBe(false);
  });

  it("includes freshly updated memories", () => {
    const fresh = memory({ updatedAt: new Date().toISOString() });
    expect(withinRecency(fresh, "24h")).toBe(true);
    expect(withinRecency(fresh, "7d")).toBe(true);
  });
});
