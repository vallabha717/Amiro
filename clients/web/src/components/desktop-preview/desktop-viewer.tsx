"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { AmiroOsDesktop } from "./amiro-os-desktop";
import type { TeamAgent } from "@/lib/backend/agents-api";
import {
  openDesktopSession,
  type DesktopSession,
  type DesktopSessionState,
} from "./desktop-session";

export interface DesktopViewerProps {
  agentId: string;
  agent?: TeamAgent;
  viewOnly?: boolean;
  onExpandRequest?: () => void;
}

/**
 * Vellum's interactive noVNC DesktopViewer:
 * Connects via `@novnc/novnc` RFB WebSocket to the agent's real X11 virtual
 * desktop (`Xtigervnc :99` + `openbox` + `plank` + real `Chromium` + `Thunar` +
 * `Terminal`). If the sandbox container is not running in unit/CI fixtures,
 * gracefully renders the interactive `AmiroOsDesktop` fallback.
 */
export function DesktopViewer({
  agentId,
  agent,
  viewOnly = false,
  onExpandRequest,
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
        {/* Live noVNC RFB Canvas */}
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
          data-testid="desktop-panel-viewport"
        />

        {/* While connecting or when VNC ends/falls back, show the Amiro OS desktop layer */}
        {state.kind !== "connected" && (
          <div
            className="absolute inset-0 flex flex-col bg-[#10171c]"
            data-testid="desktop-panel-status"
            data-state={state.kind === "ended" ? state.reason : state.kind}
          >
            <AmiroOsDesktop
              agentId={agentId}
              agent={agent}
              compact={viewOnly}
              onExpandRequest={onExpandRequest}
            />
            {state.kind === "connecting" && (
              <div className="pointer-events-none absolute top-10 right-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/70 px-2.5 py-1 text-[11px] text-white/85 backdrop-blur-md">
                <Loader2 className="size-3 animate-spin text-sky-400" />
                <span>{t("connecting")}</span>
              </div>
            )}
            {state.kind === "ended" && !viewOnly && (
              <div className="pointer-events-auto absolute top-10 right-3 z-30">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={reconnect}
                  className="h-7 gap-1.5 border-white/20 bg-black/70 text-xs text-white hover:bg-white/20"
                >
                  <RotateCw className="size-3" />
                  <span>{t("reconnectButton")}</span>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
