import { describe, expect, test } from "vitest";

import type { UploadedFile } from "@/app/store";
import {
  buildAttachmentParts,
  buildAttachmentsSummary,
  canInterject,
  countParkedFiles,
  createPendingFollowUp,
  followUpParts,
  excludeParkedFiles,
  hasUploadInProgress,
  isLoginCommand,
  joinFollowUpTexts,
  mergePendingFollowUps,
  previewQueuedText,
  restoreParkedFiles,
} from "./followup-queue";

const file = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
  id: "file-1",
  url: "https://example.com/a.png",
  name: "a.png",
  mimeType: "image/png",
  size: 10,
  ...overrides,
});

describe("followup-queue", () => {
  test("detects the /login command like the composer does", () => {
    expect(isLoginCommand("  /LOGIN  ")).toBe(true);
    expect(isLoginCommand("/login extra")).toBe(false);
    expect(isLoginCommand("hello")).toBe(false);
  });

  test("creates pending follow-ups with unique ids", () => {
    const first = createPendingFollowUp("queued", "a", [], [], [file()]);
    const second = createPendingFollowUp("interrupt", "b", [], [], []);
    expect(first.kind).toBe("queued");
    expect(second.kind).toBe("interrupt");
    expect(first.id).not.toBe(second.id);
    expect(first.files).toHaveLength(1);
  });

  test("flags uploads still in progress", () => {
    expect(hasUploadInProgress([file({ isUploading: true })])).toBe(true);
    expect(hasUploadInProgress([file()])).toBe(false);
    expect(hasUploadInProgress([])).toBe(false);
  });

  test("builds file parts for supported mimes and source-url otherwise", () => {
    const parts = buildAttachmentParts(
      [file(), file({ id: "file-2", mimeType: "text/csv", name: "b.csv" })],
      ["image/png"],
    );
    // Summary preview first, then one part per file.
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(parts[1]).toMatchObject({ type: "file", filename: "a.png" });
    expect(parts[2]).toMatchObject({ type: "source-url", title: "b.csv" });
  });

  test("skips files without a link", () => {
    expect(buildAttachmentParts([file({ url: "", dataUrl: "" })], [])).toEqual(
      [],
    );
  });

  test("summarizes attachments like the composer", () => {
    expect(buildAttachmentsSummary([file()])).toBe("1. a.png (image/png)");
  });

  test("previews queued text on one short line", () => {
    expect(previewQueuedText("  hello\nworld  ")).toBe("hello world");
    const long = previewQueuedText("x".repeat(100), 10);
    expect(long).toBe(`${"x".repeat(9)}...`);
  });

  test("counts and excludes parked files", () => {
    const current = [file(), file({ id: "file-2", name: "b.png" })];
    expect(countParkedFiles(["file-1", "missing"], current)).toBe(1);
    expect(excludeParkedFiles(current, ["file-1"])).toEqual([current[1]]);
  });

  test("restores only files missing from the tray", () => {
    const parked = [file(), file({ id: "file-2", name: "b.png" })];
    expect(restoreParkedFiles([file()], parked)).toEqual([parked[1]]);
    expect(restoreParkedFiles(parked, parked)).toEqual([]);
  });
});

describe("followUpParts", () => {
  test("a queued follow-up sends what was typed, after its files", () => {
    const file = { type: "file", url: "data:x", mediaType: "image/png" } as const;
    expect(followUpParts({ text: " Now give it a title. ", attachmentParts: [] })).toEqual([
      { type: "text", text: "Now give it a title." },
    ]);
    expect(followUpParts({ text: "Describe it", attachmentParts: [file] })).toEqual([
      file,
      { type: "text", text: "Describe it" },
    ]);
    expect(followUpParts({ text: "  ", attachmentParts: [file] })).toEqual([file]);
  });
});

describe("mid-turn follow-ups", () => {
  test("only plain text joins a running turn", () => {
    expect(canInterject({ text: "Also book a table", attachmentParts: [] })).toBe(true);
    expect(canInterject({ text: "  ", attachmentParts: [] })).toBe(false);
    expect(
      canInterject({
        text: "Look at this",
        attachmentParts: [{ type: "file", url: "u", mediaType: "image/png" }],
      }),
    ).toBe(false);
  });

  test("several follow-ups are sent as one message, in typing order", () => {
    expect(joinFollowUpTexts([" First ", "", "Second"])).toBe("First\n\nSecond");
  });

  test("a newer parked follow-up joins the older one instead of replacing it", () => {
    const older = createPendingFollowUp("queued", "Book for Saturday", [], ["file-1"], [file()]);
    const newer = createPendingFollowUp("interrupt", "Make it four people", [], [], []);
    expect(mergePendingFollowUps(null, newer)).toBe(newer);
    const merged = mergePendingFollowUps(older, newer);
    expect(merged.id).toBe(older.id);
    expect(merged.kind).toBe("interrupt");
    expect(merged.text).toBe("Book for Saturday\n\nMake it four people");
    expect(merged.fileIds).toEqual(["file-1"]);
  });
});
