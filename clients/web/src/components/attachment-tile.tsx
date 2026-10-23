"use client";

import { FileIcon, FileTextIcon, XIcon } from "lucide-react";
import { Button } from "ui/button";
import type { UploadedFile } from "@/app/store";

/** Compact human size for the tile meta line. */
export function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Extract real files from a paste event's clipboard data. Returns an
 * empty array for plain-text pastes so text keeps its default inline
 * behavior in the editor.
 */
/** Minimal clipboard shape pastedFiles reads; real DataTransfer fits. */
export interface PastedClipboardData {
  readonly files?: ArrayLike<File> | null;
  readonly items?: ArrayLike<{
    readonly kind: string;
    getAsFile: () => File | null;
  }> | null;
}

export function pastedFiles(data: PastedClipboardData | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  if (data.files && data.files.length > 0) {
    for (const file of Array.from(data.files)) {
      if (file.size > 0) out.push(file);
    }
    return out;
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.size > 0) out.push(file);
  }
  return out;
}

function extensionOf(name: string) {
  const ext = name.split(".").pop()?.toUpperCase() ?? "";
  return ext.length <= 5 && ext !== name.toUpperCase() ? ext : "FILE";
}

/**
 * One attachment in the composer tray. Images show a thumbnail, documents
 * a tile with the extension, name and size. Upload progress is a thin bar
 * pinned to the tile's bottom edge so the layout never jumps.
 */
export function AttachmentTile({
  file,
  onRemove,
  onSummarize,
  canSummarize,
  summarizeLabel = "Summarize",
  removeLabel = "Remove attachment",
}: {
  file: UploadedFile;
  onRemove: (id: string) => void;
  onSummarize?: (id: string) => void;
  canSummarize?: boolean;
  summarizeLabel?: string;
  removeLabel?: string;
}) {
  const isImage = file.mimeType.startsWith("image/");
  const imageSrc = file.previewUrl || file.url || file.dataUrl || "";
  const ext = extensionOf(file.name);

  if (isImage) {
    return (
      <div className="group relative size-16 shrink-0 overflow-hidden rounded-xl border border-border bg-muted shadow-xs transition-colors hover:border-foreground/25">
        {imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageSrc}
            alt={file.name}
            className="size-full object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center font-mono text-[10px] font-bold uppercase text-muted-foreground">
            {ext}
          </div>
        )}
        {file.isUploading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/85 backdrop-blur-[2px]">
            <span className="text-[11px] font-semibold tabular-nums text-foreground">
              {file.progress || 0}%
            </span>
            <div className="h-1 w-10 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${file.progress || 0}%` }}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${removeLabel} ${file.name}`}
              title={`${removeLabel} ${file.name}`}
              data-testid={`attachment-remove-${file.id}`}
              className="absolute right-0.5 top-0.5 size-5 rounded-full"
              onClick={() => onRemove(file.id)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-start justify-end bg-gradient-to-b from-background/50 to-transparent p-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={`${removeLabel} ${file.name}`}
              title={`${removeLabel} ${file.name}`}
              data-testid={`attachment-remove-${file.id}`}
              className="size-6 rounded-full shadow-xs"
              onClick={() => onRemove(file.id)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Non-image files (PDF, docs) show a generated page thumbnail in the
  // badge slot when one is available, otherwise the extension tile.
  const thumbSrc = file.previewUrl || file.dataUrl || "";

  return (
    <div className="group relative flex h-14 shrink-0 items-center gap-2.5 rounded-xl border border-border bg-card py-1.5 pl-1.5 pr-1 shadow-xs transition-colors hover:border-foreground/25">
      {thumbSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbSrc}
          alt={file.name}
          aria-hidden
          className="size-11 shrink-0 rounded-lg border border-border/60 bg-muted object-cover"
        />
      ) : (
        <div
          aria-hidden
          className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted font-mono text-[10px] font-bold uppercase tracking-wide text-muted-foreground"
        >
          {ext.length > 4 ? <FileIcon className="size-4" /> : ext}
        </div>
      )}
      <div className="min-w-0 leading-tight">
        <p className="max-w-36 truncate text-xs font-medium text-foreground">
          {file.name}
        </p>
        <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
          {file.isUploading
            ? `Uploading ${file.progress || 0}%`
            : formatAttachmentSize(file.size)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        {canSummarize && onSummarize && !file.isUploading && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${summarizeLabel} ${file.name}`}
            title={`${summarizeLabel} ${file.name}`}
            className="size-7 rounded-full"
            onClick={() => onSummarize(file.id)}
          >
            <FileTextIcon className="size-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${removeLabel} ${file.name}`}
          title={`${removeLabel} ${file.name}`}
          data-testid={`attachment-remove-${file.id}`}
          className="size-7 rounded-full"
          onClick={() => onRemove(file.id)}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {file.isUploading && (
        <div className="absolute inset-x-2 bottom-1 h-0.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${file.progress || 0}%` }}
          />
        </div>
      )}
    </div>
  );
}
