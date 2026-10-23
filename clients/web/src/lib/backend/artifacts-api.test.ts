import { describe, expect, it } from "vitest";
import {
  formatSize,
  isFramedPreviewable,
  isTextPreviewable,
  kindLabel,
} from "./artifacts-api";

describe("file artifact helpers", () => {
  it("labels every backend kind", () => {
    expect(kindLabel("markdown")).toBe("Markdown");
    expect(kindLabel("pdf")).toBe("PDF");
    expect(kindLabel("docx")).toBe("Word");
    expect(kindLabel("code")).toBe("Code");
    expect(kindLabel("mystery")).toBe("Text");
  });

  it("text-previewables render inline, binaries do not", () => {
    expect(
      isTextPreviewable({ kind: "markdown", mime: "text/markdown" }),
    ).toBe(true);
    expect(isTextPreviewable({ kind: "code", mime: "text/plain" })).toBe(
      true,
    );
    expect(isTextPreviewable({ kind: "csv", mime: "text/csv" })).toBe(true);
    expect(
      isTextPreviewable({
        kind: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(false);
    expect(isTextPreviewable({ kind: "pdf", mime: "application/pdf" })).toBe(
      false,
    );
  });

  it("pdf, html and svg preview in a sandboxed frame", () => {
    expect(isFramedPreviewable({ kind: "pdf", mime: "application/pdf" })).toBe(
      true,
    );
    expect(isFramedPreviewable({ kind: "html", mime: "text/html" })).toBe(
      true,
    );
    expect(isFramedPreviewable({ kind: "docx", mime: "x" })).toBe(false);
    expect(isFramedPreviewable({ kind: "markdown", mime: "text/markdown" })).toBe(
      false,
    );
  });

  it("formats byte sizes for the list", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
