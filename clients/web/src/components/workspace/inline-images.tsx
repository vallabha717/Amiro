"use client";

import type { InlineImage } from "lib/chat-ux/inline-images";
import { cn } from "lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "ui/dialog";

/**
 * Images a tool returned, shown inline under its row the way Claude Code
 * shows screenshots: small thumbnails that never push the answer off
 * screen, one click to see full size, arrow keys to page through.
 */
export const InlineImageStrip = memo(function InlineImageStrip({
  images,
  className,
  size = "md",
}: {
  images: InlineImage[];
  className?: string;
  size?: "sm" | "md";
}) {
  const [index, setIndex] = useState<number | null>(null);
  if (!images.length) return null;

  return (
    <>
      <div className={cn("flex flex-wrap gap-2 py-1", className)}>
        {images.map((img, i) => (
          <button
            key={img.src.slice(0, 120) + i}
            type="button"
            onClick={() => setIndex(i)}
            className={cn(
              "group/thumb relative overflow-hidden rounded-lg border border-border bg-muted/40",
              "shadow-sm transition-all hover:shadow-md hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "h-14 w-20" : "h-28 w-40",
            )}
            title={img.alt || "Open image"}
          >
            <img
              src={img.src}
              alt={img.alt || ""}
              loading="lazy"
              className="size-full object-cover transition-transform duration-200 group-hover/thumb:scale-[1.03]"
            />
          </button>
        ))}
      </div>
      <ImageLightbox
        images={images}
        index={index}
        onIndexChange={setIndex}
      />
    </>
  );
});

export function ImageLightbox({
  images,
  index,
  onIndexChange,
}: {
  images: InlineImage[];
  index: number | null;
  onIndexChange: (i: number | null) => void;
}) {
  const open = index !== null;
  const step = useCallback(
    (d: number) => {
      if (index === null) return;
      onIndexChange((index + d + images.length) % images.length);
    },
    [index, images.length, onIndexChange],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step]);

  const img = index !== null ? images[index] : undefined;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onIndexChange(null)}>
      <DialogContent className="sm:max-w-[min(92vw,1200px)] p-2 bg-background/95 backdrop-blur">
        <DialogTitle className="sr-only">{img?.alt || "Image"}</DialogTitle>
        {img && (
          <div className="relative flex items-center justify-center">
            <img
              src={img.src}
              alt={img.alt || ""}
              className="max-h-[82vh] max-w-full rounded-md object-contain"
            />
            {images.length > 1 && (
              <>
                <LightboxNav side="left" onClick={() => step(-1)} />
                <LightboxNav side="right" onClick={() => step(1)} />
              </>
            )}
          </div>
        )}
        <div className="flex items-center justify-between px-2 pb-1 text-xs text-muted-foreground">
          <span className="truncate">{img?.alt || ""}</span>
          <div className="flex items-center gap-3">
            {images.length > 1 && (
              <span className="tabular-nums">
                {(index ?? 0) + 1} / {images.length}
              </span>
            )}
            {img && (
              <a
                href={img.src}
                download
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <DownloadIcon className="size-3.5" /> Download
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LightboxNav({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 rounded-full border bg-background/80 p-1.5 shadow backdrop-blur hover:bg-background",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/**
 * An image inside a markdown reply. Spans and a button only, because
 * react-markdown places images inside <p>, where a <div> is invalid HTML.
 */
export function MarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(0)}
        className="my-2 inline-block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/40 align-top shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={alt || "Open image"}
      >
        <img src={src} alt={alt || ""} loading="lazy" className="block max-h-80 max-w-full object-contain" />
      </button>
      <ImageLightbox images={[{ src, alt }]} index={open} onIndexChange={setOpen} />
    </>
  );
}
