"use client";

import { Maximize2, Monitor, PictureInPicture2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "ui/button";
import { cn } from "@/lib/utils";
import { MAIN_AGENT_ID, useAgents } from "@/lib/backend/agents-api";
import {
  type DesktopWindow,
  toHostPath,
  useDesktopState,
} from "@/lib/backend/desktop-api";
import { DesktopViewer } from "./desktop-viewer";
import { useDesktopPreviewStore } from "./desktop-preview-store";
import { DesktopWindowRow } from "./desktop-window-bar";

/** True while `ref` is on screen, so off-screen cards drop their stream. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

/**
 * The TV in the chat: shown under a desktop tool call. A live, view-only
 * picture of the agent's desktop while the card is on screen, the windows the
 * tool reported with their exact folders and addresses, and buttons to open
 * the floating TV or go full screen.
 */
export function DesktopChatCard({
  agentId,
  windows,
  pending,
  error,
}: {
  agentId: string;
  windows: DesktopWindow[];
  pending: boolean;
  error?: string;
}) {
  const t = useTranslations("AssistantDesktop");
  const { data: agentsData } = useAgents();
  const agent = agentsData?.agents.find(
    (a) => a.id === agentId || (agentId === MAIN_AGENT_ID && a.isMain),
  );
  const name = agent?.name ?? "Amiro";
  const openPreview = useDesktopPreviewStore((s) => s.openPreview);
  const openFullscreen = useDesktopPreviewStore((s) => s.openFullscreen);
  const tvOpen = useDesktopPreviewStore((s) => s.session?.agentId === agentId);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const onScreen = useOnScreen(frameRef);
  // The floating TV already streams this desktop; don't open a second stream.
  const live = onScreen && !tvOpen && !pending && !error;
  // While on screen, list what is open now (with each folder on the owner's
  // computer); otherwise what the tool reported, mapped the same way.
  const { data: now } = useDesktopState(
    onScreen && !pending && !error ? agentId : null,
  );
  const hostHome = now?.agent?.hostHome;
  const shown =
    now?.running && now.windows.length > 0
      ? now.windows
      : windows.map((w) =>
          w.path && !w.hostPath ? { ...w, hostPath: toHostPath(w.path, hostHome) } : w,
        );

  return (
    <div
      className={cn(
        "w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-sm",
        error && "border-destructive/50",
      )}
      data-testid="desktop-chat-card"
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <Monitor className="size-3.5 shrink-0 text-primary" />
        <span className="truncate text-xs font-medium">
          {t("chatCard.title", { name })}
        </span>
        {live && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            {t("chatCard.live")}
          </span>
        )}
      </div>

      <div
        ref={frameRef}
        className="relative aspect-video w-full bg-[#10171c]"
        data-testid="desktop-chat-card-screen"
      >
        {live ? (
          <DesktopViewer agentId={agentId} agentName={name} viewOnly />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-white/70">
            {error
              ? error
              : pending
                ? t("starting", { name })
                : tvOpen
                  ? t("chatCard.onTv")
                  : null}
          </div>
        )}
      </div>

      {shown.length > 0 && (
        <div
          className="space-y-1 border-t px-3 py-2"
          data-testid="desktop-chat-card-windows"
        >
          {hostHome && (
            <p className="truncate text-[11px] text-muted-foreground" title={hostHome}>
              {t("chatCard.workspace", { name, path: hostHome })}
            </p>
          )}
          {[...shown.filter((w) => w.active), ...shown.filter((w) => !w.active)].map((w, i) => (
            <div
              key={`${w.app}-${i}`}
              className={cn(!w.active && "opacity-70")}
            >
              <DesktopWindowRow window={w} agentName={name} tone="card" />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5 border-t px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          data-testid="desktop-chat-card-open-tv"
          onClick={() => openPreview(agentId)}
        >
          <PictureInPicture2 className="size-3.5" />
          {t("chatCard.openTv")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5 text-xs"
          data-testid="desktop-chat-card-fullscreen"
          onClick={() => openFullscreen(agentId)}
        >
          <Maximize2 className="size-3.5" />
          {t("chatCard.fullscreen")}
        </Button>
      </div>
    </div>
  );
}
