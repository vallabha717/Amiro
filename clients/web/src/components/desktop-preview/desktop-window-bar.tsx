"use client";

import { AppWindow, Check, Copy, Folder, Globe, SquareTerminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  type DesktopWindow,
  useDesktopState,
  windowLocation,
} from "@/lib/backend/desktop-api";

const ICONS = {
  browser: Globe,
  files: Folder,
  terminal: SquareTerminal,
  other: AppWindow,
} as const;

export function DesktopWindowIcon({
  app,
  className,
}: {
  app: DesktopWindow["app"];
  className?: string;
}) {
  const Icon = ICONS[app] ?? AppWindow;
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}

/**
 * One window: its app and the exact folder or address it shows, copyable.
 * Long paths keep their end visible (the part that names the folder).
 */
export function DesktopWindowRow({
  window,
  tone = "dark",
}: {
  window: DesktopWindow;
  tone?: "dark" | "card";
}) {
  const t = useTranslations("AssistantDesktop");
  const [copied, setCopied] = useState(false);
  const location = windowLocation(window);
  const copy = () => {
    void navigator.clipboard?.writeText(location).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[11px]",
        tone === "dark" ? "text-white/85" : "text-foreground",
      )}
      data-testid="desktop-window-row"
      data-app={window.app}
      data-active={window.active}
    >
      <DesktopWindowIcon
        app={window.app}
        className={tone === "dark" ? "text-sky-300" : "text-primary"}
      />
      <span className="shrink-0 font-medium">{t(`apps.${window.app}`)}</span>
      <span
        className={cn(
          "min-w-0 truncate font-mono [direction:rtl] text-left",
          tone === "dark" ? "text-white/70" : "text-muted-foreground",
        )}
        title={location}
        data-testid="desktop-window-location"
      >
        {/* rtl on the box cuts long paths from the left; bdi keeps the text itself ltr. */}
        <bdi dir="ltr">{location}</bdi>
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={t("copyLocation", { location })}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          tone === "dark" ? "hover:bg-white/15" : "hover:bg-muted",
        )}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

/**
 * The TV's "what's in front" line: the active window's app and its exact
 * folder or address, plus how many other windows are open. `full` also lists
 * every window.
 */
export function DesktopWindowBar({
  agentId,
  full = false,
}: {
  agentId: string;
  full?: boolean;
}) {
  const t = useTranslations("AssistantDesktop");
  const { data } = useDesktopState(agentId);
  if (!data?.running) return null;
  // `active` is a copy of one entry in `windows`, so find it by the flag;
  // with none focused, the newest window is in front.
  const activeIndex = data.windows.findIndex((w) => w.active);
  const index = activeIndex >= 0 ? activeIndex : data.windows.length - 1;
  const front = data.windows[index] ?? null;
  const others = data.windows.filter((_, i) => i !== index);
  return (
    <div
      className="flex min-w-0 items-center gap-3"
      data-testid="desktop-window-bar"
    >
      {front ? (
        <DesktopWindowRow window={front} />
      ) : (
        <span className="text-[11px] text-white/60">{t("noWindows")}</span>
      )}
      {full &&
        others.map((w, i) => (
          <div
            key={`${w.app}-${i}`}
            className="hidden min-w-0 max-w-64 opacity-70 lg:flex"
          >
            <DesktopWindowRow window={w} />
          </div>
        ))}
      {!full && others.length > 0 && (
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 text-[10px] text-white/70">
          {t("moreWindows", { count: others.length })}
        </span>
      )}
    </div>
  );
}
