"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  FolderOpen,
  Globe,
  Maximize2,
  Monitor,
  MoveDiagonal2,
  RotateCw,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "ui/dialog";
import { cn } from "@/lib/utils";
import { MAIN_AGENT_ID, useAgents } from "@/lib/backend/agents-api";
import { useAgentScope } from "@/lib/backend/agent-scope";
import { apiJson } from "@/lib/backend/client";
import {
  AgentBrowserPanel,
  type AgentBrowserPageData,
  type AgentBrowserStateResponse,
} from "@/components/terminal/agent-browser-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { WorkspaceBrowser } from "@/components/workspace-browser/workspace-browser";
import {
  useDesktopPreviewStore,
  type DesktopSurfaceTab,
} from "./desktop-preview-store";
import { useDesktopPreviewDrag } from "./use-desktop-preview-drag";

export function AssistantDesktopPreview() {
  const t = useTranslations("AssistantDesktop");
  const scope = useAgentScope();
  const { data: agentsData } = useAgents();
  const session = useDesktopPreviewStore((s) => s.session);
  const activeSurface = useDesktopPreviewStore((s) => s.activeSurface);
  const setActiveSurface = useDesktopPreviewStore((s) => s.setActiveSurface);
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

  const [previewPage, setPreviewPage] = useState<AgentBrowserPageData | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadPreviewScreen = useCallback(async () => {
    if (!session) return;
    setPreviewLoading(true);
    try {
      const res = await apiJson<AgentBrowserStateResponse>(
        "/api/debug/browser",
        {
          headers: { "X-Amiro-Agent": activeAgentId },
        },
      );
      if (res.page) {
        setPreviewPage(res.page);
      } else {
        const nav = await apiJson<AgentBrowserStateResponse>(
          "/api/debug/browser/navigate",
          {
            method: "POST",
            headers: { "X-Amiro-Agent": activeAgentId },
            body: JSON.stringify({
              agentId: activeAgentId,
              url: "about:blank",
            }),
          },
        );
        setPreviewPage(nav.page);
      }
    } catch {
      setPreviewPage(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [session, activeAgentId]);

  useEffect(() => {
    if (session) {
      void loadPreviewScreen();
    }
  }, [session, loadPreviewScreen]);

  if (!mounted || !session) {
    return null;
  }

  const fullscreen = session.view === "fullscreen";
  const titleText = `${t("title")} · ${agentName}`;

  const surfaceTabs: Array<{
    id: DesktopSurfaceTab;
    label: string;
    icon: typeof Globe;
  }> = [
    { id: "browser", label: t("tabs.browser"), icon: Globe },
    { id: "files", label: t("tabs.files"), icon: FolderOpen },
    { id: "terminal", label: t("tabs.terminal"), icon: TerminalIcon },
  ];

  return createPortal(
    <>
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
                width: `min(${width}px, 100cqw, calc((100cqh - 2.625rem) * 16 / 9))`,
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
                    {titleText}
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

              {/* 16:9 Live TV Viewport */}
              <div
                data-testid="desktop-panel-viewport"
                className="group relative aspect-video w-full overflow-hidden bg-[#0f1117]"
              >
                {previewPage?.screenshot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewPage.screenshot}
                    alt={previewPage.title || titleText}
                    data-testid="desktop-preview-screen-image"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
                    <Monitor className="size-6 text-muted-foreground/70" />
                    <span>
                      {previewLoading ? t("connecting") : titleText}
                    </span>
                  </div>
                )}

                {/* Bottom mini dock inside the floating TV screen */}
                <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 py-2">
                  <div className="flex items-center gap-1">
                    {surfaceTabs.map((tab) => {
                      const Icon = tab.icon;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          data-testid={`desktop-preview-quick-${tab.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveSurface(tab.id);
                            setFullscreen(true);
                          }}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white/85 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white",
                            activeSurface === tab.id &&
                              "border-primary/60 bg-primary/30 text-white",
                          )}
                        >
                          <Icon className="size-3" />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void loadPreviewScreen();
                    }}
                    title={t("reconnectButton")}
                    className="inline-flex size-6 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white/80 hover:bg-white/20 hover:text-white"
                  >
                    <RotateCw
                      className={cn(
                        "size-3",
                        previewLoading && "animate-spin",
                      )}
                    />
                  </button>
                </div>

                {/* Click anywhere on the TV screen to expand into the full interactive desktop modal */}
                <button
                  type="button"
                  aria-label={t("expandAria")}
                  data-testid="desktop-preview-expand"
                  onClick={() => setFullscreen(true)}
                  className="absolute inset-0 z-0 flex cursor-zoom-in items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100"
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

      {/* Fullscreen Interactive Desktop Modal (Browser & Screen | File System | Terminal) */}
      <Dialog
        open={fullscreen}
        onOpenChange={(open) => {
          if (!open) setFullscreen(false);
        }}
      >
        <DialogContent
          id="assistant-desktop-modal"
          data-testid="assistant-desktop-modal"
          className="flex h-[92dvh] max-h-[92dvh] w-[95vw] max-w-[95vw] sm:max-w-[95vw] flex-col gap-0 overflow-hidden rounded-2xl border border-border/80 bg-background p-0 shadow-2xl [&>button]:hidden"
        >
          <DialogTitle className="sr-only">{titleText}</DialogTitle>

          {/* Modal Header matching Vellum PreviewModalHeader + surface switcher */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/40 px-4 py-2.5">
            <div className="flex items-center gap-2.5">
              <Monitor className="size-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">
                {titleText}
              </span>
            </div>

            <div
              role="tablist"
              aria-label={t("title")}
              className="flex items-center gap-1 rounded-lg border border-border/60 bg-background/80 p-1"
            >
              {surfaceTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeSurface === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`desktop-modal-tab-${tab.id}`}
                    onClick={() => setActiveSurface(tab.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "bg-accent text-accent-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                data-testid="desktop-modal-minimize"
                onClick={() => setFullscreen(false)}
                className="h-8 text-xs"
              >
                {t("minimizeButton")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("closeAria")}
                data-testid="desktop-modal-close"
                onClick={close}
                className="size-8"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {/* Interactive Surface Body */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            {activeSurface === "browser" && (
              <AgentBrowserPanel
                key={activeAgentId}
                agentId={activeAgentId}
                agentLabel={agentName}
                className="min-h-0 flex-1"
              />
            )}
            {activeSurface === "files" && (
              <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/60 p-4">
                <WorkspaceBrowser embedded scopeKey={activeAgentId} />
              </div>
            )}
            {activeSurface === "terminal" && (
              <TerminalPanel
                key={activeAgentId}
                agentId={activeAgentId}
                agentLabel={agentName}
                className="min-h-0 flex-1"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>,
    document.body,
  );
}
