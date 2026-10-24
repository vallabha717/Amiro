import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import {
  FileMessagePart,
  ReasoningPart,
  ToolMessagePart,
} from "./message-parts";

describe("ReasoningPart", () => {
  it("streams inside a bounded window with light text, no left border line, and unboxed Thinking shimmer", () => {
    const html = renderToStaticMarkup(
      createElement(ReasoningPart, {
        reasoningText: "Step 1: analyze the prompt.\nStep 2: plan the answer.",
        isThinking: true,
      }),
    );
    expect(html).toContain('data-testid="reasoning-part"');
    expect(html).toContain('data-thinking="true"');
    expect(html).toContain('data-testid="message-reasoning-toggle"');
    expect(html).toContain(">Thinking<");
    // Must not highlight Thinking in a box
    expect(html).not.toContain("bg-muted/30");
    expect(html).not.toContain("rounded-lg border");
    // Streamed thinking body is open while thinking, bounded in height, light colored, with no left border line
    expect(html).toContain('data-testid="message-reasoning-scroll"');
    expect(html).toContain("max-h-36");
    expect(html).toContain("text-zinc-400");
    expect(html).not.toContain("border-l");
    expect(html).toContain("Step 1: analyze the prompt.");
  });

  it("auto-minimizes once thinking is over, showing unboxed normal text Thinking on top", () => {
    const html = renderToStaticMarkup(
      createElement(ReasoningPart, {
        reasoningText: "Finished reasoning text that should be collapsed.",
        isThinking: false,
      }),
    );
    expect(html).toContain('data-testid="reasoning-part"');
    expect(html).toContain('data-thinking="false"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Thinking<");
    expect(html).not.toContain("bg-muted/30");
    expect(html).not.toContain("border-l");
    // Minimized: body is not rendered until clicked
    expect(html).not.toContain("Finished reasoning text that should be collapsed.");
  });
});

describe("ToolMessagePart inline collapsible description", () => {
  it("shows only the tool call description by default and hides details until clicked", () => {
    const html = renderToStaticMarkup(
      createElement(ToolMessagePart, {
        messageId: "msg-1",
        showActions: false,
        part: {
          type: "tool-bash",
          toolCallId: "call-bash-1",
          state: "output-available",
          input: {
            command: "git status --short",
            intent: "Check repository status",
          },
          output: {
            command: "git status --short",
            exit_code: 0,
            output: "M src/components/message-parts.tsx",
          },
        } as never,
      }),
    );
    expect(html).toContain('data-testid="tool-call-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Check repository status");
    // Full terminal output is hidden until the description is clicked
    expect(html).not.toContain('data-testid="tool-call-details"');
    expect(html).not.toContain("M src/components/message-parts.tsx");
  });

  it("shows file edit description inline by default without expanding the diff until clicked", () => {
    const html = renderToStaticMarkup(
      createElement(ToolMessagePart, {
        messageId: "msg-2",
        showActions: false,
        part: {
          type: "tool-edit",
          toolCallId: "call-edit-1",
          state: "output-available",
          input: {
            file_path: "src/app.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
            intent: "Update constant value",
          },
          output: "Edited src/app.ts",
        } as never,
      }),
    );
    expect(html).toContain('data-testid="tool-call-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Update constant value");
    expect(html).not.toContain('data-testid="tool-call-details"');
    expect(html).not.toContain("const a = 2;");
  });
});

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
