"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Render the first page of a PDF into a small PNG data URL for the
 * attachment tray thumbnail. Lazy-loads pdf.js so the main bundle stays
 * lean, and returns null on any failure so the tile falls back to the
 * extension badge.
 */
export async function renderPdfThumbnail(
  blob: Blob,
  maxWidth = 176,
): Promise<string | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    // Worker is self-hosted at /pdf.worker.min.mjs (kept in sync by
    // scripts/sync-pdf-worker.mjs) so thumbnails work offline.
    if (typeof window !== "undefined") {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdf.worker.min.mjs",
        window.location.href,
      ).toString();
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const doc: PDFDocumentProxy = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, maxWidth / viewport.width);
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(scaled.width);
    canvas.height = Math.ceil(scaled.height);
    await page.render({ canvas, viewport: scaled }).promise;
    await doc.cleanup();
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
