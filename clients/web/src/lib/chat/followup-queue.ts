"use client";

import type { UploadedFile } from "@/app/store";
import { isFilePartSupported, isIngestSupported } from "@/lib/ai/file-support";
import { generateUUID } from "lib/utils";
import type { FileUIPart, TextUIPart } from "ai";

/**
 * A follow-up message parked while the agent is still responding.
 *
 * Typing Enter mid-turn does not send immediately: the SDK appends to a
 * single live transcript and concurrent requests would corrupt it. Instead
 * the draft is captured here (text plus a snapshot of the attached files)
 * and flushed as the next turn the moment the current one settles. The
 * composer clears right away so typing never feels blocked, and cancelling
 * hands the text back untouched.
 */
export interface SourceUrlPart {
  type: "source-url";
  url: string;
  title?: string;
  mediaType?: string;
}

export type ComposerAttachmentPart =
  | FileUIPart
  | SourceUrlPart
  | (TextUIPart & { ingestionPreview?: boolean });

export type PendingKind = "queued" | "interrupt";

export interface PendingFollowUp {
  id: string;
  kind: PendingKind;
  text: string;
  attachmentParts: ComposerAttachmentPart[];
  /** Store file ids captured at park time, so the flush only removes those. */
  fileIds: string[];
  /**
   * The attached files as they were when parked. The tray is cleared at park
   * time so the composer reads as free; cancelling hands these back.
   */
  files: UploadedFile[];
}

export function createPendingFollowUp(
  kind: PendingKind,
  text: string,
  attachmentParts: ComposerAttachmentPart[],
  fileIds: string[],
  files: UploadedFile[],
): PendingFollowUp {
  return { id: generateUUID(), kind, text, attachmentParts, fileIds, files };
}

/** The message a parked follow-up sends: its files, then what was typed. */
export function followUpParts(
  pending: Pick<PendingFollowUp, "text" | "attachmentParts">,
): ComposerAttachmentPart[] {
  const text = pending.text.trim();
  return text
    ? [...pending.attachmentParts, { type: "text", text }]
    : pending.attachmentParts;
}

/** The `/login` command opens a local panel and must never become a message. */
export function isLoginCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/login";
}

/**
 * Build the attachment parts for a user message, mirroring what the
 * composer sends: model-readable `file` parts where supported, `source-url`
 * references otherwise, fronted by an ingestion-preview summary so the agent
 * knows what was attached.
 */
export function buildAttachmentParts(
  files: UploadedFile[],
  supportedFileMimeTypes: string[] | undefined,
): ComposerAttachmentPart[] {
  const parts = files.reduce<ComposerAttachmentPart[]>((acc, file) => {
    const link = file.url || file.dataUrl || "";
    if (!link) return acc;
    if (isFilePartSupported(file.mimeType, supportedFileMimeTypes)) {
      acc.push({
        type: "file",
        url: link,
        mediaType: file.mimeType,
        filename: file.name,
      } as FileUIPart);
    } else {
      acc.push({
        type: "source-url",
        url: link,
        title: file.name,
        mediaType: file.mimeType,
      });
    }
    return acc;
  }, []);

  if (parts.length > 0) {
    parts.unshift({
      type: "text",
      text: `Attached files:\n${buildAttachmentsSummary(files)}`,
      ingestionPreview: true,
    });
  }
  return parts;
}

export function buildAttachmentsSummary(files: UploadedFile[]): string {
  return files
    .map((file, index) => {
      const type = file.mimeType || "unknown";
      return `${index + 1}. ${file.name} (${type})`;
    })
    .join("\n");
}

export function hasUploadInProgress(files: UploadedFile[]): boolean {
  return files.some((file) => file.isUploading);
}

/** Short preview for the queued chip, keeping one long message readable. */
export function previewQueuedText(text: string, maxLength = 80): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}...`;
}

/** Files worth mentioning on the chip: parked ids that are still attached. */
export function countParkedFiles(
  fileIds: string[],
  currentFiles: UploadedFile[],
): number {
  const current = new Set(currentFiles.map((file) => file.id));
  return fileIds.filter((id) => current.has(id)).length;
}

/** Keep only files the user attached after the message was parked. */
export function excludeParkedFiles(
  currentFiles: UploadedFile[],
  parkedFileIds: string[],
): UploadedFile[] {
  const parked = new Set(parkedFileIds);
  return currentFiles.filter((file) => !parked.has(file.id));
}

/**
 * Files to hand back when a parked follow-up is cancelled: the snapshot
 * minus anything already in the tray (the user may have re-attached the
 * same file while the chip was showing).
 */
export function restoreParkedFiles(
  currentFiles: UploadedFile[],
  parkedFiles: UploadedFile[],
): UploadedFile[] {
  const current = new Set(currentFiles.map((file) => file.id));
  return parkedFiles.filter((file) => !current.has(file.id));
}

export function isIngestable(mimeType: string): boolean {
  return isIngestSupported(mimeType);
}
