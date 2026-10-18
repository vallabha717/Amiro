import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(
  path.join(import.meta.dirname, "agent-workspace-view.tsx"),
  "utf8",
);

const backendAgentSource = readFileSync(
  path.join(import.meta.dirname, "../../../backend/src/agent.rs"),
  "utf8",
);

describe("agent workspace polished navigation and preview", () => {
  it("uses a short header like Providers / Usage", () => {
    expect(workspaceSource).toContain("Agent Workspace");
    expect(workspaceSource).toContain("text-2xl font-bold tracking-tight");
    expect(workspaceSource).toContain(
      "Browse your agent files. Memory lives in its own view.",
    );
    expect(workspaceSource).toContain("Back to Agent");
    expect(workspaceSource).toContain("Read-only preview");
  });

  it("removes duplicate quick jumps", () => {
    expect(workspaceSource).not.toContain("QUICK_JUMP_FILES");
    expect(workspaceSource).not.toContain("Quick jump");
    expect(workspaceSource).not.toContain("Jump to file");
    expect(workspaceSource).not.toContain("prompt-overlay.md");
  });

  it("hides technical root and file metadata behind disclosure", () => {
    expect(workspaceSource).toContain('data-testid="workspace-root-details"');
    expect(workspaceSource).toContain('data-testid="workspace-file-details"');
    expect(workspaceSource).toContain("<details");
    expect(workspaceSource).toContain("Root details");
    expect(workspaceSource).toContain("File details");
  });

  it("preserves root, directory, search, preview, and formatted/source/copy affordances", () => {
    expect(workspaceSource).toContain('data-testid="workspace-root-tabs"');
    expect(workspaceSource).toContain('data-testid="workspace-search-input"');
    expect(workspaceSource).toContain('data-testid="workspace-entry"');
    expect(workspaceSource).toContain('aria-label="Workspace breadcrumbs"');
    expect(workspaceSource).toContain('aria-label="Go to root directory"');
    expect(workspaceSource).toContain('data-testid="workspace-view-mode"');
    expect(workspaceSource).toContain("Formatted");
    expect(workspaceSource).toContain("Source");
    expect(workspaceSource).toContain("Copy");
    expect(workspaceSource).toContain("Select a file to preview");
  });

  it("preserves permission and error states", () => {
    expect(workspaceSource).toContain("Administrator Required");
    expect(workspaceSource).toContain("Authentication Required");
    expect(workspaceSource).toContain("Access Restricted");
    expect(workspaceSource).toContain("Could not open file");
    expect(workspaceSource).toContain("Clear selection");
    expect(workspaceSource).toContain("Failed to load workspace");
    expect(workspaceSource).toContain('data-testid="workspace-save-button"');
    expect(workspaceSource).toContain('data-testid="workspace-edit-button"');
  });

  it("never shows edit/save when read-only and surfaces the 501 read-only save error", () => {
    expect(workspaceSource).toContain("readOnly");
    expect(workspaceSource).toContain("file.writable");
    expect(workspaceSource).toContain("canEdit");
    expect(workspaceSource).toContain("{canEdit ?");
    expect(workspaceSource).not.toContain("{file.writable ?");
    expect(workspaceSource).toContain("501");
    expect(workspaceSource).toContain("Workspace is read-only");
  });

  it("matches the real native backend: files are read-only and PUT returns 501", () => {
    expect(backendAgentSource).toContain("fn is_writable_workspace_rel");
    expect(backendAgentSource).toContain("false");
    expect(backendAgentSource).toContain("readOnly");
    expect(backendAgentSource).toContain("NOT_IMPLEMENTED");
    expect(backendAgentSource).toContain("Workspace is read-only");
  });

  it("stays accessible and mobile friendly", () => {
    expect(workspaceSource).toContain("focus-visible:ring-2");
    expect(workspaceSource).toContain('aria-label="Workspace roots"');
    expect(workspaceSource).toContain('aria-label="Filter files and folders"');
    expect(workspaceSource).toContain('aria-label="View mode"');
    expect(workspaceSource).toContain("lg:hidden");
    expect(workspaceSource).toContain("lg:grid-cols-[320px_1fr]");
  });
});
