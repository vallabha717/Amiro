import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(
  path.join(
    import.meta.dirname,
    "../workspace-browser/workspace-browser.tsx",
  ),
  "utf8",
);
const memorySource = readFileSync(
  path.join(import.meta.dirname, "agent-memory-view.tsx"),
  "utf8",
);
const adapterAgentSource = readFileSync(
  path.join(import.meta.dirname, "../../../../../adapter/src/routes/agent.mjs"),
  "utf8",
);
const backendAgentSource = readFileSync(
  path.join(import.meta.dirname, "../../../../../backend/src/agent.rs"),
  "utf8",
);

describe("workspace and memory separation", () => {
  it("workspace is files only: no memory card, no memory quick-jump", () => {
    expect(workspaceSource).not.toContain("MemorySummaryCard");
    expect(workspaceSource).not.toContain("Memory snapshot");
    expect(workspaceSource).not.toContain('"memory/global.json"');
    expect(workspaceSource).not.toContain("/api/agent/memory");
  });

  it("memory defaults to a readable map, with cards available on demand", () => {
    expect(memorySource).toContain('useState<ViewMode>("map")');
    expect(memorySource).toContain('id: "cards"');
    expect(memorySource).toContain('label: "Map"');
    expect(memorySource).toContain("LIST_PAGE_SIZE = 24");
    expect(memorySource).toContain('data-testid="memory-list"');
    expect(memorySource).toContain('data-testid="memory-load-more"');
    expect(memorySource).toContain("/api/agent/memory");
  });

  it("workspace roots are files-only in both backends, no memory/skills mixing", () => {
    expect(adapterAgentSource).not.toContain("Memory & Skills");
    expect(adapterAgentSource).toContain("label: 'Runtime'");
    expect(backendAgentSource).not.toContain("Memory & Skills");
    expect(backendAgentSource).toContain('label: "Runtime"');
  });

  it("memory delegates its map to a mounted React component, without a canvas draw loop", () => {
    expect(memorySource).toContain("<MemoryMap");
    expect(memorySource).not.toContain('getContext("2d")');
  });

  it("memory is titled Memory, not a palace or skills view", () => {
    expect(memorySource).toContain("What Amiro remembers");
    expect(memorySource).not.toContain("Memory Palace");
  });
});
