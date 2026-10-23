"use client";

import { PlugZap, Terminal, Unplug, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { cn } from "lib/utils";
import type { TerminalStatus } from "./types";

export interface TerminalToolbarProps {
  status: TerminalStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onClear: () => void;
  agentLabel?: string;
  isolation?: "host" | "container" | null;
  cwd?: string | null;
  className?: string;
}

export function TerminalToolbar({
  status,
  onConnect,
  onDisconnect,
  onClear,
  agentLabel,
  isolation,
  cwd,
  className,
}: TerminalToolbarProps) {
  const t = useTranslations("Admin.debug.terminal");
  const isConnecting = status === "connecting" || status === "reconnecting";
  const isConnected = status === "connected";
  const canConnect =
    status === "idle" || status === "closed" || status === "error";

  return (
    <div
      data-testid="terminal-toolbar"
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border/70 bg-muted/40 px-3 py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Terminal className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">
          {agentLabel
            ? `${t("heading")} · ${agentLabel}`
            : t("heading")}
        </span>
        <StatusBadge status={status} />
        {isConnected && isolation && (
          <span
            data-testid="terminal-isolation-badge"
            className="hidden sm:inline-flex items-center rounded-md border border-border/60 bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={cwd ?? undefined}
          >
            {isolation === "container"
              ? t("isolationContainer")
              : t("isolationHost")}
            {cwd ? ` (${cwd})` : ""}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          title={t("clearTitle")}
          data-testid="terminal-clear-button"
          className="h-7 gap-1.5 px-2.5 text-xs"
        >
          <X className="size-3.5" />
          <span>{t("clear")}</span>
        </Button>

        {isConnected || isConnecting ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={onDisconnect}
            disabled={isConnecting}
            title={t("disconnectTitle")}
            data-testid="terminal-disconnect-button"
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <Unplug className="size-3.5" />
            <span>
              {isConnecting ? t("status.connecting") : t("disconnect")}
            </span>
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={onConnect}
            disabled={!canConnect}
            title={t("connectTitle")}
            data-testid="terminal-connect-button"
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <PlugZap className="size-3.5" />
            <span>{t("connect")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<
  TerminalStatus,
  { toneClass: string; pulse?: boolean }
> = {
  idle: {
    toneClass: "border-border/70 bg-muted text-muted-foreground",
  },
  connecting: {
    toneClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    pulse: true,
  },
  connected: {
    toneClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  reconnecting: {
    toneClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    pulse: true,
  },
  error: {
    toneClass: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  closed: {
    toneClass: "border-border/70 bg-muted text-muted-foreground",
  },
};

function StatusBadge({ status }: { status: TerminalStatus }) {
  const t = useTranslations("Admin.debug.terminal");
  const config = STATUS_STYLE[status];
  const label = t(`status.${status}`);
  return (
    <span
      data-testid="terminal-status-badge"
      data-status={status}
      aria-label={t("statusAria", { status: label })}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        config.toneClass,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          config.pulse && "animate-pulse",
        )}
      />
      <span>{label}</span>
    </span>
  );
}
