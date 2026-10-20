import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileMessagePart } from "./message-parts";

describe("FileMessagePart sent card", () => {
  it("renders a document as a compact card with truncated name and download", () => {
    const html = renderToStaticMarkup(
      createElement(FileMessagePart, {
        part: {
          type: "file",
          url: "https://example.com/f/report.pdf",
          filename: "Shrivallabha-resume-v2.pdf",
          mediaType: "application/pdf",
        } as never,
        isUserMessage: true,
      }),
    );
    expect(html).toContain("Shrivallabha-resume-v2.pdf");
    expect(html).toContain("PDF");
    expect(html).toContain("download");
    expect(html).toContain("ml-auto");
  });

  it("renders an image as a thumbnail card aligned to the sender", () => {
    const html = renderToStaticMarkup(
      createElement(FileMessagePart, {
        part: {
          type: "file",
          url: "https://example.com/f/photo.png",
          filename: "photo.png",
          mediaType: "image/png",
        } as never,
        isUserMessage: false,
      }),
    );
    expect(html).toContain('alt="photo.png"');
    expect(html).toContain("mr-auto");
  });
});
