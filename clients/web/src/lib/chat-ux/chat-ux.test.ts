import { describe, expect, it } from "vitest";
import { extractInlineImages, isSafeImageSrc, linkifyDataImages } from "./inline-images";
import { connectorNameOf, toolCategoryOf } from "./tool-categories";
import { diffTodos, isSubstantive, todoDiffSummary, todosFromToolPart } from "./todos";

describe("toolCategoryOf", () => {
  it("buckets runtime and built-in tools", () => {
    expect(toolCategoryOf("bash")).toBe("terminal");
    expect(toolCategoryOf("run_shell")).toBe("terminal");
    expect(toolCategoryOf("git")).toBe("terminal");
    expect(toolCategoryOf("read")).toBe("files");
    expect(toolCategoryOf("edit_file")).toBe("files");
    expect(toolCategoryOf("agentgrep", { mode: "trace" })).toBe("files");
    expect(toolCategoryOf("webfetch")).toBe("web");
    expect(toolCategoryOf("swarm")).toBe("agents");
    expect(toolCategoryOf("todo")).toBe("planning");
    expect(toolCategoryOf("something_new")).toBe("other");
  });

  it("recognizes connectors under every naming scheme", () => {
    expect(toolCategoryOf("gmail")).toBe("connectors");
    expect(toolCategoryOf("calendar")).toBe("connectors");
    expect(toolCategoryOf("mcp__github__create_issue")).toBe("connectors");
    expect(toolCategoryOf("mcp_call")).toBe("connectors");
    expect(toolCategoryOf("GMAIL_SEND_EMAIL")).toBe("connectors");
    expect(connectorNameOf("mcp__github__create_issue")).toBe("github");
    expect(connectorNameOf("GMAIL_SEND_EMAIL")).toBe("gmail");
  });
});

describe("todos", () => {
  const a = todosFromToolPart({
    todos: [
      { id: "1", content: "Plan", status: "in_progress", priority: "high" },
      { id: "2", content: "Build", status: "pending", priority: "high" },
    ],
  }, undefined)!;

  it("treats the first write as substantive", () => {
    const d = diffTodos(undefined, a);
    expect(d.isFirst).toBe(true);
    expect(isSubstantive(d)).toBe(true);
    expect(todoDiffSummary(d)).toBe("2 added");
  });

  it("collapses a single status flip to one line", () => {
    const b = a.map((t) => (t.id === "1" ? { ...t, status: "completed" as const } : t));
    const d = diffTodos(a, b);
    expect(isSubstantive(d)).toBe(false);
    expect(d.changes).toHaveLength(1);
    expect(todoDiffSummary(d)).toBe("1 done");
    expect(d.completed).toBe(1);
  });

  it("maps legacy statuses", () => {
    const list = todosFromToolPart({ todos: [{ content: "x", status: "done" }] }, undefined)!;
    expect(list[0].status).toBe("completed");
  });
});

describe("extractInlineImages", () => {
  it("finds MCP image content and AI SDK media", () => {
    const imgs = extractInlineImages({
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    expect(imgs).toEqual([{ src: "data:image/png;base64,AAAA", alt: undefined }]);
    const media = extractInlineImages({
      type: "content",
      value: [{ type: "media", data: "BBBB", mediaType: "image/jpeg" }],
    });
    expect(media[0].src).toBe("data:image/jpeg;base64,BBBB");
  });

  it("finds image URLs in strings and markdown, deduplicated", () => {
    const imgs = extractInlineImages(
      "Saved ![chart](https://x.test/a.png) and https://x.test/a.png and https://x.test/b.webp?s=1",
    );
    expect(imgs.map((i) => i.src)).toEqual(["https://x.test/a.png", "https://x.test/b.webp?s=1"]);
  });

  it("finds a data URL printed after other output", () => {
    const imgs = extractInlineImages({ output: "total 0\nfile.txt\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUg==\nexit 0" });
    expect(imgs.map((i) => i.src)).toEqual(["data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="]);
  });

  it("ignores non-image media and plain text", () => {
    expect(extractInlineImages({ type: "media", data: "x", mediaType: "application/pdf" })).toEqual([]);
    expect(extractInlineImages("no images here")).toEqual([]);
  });
});

describe("linkifyDataImages", () => {
  const url = `data:image/png;base64,${"iVBORw0KGgo".repeat(6)}AAAA==`;

  it("turns a bare data URL line into an image", () => {
    expect(linkifyDataImages(url)).toBe(`![image](${url})`);
    expect(linkifyDataImages(`Here it is: ${url}`)).toBe(`Here it is: ![image](${url})`);
  });

  it("leaves code fences and existing image syntax alone", () => {
    const fence = "```\n" + url + "\n```";
    expect(linkifyDataImages(fence)).toBe(fence);
    expect(linkifyDataImages(`![chart](${url})`)).toBe(`![chart](${url})`);
  });

  it("only allows raster data URLs and http(s)", () => {
    expect(isSafeImageSrc(url)).toBe(true);
    expect(isSafeImageSrc("https://x.test/a.png")).toBe(true);
    expect(isSafeImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
  });
});
