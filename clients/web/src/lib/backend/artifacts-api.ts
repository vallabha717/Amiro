"use client";

import { apiFetch, apiJson, fetcher } from "@/lib/backend/client";
import useSWR from "swr";

export type FileArtifactKind =
  | "markdown"
  | "html"
  | "code"
  | "text"
  | "csv"
  | "json"
  | "pdf"
  | "docx"
  | "svg"
  | "data";

export interface FileArtifact {
  id: string;
  title: string;
  kind: FileArtifactKind;
  language?: string | null;
  filename: string;
  mime: string;
  size: number;
  threadId?: string | null;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  contentText?: string | null;
}

export interface CreateFileArtifactInput {
  title?: string;
  kind?: string;
  language?: string;
  filename?: string;
  mime?: string;
  contentText?: string;
  contentBase64?: string;
  threadId?: string;
}

export function useFileArtifacts(enabled = true) {
  return useSWR<FileArtifact[]>(enabled ? "/api/artifacts" : null, fetcher, {
    revalidateOnFocus: false,
  });
}

export function useFileArtifact(id: string | null) {
  return useSWR<FileArtifact>(
    id ? `/api/artifacts/${encodeURIComponent(id)}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );
}

export async function createFileArtifact(
  input: CreateFileArtifactInput,
): Promise<FileArtifact> {
  return apiJson<FileArtifact>("/api/artifacts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateFileArtifact(
  id: string,
  input: Partial<CreateFileArtifactInput>,
): Promise<FileArtifact> {
  return apiJson<FileArtifact>(`/api/artifacts/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteFileArtifact(id: string): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>(`/api/artifacts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Download URL for anchor tags — goes through apiFetch so auth headers ride along. */
export async function downloadArtifactBlob(id: string): Promise<Blob> {
  const res = await apiFetch(
    `/api/artifacts/${encodeURIComponent(id)}/download`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Download failed (${res.status})`);
  }
  return res.blob();
}

/** Object URL for inline preview (pdf/html in an iframe). Caller must revoke it. */
export async function previewArtifactUrl(id: string): Promise<string> {
  const res = await apiFetch(
    `/api/artifacts/${encodeURIComponent(id)}/download?inline=1`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Preview failed (${res.status})`);
  }
  return URL.createObjectURL(await res.blob());
}

/** True when the artifact can be shown as text in the panel. */
export function isTextPreviewable(a: Pick<FileArtifact, "kind" | "mime">) {
  return (
    ["markdown", "html", "code", "text", "csv", "json", "svg"].includes(
      a.kind,
    ) || a.mime.startsWith("text/") ||
    a.mime === "application/json" ||
    a.mime === "image/svg+xml"
  );
}

/** True when the artifact previews in a sandboxed iframe (pdf, html, svg). */
export function isFramedPreviewable(a: Pick<FileArtifact, "kind" | "mime">) {
  return (
    a.kind === "pdf" ||
    a.kind === "html" ||
    a.kind === "svg" ||
    a.mime === "application/pdf" ||
    a.mime === "text/html" ||
    a.mime === "image/svg+xml"
  );
}

/** Human file-size label for the artifact list. */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Short human label for the kind badge. */
export function kindLabel(kind: string) {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "code":
      return "Code";
    case "csv":
      return "CSV";
    case "json":
      return "JSON";
    case "pdf":
      return "PDF";
    case "docx":
      return "Word";
    case "svg":
      return "SVG";
    case "data":
      return "File";
    default:
      return "Text";
  }
}

/**
 * Kind badge for a file artifact. The server only knows a handful of kinds, so
 * a PowerPoint or a video arrives as "text"; the file name says more.
 */
export function artifactKindLabel(a: Pick<FileArtifact, "kind" | "filename">) {
  const ext = a.filename.slice(a.filename.lastIndexOf(".") + 1).toLowerCase();
  const byExt: Record<string, string> = {
    pptx: "PowerPoint",
    xlsx: "Excel",
    xlsm: "Excel",
    tsv: "CSV",
    png: "Image",
    jpg: "Image",
    jpeg: "Image",
    gif: "Image",
    webp: "Image",
    mp4: "Video",
    webm: "Video",
    mov: "Video",
    mp3: "Audio",
    wav: "Audio",
    m4a: "Audio",
  };
  return byExt[ext] ?? kindLabel(a.kind);
}
