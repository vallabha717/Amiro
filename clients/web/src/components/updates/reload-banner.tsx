"use client";

import { Button } from "ui/button";
import { RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { getServerVersion } from "@/lib/backend/update-api";
import { isDesktopApp } from "@/lib/updates/desktop-updater";
import { displayVersion, isStaleUi } from "@/lib/updates/version";

const POLL_MS = 5 * 60 * 1000;
const DISMISS_KEY = "amiro.reload-banner.dismissed";

/**
 * Browsers and phones load the screens from the server. After the server
 * updates, an open tab still runs the old screens: offer a reload. The
 * desktop app bundles its screens and updates them with the app instead.
 */
export function ReloadBanner() {
  const t = useTranslations("Updates");
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (isDesktopApp()) return;
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY));
    } catch {
      // Storage can be blocked; the banner then simply shows again.
    }
    let cancelled = false;
    const check = async () => {
      try {
        const version = await getServerVersion();
        if (!cancelled) setServerVersion(version);
      } catch {
        // Offline or restarting: try again on the next tick or focus.
      }
    };
    void check();
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (!isStaleUi(serverVersion) || dismissed === serverVersion) return null;

  const dismiss = () => {
    setDismissed(serverVersion);
    try {
      if (serverVersion) sessionStorage.setItem(DISMISS_KEY, serverVersion);
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
      <span className="flex-1">{t("banner.text", { version: displayVersion(serverVersion) })}</span>
      <Button size="sm" onClick={() => window.location.reload()} data-testid="update-reload-button">
        {t("banner.reload")}
      </Button>
      <Button size="icon" variant="ghost" className="size-7" onClick={dismiss} aria-label={t("banner.dismiss")}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
