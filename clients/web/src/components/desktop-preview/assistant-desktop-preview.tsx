"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Maximize2,
  Monitor,
  MoveDiagonal2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "ui/dialog";
import { MAIN_AGENT_ID, useAgents } from "@/lib/backend/agents-api";
import { useAgentScope } from "@/lib/backend/agent-scope";
import { DesktopViewer } from "./desktop-viewer";
import { DesktopWindowBar } from "./desktop-window-bar";
import { useDesktopPreviewStore } from "./desktop-preview-store";
import { useDesktopPreviewDrag } from "./use-desktop-preview-drag";

export function AssistantDesktopPreview() {
  const t = useTranslations("AssistantDesktop");
  const scope = useAgentScope();
  const { data: agentsData } = useAgents();
  const session = useDesktopPreviewStore((s) => s.session);
  const close = useDesktopPreviewStore((s) => s.close);
  const setFullscreen = useDesktopPreviewStore((s) => s.setFullscreen);
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeAgentId = session?.agentId ?? scope ?? MAIN_AGENT_ID;
  const resolvedAgent = agentsData?.agents.find(
    (a) =>
      a.id === activeAgentId || (activeAgentId === MAIN_AGENT_ID && a.isMain),
  );
  const agentName = resolvedAgent?.name ?? "Amiro";

  const {
    boundsRef,
    frameRef,
    position,
    width,
    onMoveKeyDown,
    onResizeKeyDown,
    ...dragProps
  } = useDesktopPreviewDrag();

  // Stable portal host so the live noVNC RFB session stays mounted when
  // toggling between the floating 16:9 TV screen and the fullscreen modal.
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [host] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "h-full w-full";
    return el;
  });

  const fullscreen = session?.view === "fullscreen";

  const attachPreview = useCallback(
    (node: HTMLDivElement | null) => {
      previewRef.current = node;
      if (!fullscreen && node && host) {
        node.appendChild(host);
      }
    },
    [fullscreen, host],
  );

  const attachFullscreen = useCallback(
    (node: HTMLDivElement | null) => {
      if (!host) return;
      (node ?? previewRef.current)?.appendChild(host);
    },
    [host],
  );

  if (!mounted || !session || !host) {
    return null;
  }

  const titleText = `${agentName} OS`;

  return createPortal(
    <>
      {createPortal(
        <DesktopViewer
          key={activeAgentId}
          agentId={activeAgentId}
          agentName={agentName}
          viewOnly={!fullscreen}
        />,
        host,
      )}

      <AnimatePresence initial={false}>
        <div
          key={activeAgentId}
          className="pointer-events-none fixed inset-0 z-40 flex"
        >
          <div
            ref={boundsRef}
            className="relative m-4 min-h-0 flex-1 [container-type:size]"
          >
            <motion.aside
              {...dragProps}
              ref={frameRef}
              id="assistant-desktop-preview"
              data-testid="assistant-desktop-preview"
              aria-label={titleText}
              className="pointer-events-auto absolute flex max-w-full touch-none select-none flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-2xl"
              style={{
                width: `min(${width}px, 100cqw, calc((100cqh - 4.375rem) * 16 / 9))`,
                left: position?.x,
                top: position?.y,
                right: position ? undefined : 0,
                bottom: position ? undefined : 0,
                visibility: fullscreen ? "hidden" : "visible",
              }}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: reduce ? 0 : 0.15 }}
            >
              {/* Vellum TV Screen Top Bar: Resize handle | Monitor Title (click to expand) | Close */}
              <div className="grid h-10 shrink-0 grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1 border-b border-border/70 bg-muted/40 px-1 transition-colors hover:bg-accent/40">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("resizeAria")}
                  title={t("resizeAria")}
                  data-desktop-resize
                  data-testid="desktop-preview-resize"
                  className="size-6 cursor-nwse-resize justify-self-center"
                  onKeyDown={onResizeKeyDown}
                >
                  <MoveDiagonal2 className="size-3.5" />
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("moveAria")}
                  data-testid="desktop-preview-title-button"
                  className="h-8 min-w-0 cursor-grab justify-center gap-1.5 hover:bg-transparent active:cursor-grabbing"
                  onKeyDown={onMoveKeyDown}
                  onClick={() => setFullscreen(true)}
                >
                  <Monitor className="size-4 shrink-0 text-primary" />
                  <span className="truncate text-xs font-semibold">
                    {t("title")}
                  </span>
                </Button>

                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("closeAria")}
                  title={t("closeAria")}
                  data-desktop-close
                  data-testid="desktop-preview-close"
                  className="size-7 justify-self-center"
                  onClick={close}
                >
                  <X className="size-4" />
                </Button>
              </div>

              <div className="flex h-7 shrink-0 items-center border-b border-white/10 bg-[#141c22] px-2.5">
                <DesktopWindowBar agentId={activeAgentId} />
              </div>

              {/* 16:9 Live VNC TV Viewport */}
              <div className="group relative aspect-video w-full overflow-hidden bg-[#10171c]">
                <div ref={attachPreview} className="h-full w-full" />

                {/* Click/tap overlay on the floating TV screen to expand into fullscreen interactive desktop */}
                <button
                  type="button"
                  aria-label={t("expandAria")}
                  data-testid="desktop-preview-expand"
                  onClick={() => setFullscreen(true)}
                  className="absolute inset-x-0 top-6 bottom-12 z-20 flex cursor-zoom-in items-center justify-center bg-black/15 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:bg-transparent"
                >
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
                    <Maximize2 className="size-3.5" />
                    <span>{t("expandAria")}</span>
                  </span>
                </button>
              </div>
            </motion.aside>
          </div>
        </div>
      </AnimatePresence>

      {/* Fullscreen Interactive Desktop Modal */}
      <Dialog
        open={Boolean(fullscreen)}
        onOpenChange={(open) => {
          if (!open) setFullscreen(false);
        }}
      >
        <DialogContent
          id="assistant-desktop-modal"
          data-testid="assistant-desktop-modal"
          onInteractOutside={(event) => {
            if (event.target instanceof Node && host.contains(event.target)) {
              event.preventDefault();
            }
          }}
          className="flex h-[94dvh] max-h-[94dvh] w-[96vw] max-w-[96vw] sm:max-w-[96vw] flex-col gap-0 overflow-hidden rounded-2xl border border-white/15 bg-[#10171c] p-0 shadow-2xl [&>button]:hidden"
        >
          <DialogTitle className="sr-only">{titleText}</DialogTitle>

          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[#141c22] px-4 py-2 text-white">
            <div className="flex shrink-0 items-center gap-2">
              <Monitor className="size-4 text-sky-400" />
              <span className="text-sm font-semibold tracking-tight">
                {t("title")} · {titleText}
              </span>
            </div>

            <div className="min-w-0 flex-1 px-2">
              <DesktopWindowBar agentId={activeAgentId} full />
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                data-testid="desktop-modal-minimize"
                onClick={() => setFullscreen(false)}
                className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
              >
                {t("minimizeButton")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("closeAria")}
                data-testid="desktop-modal-close"
                onClick={close}
                className="size-7 text-white/80 hover:bg-white/10 hover:text-white"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          <div
            ref={attachFullscreen}
            className="relative min-h-0 flex-1 overflow-hidden"
          />
        </DialogContent>
      </Dialog>
    </>,
    document.body,
  );
}
