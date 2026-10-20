import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { extractArtifact, withArtifactMcpCard } from "./artifact-presenters";
import type { ToolPresenter } from "./types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === "noPreview" && vars) return `${vars.filename} (${vars.size})`;
    if (key === "fileUpdated") return "revised";
    return key;
  },
}));

const record = {
  id: "abc-123",
  title: "Q3 report",
  filename: "q3.md",
  kind: "markdown",
  mime: "text/markdown",
  size: 42,
};

describe("extractArtifact", () => {
  it("reads the record straight off output.artifact", () => {
    expect(extractArtifact({}, { artifact: record })?.id).toBe("abc-123");
  });

  it("reads nested data/result envelopes", () => {
    expect(extractArtifact({}, { data: { artifact: record } })?.title).toBe("Q3 report");
    expect(extractArtifact({}, { result: { artifact: record } })?.filename).toBe("q3.md");
  });

  it("parses the fenced json block the bridge appends to text", () => {
    const output = {
      content: [
        { type: "text", text: `Created artifact.\n\n\`\`\`json\n${JSON.stringify({ artifact: record })}\n\`\`\`` },
      ],
    };
    expect(extractArtifact({}, output)?.id).toBe("abc-123");
  });

  it("falls back to the input title/filename when the result is opaque", () => {
    const ref = extractArtifact({ title: "Draft", filename: "draft.md" }, "ok");
    expect(ref?.title).toBe("Draft");
    expect(ref?.id).toBeUndefined();
  });

  it("returns undefined when there is nothing to show", () => {
    expect(extractArtifact({}, null)).toBeUndefined();
    expect(extractArtifact({}, "ok")).toBeUndefined();
  });
});

describe("withArtifactMcpCard", () => {
  const base: ToolPresenter = {
    glance: () => "base card",
    Compact: () => createElement("div", { "data-testid": "base-compact" }),
    Expanded: () => createElement("div", { "data-testid": "base-expanded" }),
  };
  const wrapped = withArtifactMcpCard(base);
  const created = {
    input: {
      server: "amiro",
      tool: "artifact_create",
      arguments: { title: "Q3 report", filename: "q3.md" },
    },
    output: { artifact: { id: "abc-123", title: "Q3 report", filename: "q3.md" } },
    status: "success" as const,
  };

  it("names the saved artifact in the work log row", () => {
    expect(wrapped.glance(created)).toBe("artifact · Q3 report");
  });

  it("renders the Open button deep-linking to the Files tab", () => {
    const html = renderToStaticMarkup(
      createElement(wrapped.Expanded!, created),
    );
    expect(html).toContain('data-testid="artifact-open-abc-123"');
    expect(html).toContain("Q3 report");
  });

  it("leaves every other MCP call on the base card", () => {
    const other = {
      input: { server: "amiro", tool: "schedule_list" },
      output: {},
      status: "success" as const,
    };
    expect(wrapped.glance(other)).toBe("base card");
    expect(
      renderToStaticMarkup(createElement(wrapped.Expanded!, other)),
    ).toContain('data-testid="base-expanded"');
    const foreign = {
      input: { server: "gmail", tool: "send" },
      output: {},
      status: "success" as const,
    };
    expect(wrapped.glance(foreign)).toBe("base card");
  });
});
