"use client";

import { Button } from "ui/button";
import { RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { getServerBuild } from "@/lib/backend/update-api";
import { isDesktopApp } from "@/lib/updates/desktop-updater";
import { type Build, displayBuild, isStaleUi } from "@/lib/updates/version";

const POLL_MS = 5 * 60 * 1000;
const DISMISS_KEY = "amiro.reload-banner.dismissed";

function buildKey(build: Build | null): string {
  return build ? `${build.version ?? ""}+${build.commit ?? ""}` : "";
}

/** Text typed into a composer or form that a reload would lose. */
function hasUnsentText(): boolean {
  const fields = document.querySelectorAll<HTMLTextAreaElement | HTMLElement>(
    "textarea, [contenteditable='true']",
  );
  return Array.from(fields).some((field) =>
    ("value" in field ? field.value : field.textContent ?? "").trim(),
  );
}

/**
 * Browsers and phones load the screens from the server. After the server
 * updates, an open tab still runs the old screens. Coming back to it (a
 * phone app reopened from the Home Screen, a tab switched back to) reloads
 * it by itself unless something typed would be lost; otherwise a banner
 * offers the reload. The desktop app bundles its screens and updates them
 * with the app instead.
 */
export function ReloadBanner() {
  const t = useTranslations("Updates");
  const [server, setServer] = useState<Build | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (isDesktopApp()) return;
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY));
    } catch {
      // Storage can be blocked; the banner then simply shows again.
    }
    let cancelled = false;
    const check = async (resumed: boolean) => {
      try {
        const build = await getServerBuild();
        if (cancelled) return;
        if (resumed && isStaleUi(build) && !hasUnsentText()) {
          window.location.reload();
          return;
        }
        setServer(build);
      } catch {
        // Offline or restarting: try again on the next tick or focus.
      }
    };
    void check(false);
    const timer = setInterval(() => void check(false), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!isStaleUi(server) || dismissed === buildKey(server)) return null;

  const dismiss = () => {
    const key = buildKey(server);
    setDismissed(key);
    try {
      sessionStorage.setItem(DISMISS_KEY, key);
    } catch {
      // ignore
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b bg-primary/10 px-4 py-2 text-sm"
      data-testid="update-reload-banner"
    >
      <RefreshCw className="size-4 shrink-0 text-primary" />
      <span className="flex-1">{t("banner.text", { version: displayBuild(server) })}</span>
      <Button size="sm" onClick={() => window.location.reload()} data-testid="update-reload-button">
        {t("banner.reload")}
      </Button>
      <Button size="icon" variant="ghost" className="size-7" onClick={dismiss} aria-label={t("banner.dismiss")}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
