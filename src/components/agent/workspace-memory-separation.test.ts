import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(
  path.join(import.meta.dirname, "agent-workspace-view.tsx"),
  "utf8",
);
const memorySource = readFileSync(
  path.join(import.meta.dirname, "agent-memory-view.tsx"),
  "utf8",
);
const adapterAgentSource = readFileSync(
  path.join(
    import.meta.dirname,
    "../../../adapter/src/routes/agent.mjs",
  ),
  "utf8",
);
const backendAgentSource = readFileSync(
  path.join(import.meta.dirname, "../../../backend/src/agent.rs"),
  "utf8",
);

describe("workspace and memory separation", () => {
  it("workspace is files only: no memory card, no memory quick-jump", () => {
    expect(workspaceSource).not.toContain("MemorySummaryCard");
    expect(workspaceSource).not.toContain("Memory snapshot");
    expect(workspaceSource).not.toContain("showMemoryCard");
    expect(workspaceSource).not.toContain('"memory/global.json"');
    expect(workspaceSource).toContain("Memory lives in its own view");
  });

  it("memory defaults to the creative map with inspector, cards one click away", () => {
    expect(memorySource).toContain('useState<ViewMode>("split")');
    expect(memorySource).toContain('id: "cards"');
    expect(memorySource).toContain('label: "Map"');
    expect(memorySource).toContain("/api/agent/memory");
  });

  it("workspace roots are files-only in both backends, no memory/skills mixing", () => {
    expect(adapterAgentSource).not.toContain("Memory & Skills");
    expect(adapterAgentSource).toContain("label: 'Runtime'");
    expect(backendAgentSource).not.toContain("Memory & Skills");
    expect(backendAgentSource).toContain('label: "Runtime"');
  });

  it("memory Map canvas draw loop restarts when the view changes", () => {
    // Regression: a mount-only canvas effect returns early in Cards mode
    // (canvas unmounted), leaving the Map blank after switching to it.
    expect(memorySource).toContain("}, [viewMode, data]);");
    expect(memorySource).toContain('data-testid="memory-constellation-canvas"');
  });

  it("memory is titled Memory, not a palace or skills view", () => {
    expect(memorySource).toContain("What Amiro remembers");
    expect(memorySource).not.toContain("Memory Palace");
  });
});
