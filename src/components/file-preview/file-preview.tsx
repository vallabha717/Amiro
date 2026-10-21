"use client";

import { Markdown } from "@/components/markdown";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import {
  type PreviewKind,
  mimeForMedia,
  previewByteCap,
} from "lib/file-preview/kinds";
import { type Sheet, type PptxSlide, parseDelimited, readPptx, readXlsx } from "lib/file-preview/office";
import { cn } from "lib/utils";
import { Download, FileQuestion } from "lucide-react";
import * as React from "react";
import { formatBytes } from "@/components/workspace-browser/workspace-api";

function Notice({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FileQuestion className="size-5" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="max-w-xs text-xs text-muted-foreground">{children}</div> : null}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** Object URL that lives as long as the blob is shown. */
function useObjectUrl(blob: Blob | null, mime?: string): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!blob) return;
    const typed = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
    const next = URL.createObjectURL(typed);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob, mime]);
  return url;
}

/** Run an async reader against the blob, with loading and error states. */
function useReader<T>(blob: Blob, read: (b: Blob) => Promise<T>) {
  const [state, setState] = React.useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T }
  >({ status: "loading" });
  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    read(blob).then(
      (value) => !cancelled && setState({ status: "ready", value }),
      (e) =>
        !cancelled &&
        setState({ status: "error", message: e instanceof Error ? e.message : "Could not read file" }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);
  return state;
}

function Reader<T>({
  blob,
  read,
  children,
}: {
  blob: Blob;
  read: (b: Blob) => Promise<T>;
  children: (value: T) => React.ReactNode;
}) {
  const state = useReader(blob, read);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error")
    return (
      <div role="alert">
        <Notice title="Could not read this file">{state.message}</Notice>
      </div>
    );
  return <>{children(state.value)}</>;
}

function ImageView({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob, mimeForMedia(name, blob.type));
  if (!url) return <Loading />;
  return (
    <div className="flex min-h-full items-center justify-center bg-muted/30 p-6">
      <img
        src={url}
        alt={name}
        data-testid="file-preview-image"
        className="max-h-[70vh] max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
      />
    </div>
  );
}

function MediaView({ blob, name, kind }: { blob: Blob; name: string; kind: "video" | "audio" }) {
  const url = useObjectUrl(blob, mimeForMedia(name, blob.type));
  const [failed, setFailed] = React.useState(false);
  if (!url) return <Loading />;
  if (failed)
    return (
      <Notice title="This browser can't play this file">
        Download it to open it in a media player.
      </Notice>
    );
  return (
    <div className="flex min-h-full items-center justify-center bg-black/90 p-4">
      {kind === "video" ? (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={name}
          data-testid="file-preview-video"
          onError={() => setFailed(true)}
          className="max-h-[70vh] max-w-full rounded-md"
        />
      ) : (
        <audio
          src={url}
          controls
          preload="metadata"
          aria-label={name}
          data-testid="file-preview-audio"
          onError={() => setFailed(true)}
          className="w-full max-w-md"
        />
      )}
    </div>
  );
}

const MAX_PDF_PAGES = 60;

/**
 * Pages drawn to canvases with pdf.js, the same engine the attachment
 * thumbnails use. An iframe would lean on the browser's own PDF plugin, which
 * headless and embedded browsers do not have.
 */
function PdfView({ blob }: { blob: Blob }) {
  const host = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; pages: number; total: number }
  >({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    setState({ status: "loading" });
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", window.location.href).toString();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        const shown = Math.min(doc.numPages, MAX_PDF_PAGES);
        const width = Math.max(320, el.clientWidth - 32);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        for (let n = 1; n <= shown; n++) {
          if (cancelled) return;
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;
          canvas.className = "mx-auto mb-3 block max-w-full rounded-sm border border-border bg-white shadow-sm";
          canvas.setAttribute("data-testid", "file-preview-pdf-page");
          el.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
          if (n === 1) setState({ status: "ready", pages: shown, total: doc.numPages });
        }
        if (!cancelled) setState({ status: "ready", pages: shown, total: doc.numPages });
        await doc.cleanup();
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : "Could not read this PDF" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  return (
    <div data-testid="file-preview-pdf" className="bg-muted/30 p-4">
      {state.status === "loading" ? <PreviewLoadingInline /> : null}
      {state.status === "error" ? (
        <div role="alert">
          <Notice title="Could not read this PDF">{state.message}</Notice>
        </div>
      ) : null}
      <div ref={host} />
      {state.status === "ready" && state.total > state.pages ? (
        <p className="pb-2 text-center text-xs text-muted-foreground">
          Showing the first {state.pages} of {state.total} pages. Download for the rest.
        </p>
      ) : null}
    </div>
  );
}

function PreviewLoadingInline() {
  return <Loading />;
}

async function readDocxText(blob: Blob): Promise<string> {
  const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
    import("mammoth/mammoth.browser"),
    import("dompurify"),
  ]);
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  return DOMPurify.sanitize(value);
}

function DocxTextView({ blob }: { blob: Blob }) {
  return (
    <Reader blob={blob} read={readDocxText}>
      {(html) => (
        <article
          data-testid="file-preview-docx"
          className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-5"
          // Sanitised with DOMPurify above; mammoth only emits document markup.
          dangerouslySetInnerHTML={{ __html: html || "<p><em>This document is empty.</em></p>" }}
        />
      )}
    </Reader>
  );
}

function PptxTextView({ blob }: { blob: Blob }) {
  return (
    <Reader blob={blob} read={readPptx}>
      {(slides: PptxSlide[]) =>
        slides.length === 0 ? (
          <Notice title="No slides found" />
        ) : (
          <ol data-testid="file-preview-pptx" className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
            {slides.map((s) => (
              <li key={s.index} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground tabular-nums">
                  Slide {s.index}
                </p>
                <h3 className="text-base font-semibold leading-snug">{s.title}</h3>
                {s.lines.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground/90">
                    {s.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : null}
                {s.notes.length ? (
                  <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                    Notes: {s.notes.join(" ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )
      }
    </Reader>
  );
}

/**
 * Run a renderer that draws into a DOM node. If the renderer throws (an
 * unusual or damaged file), fall back to the plain text view so the file is
 * never a dead end.
 */
function Drawn({
  blob,
  draw,
  fallback,
  testId,
  className,
  stage,
}: {
  blob: Blob;
  draw: (host: HTMLDivElement, bytes: ArrayBuffer, width: number) => Promise<void | (() => void)>;
  fallback: React.ReactNode;
  testId: string;
  className?: string;
  stage?: string;
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "failed">("loading");
  React.useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let cleanup: void | (() => void);
    el.replaceChildren();
    setState("loading");
    (async () => {
      try {
        const bytes = await blob.arrayBuffer();
        cleanup = await draw(el, bytes, el.clientWidth);
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
      if (typeof cleanup === "function") cleanup();
      el.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);
  if (state === "failed") return <>{fallback}</>;
  return (
    <div className={cn("relative size-full", stage)}>
      {state === "loading" ? <Loading /> : null}
      <div ref={host} data-testid={testId} className={className} />
    </div>
  );
}

function DocxView({ blob }: { blob: Blob }) {
  return (
    <Drawn
      blob={blob}
      testId="file-preview-docx"
      stage="bg-muted/40 overflow-auto"
      className="docx-host py-4"
      fallback={<DocxTextView blob={blob} />}
      draw={async (host, bytes) => {
        const { renderAsync } = await import("docx-preview");
        // Pages keep their real size, fonts, tables, images, headers and footers.
        await renderAsync(bytes, host, undefined, {
          className: "docx",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
          breakPages: true,
          useBase64URL: true,
        });
      }}
    />
  );
}

function PptxView({ blob }: { blob: Blob }) {
  return (
    <Drawn
      blob={blob}
      testId="file-preview-pptx"
      stage="bg-muted/40 overflow-auto"
      className="pptx-host mx-auto max-w-[960px] p-4"
      fallback={<PptxTextView blob={blob} />}
      draw={async (host, bytes) => {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
        // Slides keep their real layout: shapes, images, tables, charts, themes.
        const viewer = await PptxViewer.open(bytes, host, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          listOptions: { windowed: true },
        });
        return () => viewer.destroy();
      }}
    />
  );
}

function XlsxView({ blob }: { blob: Blob }) {
  return (
    <Drawn
      blob={blob}
      testId="file-preview-xlsx"
      className="xlsx-host h-full min-h-[420px]"
      fallback={<XlsxTextView blob={blob} />}
      draw={async (host, bytes) => {
        const { default: jsPreviewExcel } = await import("@js-preview/excel");
        // Real cell styling, merged cells, column widths and sheet tabs.
        const viewer = jsPreviewExcel.init(host, { showContextmenu: false });
        await viewer.preview(bytes);
        return () => viewer.destroy();
      }}
    />
  );
}

function Grid({ rows, truncated }: { rows: string[][]; truncated?: boolean }) {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return (
    <div className="min-w-max">
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn(i === 0 && "sticky top-0 bg-muted font-medium")}>
              <td className="sticky left-0 select-none border border-border/60 bg-muted/60 px-2 text-right text-[11px] text-muted-foreground tabular-nums">
                {i + 1}
              </td>
              {Array.from({ length: width }, (_, c) => (
                <td key={c} className="max-w-[24rem] truncate border border-border/60 px-2 py-1">
                  {r[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="p-3 text-xs text-muted-foreground">Showing the first rows. Download for the rest.</p>
      ) : null}
    </div>
  );
}

function XlsxTextView({ blob }: { blob: Blob }) {
  const [active, setActive] = React.useState(0);
  return (
    <Reader blob={blob} read={readXlsx}>
      {(sheets: Sheet[]) =>
        sheets.length === 0 ? (
          <Notice title="No sheets found" />
        ) : (
          <div data-testid="file-preview-xlsx" className="flex size-full min-h-0 flex-col">
            <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
              {sheets.map((s, i) => (
                <button
                  key={s.name + i}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  onClick={() => setActive(i)}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    i === active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <Grid rows={sheets[Math.min(active, sheets.length - 1)].rows} truncated={sheets[Math.min(active, sheets.length - 1)].truncated} />
            </div>
          </div>
        )
      }
    </Reader>
  );
}

function CsvView({ text, tab }: { text: string; tab: boolean }) {
  const rows = React.useMemo(() => parseDelimited(text, tab ? "\t" : ","), [text, tab]);
  const capped = rows.length > 2000;
  return (
    <div data-testid="file-preview-csv">
      <Grid rows={capped ? rows.slice(0, 2000) : rows} truncated={capped} />
    </div>
  );
}

export function UnsupportedView({
  name,
  mimeType,
  size,
  title = "No preview for this file type",
  onDownload,
}: {
  name: string;
  mimeType?: string;
  size: number;
  title?: string;
  onDownload: () => void;
}) {
  return (
    <Notice title={title}>
      {name}
      {mimeType ? ` · ${mimeType}` : ""} · {formatBytes(size)}
      <div className="mt-3">
        <Button type="button" size="sm" variant="outline" onClick={onDownload} className="gap-1.5">
          <Download className="size-3.5" /> Download
        </Button>
      </div>
    </Notice>
  );
}

/**
 * Preview for kinds shown from raw bytes or special layouts. Text-like kinds
 * (markdown, code, json) stay with the caller, which already has the text.
 */
export function BinaryPreview({
  kind,
  blob,
  name,
}: {
  kind: PreviewKind;
  blob: Blob;
  name: string;
}) {
  switch (kind) {
    case "image":
      return <ImageView blob={blob} name={name} />;
    case "video":
    case "audio":
      return <MediaView blob={blob} name={name} kind={kind} />;
    case "pdf":
      return <PdfView blob={blob} />;
    case "docx":
      return <DocxView blob={blob} />;
    case "pptx":
      return <PptxView blob={blob} />;
    case "xlsx":
      return <XlsxView blob={blob} />;
    default:
      return null;
  }
}

export { CsvView, Notice as PreviewNotice, Loading as PreviewLoading, previewByteCap, Markdown };
