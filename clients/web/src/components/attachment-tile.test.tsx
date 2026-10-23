import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentTile, formatAttachmentSize, pastedFiles } from "./attachment-tile";
import type { UploadedFile } from "@/app/store";

const noop = () => {};

function file(overrides: Partial<UploadedFile> = {}): UploadedFile {
  return {
    id: "f1",
    url: "https://example.com/report.pdf",
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 2048,
    ...overrides,
  };
}

describe("pastedFiles", () => {
  const png = () => new File(["img"], "photo.png", { type: "image/png" });
  const itemOf = (file: File) => ({ kind: "file" as const, getAsFile: () => file });
  const textItem = { kind: "string" as const, getAsFile: () => null };

  it("returns an empty array for plain-text pastes", () => {
    // Long pasted text: no files, only a string item.
    expect(pastedFiles({ files: [], items: [textItem] })).toEqual([]);
  });

  it("returns an empty array for null or empty clipboard data", () => {
    expect(pastedFiles(null)).toEqual([]);
    expect(pastedFiles(undefined)).toEqual([]);
    expect(pastedFiles({ files: [], items: [] })).toEqual([]);
  });

  it("routes pasted image files to the tray", () => {
    const out = pastedFiles({ files: [], items: [textItem, itemOf(png())] });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("photo.png");
  });

  it("prefers the files list when the browser populates it", () => {
    const out = pastedFiles({ files: [png()], items: [] });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("photo.png");
  });

  it("skips zero-byte entries", () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    const out = pastedFiles({ files: [], items: [itemOf(empty), itemOf(png())] });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("photo.png");
  });
});

describe("formatAttachmentSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2.0 KB");
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("AttachmentTile", () => {
  it("renders a document tile with name, size and remove control", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentTile, {
        file: file(),
        onRemove: noop,
        onSummarize: noop,
        canSummarize: true,
      }),
    );
    expect(html).toContain("report.pdf");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("PDF");
    expect(html).toContain('data-testid="attachment-remove-f1"');
    expect(html).toContain("Remove attachment report.pdf");
  });

  it("renders an image thumbnail with the name as alt text", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentTile, {
        file: file({
          name: "photo.png",
          mimeType: "image/png",
          previewUrl: "blob:preview",
        }),
        onRemove: noop,
      }),
    );
    expect(html).toContain('alt="photo.png"');
    expect(html).toContain("blob:preview");
  });

  it("shows upload progress and keeps a cancel control while uploading", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentTile, {
        file: file({ isUploading: true, progress: 42 }),
        onRemove: noop,
      }),
    );
    expect(html).toContain("Uploading 42%");
    expect(html).toContain("width:42%");
    expect(html).toContain('data-testid="attachment-remove-f1"');
  });

  it("hides the summarize action when the type is not summarizable", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentTile, {
        file: file(),
        onRemove: noop,
      }),
    );
    expect(html).not.toContain("Summarize report.pdf");
  });

  it("renders a PDF page thumbnail in the badge slot when available", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentTile, {
        file: file({ previewUrl: "data:image/png;base64,page1" }),
        onRemove: noop,
      }),
    );
    expect(html).toContain('alt="report.pdf"');
    expect(html).toContain("data:image/png;base64,page1");
    expect(html).not.toContain(">PDF<");
  });

  it("keys the remove control to the file id", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentTile, {
        file: file({ id: "abc" }),
        onRemove: () => {},
        onSummarize: () => {},
        canSummarize: true,
      }),
    );
    expect(html).toContain('data-testid="attachment-remove-abc"');
  });
});
