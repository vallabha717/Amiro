"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Maximize2,
  Minimize2,
  Minus,
  ShieldCheck,
  Wifi,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/team/agent-avatar";
import type { TeamAgent } from "@/lib/backend/agents-api";
import { AgentBrowserPanel } from "@/components/terminal/agent-browser-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { WorkspaceBrowser } from "@/components/workspace-browser/workspace-browser";

export type OsAppId = "chrome" | "files" | "terminal";

export interface OsWindowState {
  id: OsAppId;
  title: string;
  isOpen: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  zIndex: number;
}

const DEFAULT_WINDOWS: Record<OsAppId, OsWindowState> = {
  chrome: {
    id: "chrome",
    title: "Google Chrome",
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 10,
  },
  files: {
    id: "files",
    title: "Files",
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 11,
  },
  terminal: {
    id: "terminal",
    title: "Terminal",
    isOpen: false,
    isMinimized: false,
    isMaximized: false,
    zIndex: 12,
  },
};

export interface AmiroOsDesktopProps {
  agentId: string;
  agent?: TeamAgent;
  compact?: boolean;
  initialOpenApp?: OsAppId | null;
  onExpandRequest?: (appId?: OsAppId) => void;
  className?: string;
}

/**
 * Full Vellum-style Virtual Desktop OS ("Amiro OS" / "<AgentName> OS"):
 * - Radial dark `#202a30 -> #10171c` wallpaper with concentric accent rings,
 *   centered agent avatar, and 3D extruded `<AgentName> OS` wordmark.
 * - Top status bar showing `<AgentName> OS`, workspace/isolation badge, and live clock.
 * - Openbox-styled dark window manager (`#292930` title bar, `#4a4a54` border)
 *   supporting Google Chrome, Files (Thunar-style workspace browser), and Terminal.
 * - Bottom Plank-style Matte dock with Google Chrome, Files, and Terminal launchers.
 */
export function AmiroOsDesktop({
  agentId,
  agent,
  compact = false,
  initialOpenApp = null,
  onExpandRequest,
  className,
}: AmiroOsDesktopProps) {
  const agentName = agent?.name || "Amiro";
  const accentHex =
    agent?.accentHex && /^#[\da-f]{6}$/i.test(agent.accentHex)
      ? agent.accentHex
      : "#91a6b0";
  const isMain = !agentId || agentId === "main" || agentId === "amiro";
  const osLabel = `${agentName} OS`;

  const [windows, setWindows] = useState<Record<OsAppId, OsWindowState>>(() => {
    const base = {
      chrome: { ...DEFAULT_WINDOWS.chrome },
      files: { ...DEFAULT_WINDOWS.files },
      terminal: { ...DEFAULT_WINDOWS.terminal },
    };
    if (initialOpenApp && base[initialOpenApp]) {
      base[initialOpenApp].isOpen = true;
      base[initialOpenApp].zIndex = 20;
    }
    return base;
  });
  const [, setTopZ] = useState(25);
  const [clock, setClock] = useState<string>("");

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setClock(
        now.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    };
    updateClock();
    const timer = setInterval(updateClock, 15_000);
    return () => clearInterval(timer);
  }, []);

  const focusApp = useCallback((appId: OsAppId) => {
    setTopZ((prev) => {
      const nextZ = prev + 1;
      setWindows((curr) => ({
        ...curr,
        [appId]: {
          ...curr[appId],
          isOpen: true,
          isMinimized: false,
          zIndex: nextZ,
        },
      }));
      return nextZ;
    });
  }, []);

  const toggleDockApp = useCallback(
    (appId: OsAppId) => {
      if (compact && onExpandRequest) {
        focusApp(appId);
        onExpandRequest(appId);
        return;
      }
      setTopZ((prev) => {
        const nextZ = prev + 1;
        setWindows((curr) => {
          const target = curr[appId];
          const maxVisibleZ = Math.max(
            ...Object.values(curr)
              .filter((w) => w.isOpen && !w.isMinimized)
              .map((w) => w.zIndex),
            0,
          );
          if (!target.isOpen) {
            return {
              ...curr,
              [appId]: {
                ...target,
                isOpen: true,
                isMinimized: false,
                zIndex: nextZ,
              },
            };
          }
          if (target.isMinimized) {
            return {
              ...curr,
              [appId]: {
                ...target,
                isMinimized: false,
                zIndex: nextZ,
              },
            };
          }
          if (target.zIndex === maxVisibleZ) {
            return {
              ...curr,
              [appId]: {
                ...target,
                isMinimized: true,
              },
            };
          }
          return {
            ...curr,
            [appId]: {
              ...target,
              zIndex: nextZ,
            },
          };
        });
        return nextZ;
      });
    },
    [compact, focusApp, onExpandRequest],
  );

  const closeWindow = useCallback((appId: OsAppId) => {
    setWindows((curr) => ({
      ...curr,
      [appId]: {
        ...curr[appId],
        isOpen: false,
        isMinimized: false,
      },
    }));
  }, []);

  const minimizeWindow = useCallback((appId: OsAppId) => {
    setWindows((curr) => ({
      ...curr,
      [appId]: {
        ...curr[appId],
        isMinimized: true,
      },
    }));
  }, []);

  const toggleMaximizeWindow = useCallback((appId: OsAppId) => {
    setTopZ((prev) => {
      const nextZ = prev + 1;
      setWindows((curr) => ({
        ...curr,
        [appId]: {
          ...curr[appId],
          isMaximized: !curr[appId].isMaximized,
          zIndex: nextZ,
        },
      }));
      return nextZ;
    });
  }, []);

  const visibleWindows = Object.values(windows)
    .filter((w) => w.isOpen && !w.isMinimized)
    .sort((a, b) => a.zIndex - b.zIndex);
  const topWindowId =
    visibleWindows.length > 0
      ? visibleWindows[visibleWindows.length - 1].id
      : null;

  return (
    <div
      data-testid="amiro-os-desktop"
      data-agent-id={agentId}
      className={cn(
        "relative flex h-full w-full select-none flex-col overflow-hidden text-[#f0f0f4]",
        className,
      )}
      style={{
        background: "linear-gradient(135deg, #202a30 0%, #10171c 100%)",
      }}
    >
      {/* Vellum-Exact Radial Glow + Concentric Rings + Center Avatar + 3D Extruded Wordmark Wallpaper */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      >
        {/* Radial Accent Glow */}
        <div
          className="absolute rounded-full"
          style={{
            width: "75%",
            height: "75%",
            top: "10%",
            background: `radial-gradient(circle, ${accentHex}3d 0%, transparent 70%)`,
          }}
        />

        {/* Concentric Vector Rings */}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 1280 800"
          preserveAspectRatio="xMidYMid slice"
        >
          <g fill="none" stroke={accentHex}>
            <circle cx="640" cy="340" r="145" strokeOpacity="0.18" strokeWidth="1.5" />
            <circle cx="640" cy="340" r="240" strokeOpacity="0.10" strokeWidth="1.5" />
            <circle cx="640" cy="340" r="365" strokeOpacity="0.06" strokeWidth="1.5" />
          </g>
        </svg>

        {/* Center Agent Avatar & 3D Extruded "<AgentName> OS" Wordmark */}
        <div
          className={cn(
            "relative z-0 flex flex-col items-center justify-center transition-opacity duration-200",
            visibleWindows.length > 0 ? "opacity-25" : "opacity-100",
            compact ? "-mt-3 scale-75" : "-mt-6",
          )}
        >
          <div className="relative flex items-center justify-center">
            <div
              className="absolute -bottom-3 h-5 w-28 rounded-full blur-md"
              style={{ background: "rgba(0, 0, 0, 0.45)" }}
            />
            {agent ? (
              <div className="rounded-3xl p-2 shadow-2xl">
                <AgentAvatar agent={agent} size={compact ? 68 : 112} />
              </div>
            ) : (
              <div
                className="flex items-center justify-center rounded-full border border-white/15 shadow-2xl"
                style={{
                  width: compact ? 68 : 112,
                  height: compact ? 68 : 112,
                  background: `radial-gradient(circle at 35% 30%, ${accentHex}, #1a242b)`,
                }}
              >
                <span className="font-brand text-2xl font-bold text-white">
                  {agentName.slice(0, 1).toUpperCase()}
                </span>
              </div>
            )}
          </div>

          <div
            data-testid="amiro-os-wordmark"
            className={cn(
              "mt-4 font-sans font-extrabold tracking-[0.06em] text-transparent bg-clip-text select-none",
              compact ? "text-xl" : "text-4xl sm:text-5xl",
            )}
            style={{
              backgroundImage:
                "linear-gradient(180deg, #ffffff 0%, #e0e9e7 48%, #9eb4ba 100%)",
              filter:
                "drop-shadow(1px 1px 0px #40535b) drop-shadow(2px 2px 0px #40535b) drop-shadow(3px 3px 0px #2b3940) drop-shadow(6px 8px 10px rgba(8,15,20,0.55))",
            }}
          >
            {osLabel}
          </div>
        </div>
      </div>

      {/* Top OS Panel Bar */}
      <div
        data-testid="amiro-os-topbar"
        className={cn(
          "relative z-20 flex shrink-0 items-center justify-between border-b border-white/10 bg-[#181f24]/85 backdrop-blur-md",
          compact ? "h-6 px-2.5 text-[10px]" : "h-8 px-3.5 text-xs",
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: accentHex }}
          />
          <span className="font-semibold tracking-wide text-white/95">
            {osLabel}
          </span>
          <span className="hidden sm:inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/75">
            <ShieldCheck className="size-2.5 text-emerald-400" />
            {isMain ? "Host Workspace" : "Isolated Container"}
          </span>
        </div>

        <div className="flex items-center gap-3 font-mono text-white/80">
          <Wifi className={cn(compact ? "size-2.5" : "size-3", "text-emerald-400")} />
          <span>{clock}</span>
        </div>
      </div>

      {/* Desktop Workspace Area (Windows Layer) */}
      <div className="relative z-10 min-h-0 flex-1 overflow-hidden p-2 sm:p-4 pb-16 sm:pb-20">
        {!compact &&
          visibleWindows.map((win, idx) => {
            const isActive = win.id === topWindowId;
            // Stagger non-maximized windows slightly so multiple open windows are visible
            const offsetPx = idx * 18;
            return (
              <OsWindowFrame
                key={win.id}
                windowState={win}
                isActive={isActive}
                offsetPx={offsetPx}
                onFocus={() => focusApp(win.id)}
                onMinimize={() => minimizeWindow(win.id)}
                onToggleMaximize={() => toggleMaximizeWindow(win.id)}
                onClose={() => closeWindow(win.id)}
              >
                {win.id === "chrome" && (
                  <AgentBrowserPanel
                    agentId={agentId}
                    agentLabel={agentName}
                    className="h-full w-full rounded-none border-0"
                  />
                )}
                {win.id === "files" && (
                  <div className="h-full w-full overflow-y-auto bg-background text-foreground p-3">
                    <WorkspaceBrowser embedded scopeKey={agentId} />
                  </div>
                )}
                {win.id === "terminal" && (
                  <TerminalPanel
                    agentId={agentId}
                    agentLabel={agentName}
                    className="h-full w-full rounded-none border-0"
                  />
                )}
              </OsWindowFrame>
            );
          })}
      </div>

      {/* Bottom Plank-Style Matte OS Dock (Chrome, Files, Terminal) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
        <div
          data-testid="amiro-os-dock"
          role="toolbar"
          aria-label={`${osLabel} Dock`}
          className={cn(
            "pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/15 bg-[#1b2228]/85 shadow-2xl backdrop-blur-xl",
            compact ? "px-2.5 py-1.5" : "px-3.5 py-2",
          )}
        >
          <DockAppButton
            appId="chrome"
            label="Google Chrome"
            compact={compact}
            isOpen={windows.chrome.isOpen}
            isActive={topWindowId === "chrome"}
            onClick={() => toggleDockApp("chrome")}
          >
            <ChromeAppIcon className={compact ? "size-7" : "size-11"} />
          </DockAppButton>

          <DockAppButton
            appId="files"
            label="Files"
            compact={compact}
            isOpen={windows.files.isOpen}
            isActive={topWindowId === "files"}
            onClick={() => toggleDockApp("files")}
          >
            <FilesAppIcon className={compact ? "size-7" : "size-11"} />
          </DockAppButton>

          <DockAppButton
            appId="terminal"
            label="Terminal"
            compact={compact}
            isOpen={windows.terminal.isOpen}
            isActive={topWindowId === "terminal"}
            onClick={() => toggleDockApp("terminal")}
          >
            <TerminalAppIcon className={compact ? "size-7" : "size-11"} />
          </DockAppButton>
        </div>
      </div>
    </div>
  );
}

function OsWindowFrame({
  windowState,
  isActive,
  offsetPx,
  onFocus,
  onMinimize,
  onToggleMaximize,
  onClose,
  children,
}: {
  windowState: OsWindowState;
  isActive: boolean;
  offsetPx: number;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={`amiro-os-window-${windowState.id}`}
      onMouseDown={onFocus}
      style={{
        zIndex: windowState.zIndex,
        ...(windowState.isMaximized
          ? { inset: "0.5rem 0.5rem 4.25rem 0.5rem" }
          : {
              top: `${Math.min(offsetPx + 12, 48)}px`,
              left: `${Math.min(offsetPx + 24, 64)}px`,
              right: `${Math.max(48 - offsetPx, 16)}px`,
              bottom: "4.5rem",
            }),
      }}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-lg border shadow-2xl transition-shadow",
        isActive
          ? "border-[#4a4a54] shadow-[0_20px_60px_rgba(0,0,0,0.65)]"
          : "border-[#36363f] opacity-95",
      )}
    >
      {/* Openbox-themed Window Titlebar (#292930 active / #232329 inactive) */}
      <div
        onDoubleClick={onToggleMaximize}
        className={cn(
          "flex h-8 shrink-0 items-center justify-between border-b border-[#202026] px-2.5 text-xs font-medium",
          isActive
            ? "bg-[#292930] text-[#f0f0f4]"
            : "bg-[#232329] text-[#a6a6b2]",
        )}
      >
        <div className="flex items-center gap-2">
          {windowState.id === "chrome" && <ChromeAppIcon className="size-4" />}
          {windowState.id === "files" && <FilesAppIcon className="size-4" />}
          {windowState.id === "terminal" && (
            <TerminalAppIcon className="size-4" />
          )}
          <span className="truncate">{windowState.title}</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Minimize ${windowState.title}`}
            data-testid={`amiro-os-window-${windowState.id}-minimize`}
            onClick={(e) => {
              e.stopPropagation();
              onMinimize();
            }}
            className="flex size-5 items-center justify-center rounded text-[#d4d4dc] hover:bg-[#45454f]"
          >
            <Minus className="size-3" />
          </button>
          <button
            type="button"
            aria-label={`Maximize ${windowState.title}`}
            data-testid={`amiro-os-window-${windowState.id}-maximize`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize();
            }}
            className="flex size-5 items-center justify-center rounded text-[#d4d4dc] hover:bg-[#45454f]"
          >
            {windowState.isMaximized ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </button>
          <button
            type="button"
            aria-label={`Close ${windowState.title}`}
            data-testid={`amiro-os-window-${windowState.id}-close`}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex size-5 items-center justify-center rounded text-[#d4d4dc] hover:bg-[#b64150] hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Window Client Area */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#131722]">
        {children}
      </div>
    </div>
  );
}

function DockAppButton({
  appId,
  label,
  compact,
  isOpen,
  isActive,
  onClick,
  children,
}: {
  appId: OsAppId;
  label: string;
  compact: boolean;
  isOpen: boolean;
  isActive: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={`amiro-os-dock-${appId}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center justify-center rounded-xl transition-transform duration-150 hover:-translate-y-1 active:scale-95",
        compact ? "p-1" : "p-1.5",
        isActive && "bg-white/10 ring-1 ring-white/20",
      )}
    >
      {children}
      <span
        className={cn(
          "mt-1 rounded-full transition-all",
          compact ? "size-1" : "size-1.5",
          isOpen
            ? isActive
              ? "bg-sky-400 shadow-[0_0_6px_#38bdf8]"
              : "bg-white/70"
            : "bg-transparent",
        )}
      />
    </button>
  );
}

/** Realistic Google Chrome SVG App Icon */
function ChromeAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("shrink-0 drop-shadow-md", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="chrome-red" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ea4335" />
          <stop offset="100%" stopColor="#d93025" />
        </linearGradient>
        <linearGradient id="chrome-yellow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fbbc04" />
          <stop offset="100%" stopColor="#f29900" />
        </linearGradient>
        <linearGradient id="chrome-green" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#34a853" />
          <stop offset="100%" stopColor="#1e8e3e" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="28" fill="#ffffff" />
      <path
        d="M32 4 A28 28 0 0 1 56.25 18 L32 18 Z"
        fill="url(#chrome-red)"
      />
      <path
        d="M10.1 14.6 A28 28 0 0 1 56.25 18 L32 18 L20 39 Z"
        fill="url(#chrome-red)"
      />
      <path
        d="M56.25 18 A28 28 0 0 1 32 60 L20 39 L32 18 Z"
        fill="url(#chrome-yellow)"
      />
      <path
        d="M32 60 A28 28 0 0 1 10.1 14.6 L22 35 L32 60 Z"
        fill="url(#chrome-green)"
      />
      <circle cx="32" cy="32" r="13" fill="#ffffff" />
      <circle cx="32" cy="32" r="10.5" fill="#4285f4" />
    </svg>
  );
}

/** Adwaita/Thunar-style Blue File Manager Folder Icon */
function FilesAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("shrink-0 drop-shadow-md", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="files-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3584e4" />
          <stop offset="100%" stopColor="#1c71d8" />
        </linearGradient>
        <linearGradient id="files-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#62a0ea" />
          <stop offset="100%" stopColor="#3584e4" />
        </linearGradient>
      </defs>
      <path
        d="M8 14 C8 11.8 9.8 10 12 10 H25 L30 15 H52 C54.2 15 56 16.8 56 19 V50 C56 52.2 54.2 54 52 54 H12 C9.8 54 8 52.2 8 50 Z"
        fill="url(#files-back)"
      />
      <rect x="12" y="18" width="40" height="8" rx="2" fill="#ffffff" opacity="0.85" />
      <path
        d="M6 23 C6 20.8 7.8 19 10 19 H54 C56.2 19 58 20.8 58 23 L56 51 C56 53.2 54.2 55 52 55 H12 C9.8 55 8 53.2 8 51 Z"
        fill="url(#files-front)"
      />
    </svg>
  );
}

/** Vellum-style Dark Terminal (`>_`) App Icon */
function TerminalAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("shrink-0 drop-shadow-md", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="term-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2d333b" />
          <stop offset="100%" stopColor="#161b22" />
        </linearGradient>
      </defs>
      <rect
        x="6"
        y="8"
        width="52"
        height="48"
        rx="11"
        fill="url(#term-bg)"
        stroke="#484f58"
        strokeWidth="2"
      />
      <path
        d="M18 24 L27 31 L18 38"
        fill="none"
        stroke="#58a6ff"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="31"
        y1="38"
        x2="43"
        y2="38"
        stroke="#3fb950"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
