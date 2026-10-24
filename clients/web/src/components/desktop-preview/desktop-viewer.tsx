"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, MonitorOff, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import {
  openDesktopSession,
  type DesktopSession,
  type DesktopSessionState,
} from "./desktop-session";

export interface DesktopViewerProps {
  agentId: string;
  agentName: string;
  viewOnly?: boolean;
}

/**
 * The agent's real X11 desktop (Xtigervnc + Openbox + Plank with Chromium,
 * Thunar and a terminal, inside its sandbox container), drawn by noVNC. Until
 * the stream connects, or when it ends, it says why instead of showing a
 * picture of a desktop.
 */
export function DesktopViewer({
  agentId,
  agentName,
  viewOnly = false,
}: DesktopViewerProps) {
  const t = useTranslations("AssistantDesktop");
  const sessionRef = useRef<DesktopSession | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<DesktopSessionState>({
    kind: "connecting",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    sessionRef.current?.setViewOnly(viewOnly);
  }, [viewOnly]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setState({ kind: "connecting" });
    const session = openDesktopSession({
      agentId,
      container,
      onState: setState,
      viewOnly: viewOnlyRef.current,
      viewportMode: "fit",
    });
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.close();
    };
  }, [agentId, attempt]);

  const reconnect = () => {
    setState({ kind: "connecting" });
    setAttempt((n) => n + 1);
  };

  return (
    <div
      className="relative flex h-full w-full flex-col bg-[#10171c]"
      data-testid="desktop-panel"
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
          data-testid="desktop-panel-viewport"
        />

        {state.kind !== "connected" && (
          <div
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#10171c] p-4 text-center text-white"
            data-testid="desktop-panel-status"
            data-state={state.kind === "ended" ? state.reason : state.kind}
            role="status"
          >
            {state.kind === "connecting" ? (
              <>
                <Loader2 className="size-6 animate-spin text-sky-400" />
                <p className="text-sm text-white/85">
                  {t("starting", { name: agentName })}
                </p>
              </>
            ) : (
              <>
                <MonitorOff className="size-6 text-white/60" />
                <div className="max-w-sm space-y-1">
                  <p className="text-sm font-medium">
                    {t(`ended.${state.reason}.title`)}
                  </p>
                  <p className="text-xs text-white/65">
                    {t(`ended.${state.reason}.body`)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={reconnect}
                  data-testid="desktop-panel-reconnect"
                  className="h-7 gap-1.5 border-white/20 bg-black/40 text-xs text-white hover:bg-white/15 hover:text-white"
                >
                  <RotateCw className="size-3" />
                  <span>{t("reconnectButton")}</span>
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
