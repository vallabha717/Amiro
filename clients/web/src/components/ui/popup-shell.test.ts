import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("popup shell layout contract", () => {
  it("fixes the header and footer with only the middle scrolling", () => {
    const shell = read("src/components/ui/popup-shell.tsx");
    const headerAt = shell.indexOf("Fixed header");
    const scrollAt = shell.indexOf("overflow-y-auto");
    const footerAt = shell.indexOf("Fixed footer");
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(scrollAt).toBeGreaterThan(headerAt);
    expect(footerAt).toBeGreaterThan(scrollAt);
    expect(shell).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(shell).toContain("shrink-0");
  });

  it("routes every migrated popup through PopupShell", () => {
    const popups = [
      "src/components/keyboard-shortcuts-popup.tsx",
      "src/components/export/chat-export-popup.tsx",
      "src/components/archive-dialog.tsx",
      "src/components/skill/generate-skill-dialog.tsx",
      "src/components/json-view-popup.tsx",
      "src/components/chat/folder-browser-dialog.tsx",
      "src/components/mcp-customization-popup.tsx",
      "src/components/tool-detail-popup.tsx",
    ];
    for (const file of popups) {
      expect(read(file), file).toContain("PopupShell");
    }
  });

  it("keeps the legacy MCP test route as a redirect to Connectors", () => {
    // /mcp/test used to host a PopupShell page. It is now a redirect, so it is
    // checked for the redirect instead of for the shell.
    const page = read("src/app/(chat)/mcp/test/page.tsx");
    expect(page).toContain("RedirectToConnectors");
    expect(page).not.toContain("PopupShell");
  });

  it("gives migrated dialog bodies a bounded flex column shell", () => {
    const popups = [
      "src/components/keyboard-shortcuts-popup.tsx",
      "src/components/export/chat-export-popup.tsx",
      "src/components/archive-dialog.tsx",
      "src/components/skill/generate-skill-dialog.tsx",
      "src/components/json-view-popup.tsx",
      "src/components/chat/folder-browser-dialog.tsx",
      "src/components/mcp-customization-popup.tsx",
      "src/components/tool-detail-popup.tsx",
    ];
    for (const file of popups) {
      const source = read(file);
      expect(source, file).toContain("max-h-[85vh]");
      expect(source, file).toContain("flex-col overflow-hidden");
    }
  });
});
