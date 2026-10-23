import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  fileKind,
  formatBytes,
  hasHiddenSegment,
  joinPath,
  parentPath,
  validateName,
} from "./workspace-api";

const read = (f: string) =>
  readFileSync(path.join(import.meta.dirname, f), "utf8");

describe("workspace-api helpers", () => {
  it("handles paths", () => {
    expect(parentPath("a/b/c.md")).toBe("a/b");
    expect(parentPath("c.md")).toBe("");
    expect(joinPath("", "x")).toBe("x");
    expect(joinPath("a", "x")).toBe("a/x");
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.md")).toEqual([]);
    expect(hasHiddenSegment("a/.b/c")).toBe(true);
    expect(hasHiddenSegment("a/b")).toBe(false);
  });

  it("classifies files and formats sizes", () => {
    expect(fileKind("a.md")).toBe("markdown");
    expect(fileKind("a.json")).toBe("json");
    expect(fileKind("a.PNG")).toBe("image");
    expect(fileKind("a.rs")).toBe("code");
    expect(fileKind("README")).toBe("other");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("validates names", () => {
    expect(validateName("", true)).not.toBeNull();
    expect(validateName("a/b.md", true)).toBeNull();
    expect(validateName("a/b.md", false)).not.toBeNull();
    expect(validateName("../x", true)).not.toBeNull();
    expect(validateName("/x", true)).not.toBeNull();
    expect(validateName(".env", true)).not.toBeNull();
    expect(validateName("notes.md", false)).toBeNull();
  });
});

describe("workspace browser contract", () => {
  const browser = read("workspace-browser.tsx");
  const tree = read("workspace-tree.tsx");
  const viewer = read("workspace-file-viewer.tsx");
  const api = read("workspace-api.ts");

  it("keeps the agreed test ids and copy", () => {
    expect(browser).toContain('data-testid="workspace-browser"');
    expect(browser).toContain('data-testid="workspace-new-file"');
    expect(tree).toContain('data-testid="workspace-tree"');
    expect(tree).toContain("data-testid={`workspace-row-${entry.path}`}");
    expect(viewer).toContain('data-testid="workspace-viewer"');
    expect(viewer).toContain('data-testid="workspace-edit"');
    expect(viewer).toContain('data-testid="workspace-save"');
    expect(viewer).toContain('data-testid="workspace-download"');
    expect(browser).toContain("Files your agent reads and writes.");
    expect(browser).toContain("Your agent hasn&apos;t saved anything yet");
    expect(viewer).toContain("Nothing open yet");
  });

  it("uses the agent workspace endpoints, not the developer roots", () => {
    for (const ep of ["tree", "file", "file/raw", "write", "mkdir", "rename", "delete", "agent-files"]) {
      expect(api).toContain(`/api/workspace/${ep}`);
    }
    expect(api).not.toContain("/api/agent/workspace");
  });
});

describe("agent-home note lines", () => {
  it("splits `_ ` notes from the body without touching real markdown", async () => {
    const { agentNoteLines, stripAgentNotes } = await import("./workspace-file-viewer");
    const md = '_ Lines starting with "_ " are notes.\n_ Edit freely.\n_\n\n# SOUL.md\n\n_italic_ stays, __init__ too.\n  _ indented note';
    expect(agentNoteLines(md)).toEqual(['Lines starting with "_ " are notes.', "Edit freely.", "indented note"]);
    const body = stripAgentNotes(md);
    expect(body.startsWith("# SOUL.md")).toBe(true);
    expect(body).toContain("_italic_ stays, __init__ too.");
    expect(body).not.toContain("Edit freely");
  });
});
