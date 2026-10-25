"use client";

import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { ArrowUpToLine, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import {
  refreshUpdateStatus,
  type UpdateStatus,
  useUpdateStatus,
} from "@/lib/backend/update-api";
import { isDesktopApp } from "@/lib/updates/desktop-updater";
import { displayVersion } from "@/lib/updates/version";

import { DesktopUpdateSection } from "./desktop-update-section";
import { ServerUpdateSection } from "./server-update-section";
import { UpdateSettings } from "./update-settings";

function StatusBadge({ status, loading }: { status?: UpdateStatus; loading: boolean }) {
  const t = useTranslations("Updates");
  if (loading) return <Badge variant="secondary">{t("status.checking")}</Badge>;
  if (status?.checkFailed) {
    return (
      <Badge variant="outline" className="border-amber-500/30 text-amber-600 dark:text-amber-400">
        {t("status.checkFailed")}
      </Badge>
    );
  }
  if (status?.noReleases) return <Badge variant="secondary">{t("status.noReleases")}</Badge>;
  if (status?.updateAvailable && status.latest) {
    return (
      <Badge className="bg-primary text-primary-foreground" data-testid="update-available-badge">
        {t("status.available", { version: displayVersion(status.latest) })}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
      {t("status.upToDate")}
    </Badge>
  );
}

/** Admin → General → Version & updates. */
export function UpdateCard() {
  const t = useTranslations("Updates");
  const { data: status, isLoading, mutate } = useUpdateStatus(true);
  const [checking, setChecking] = useState(false);
  const desktop = isDesktopApp();

  const checkNow = async () => {
    setChecking(true);
    try {
      const fresh = await refreshUpdateStatus();
      await mutate(fresh, { revalidate: false });
      if (fresh.checkFailed) toast.error(t("toast.checkFailed"));
    } catch {
      toast.error(t("toast.checkFailed"));
    } finally {
      setChecking(false);
    }
  };

  const reload = useCallback(() => void mutate(), [mutate]);

  return (
    <Card data-testid="general-version">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <ArrowUpToLine className="size-5 text-primary" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <StatusBadge status={status} loading={isLoading} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2 text-sm">
          <div className="flex gap-6">
            <span className="w-32 text-muted-foreground">{t("current")}</span>
            <span className="font-mono" data-testid="general-version-value">
              {status ? displayVersion(status.current) : "—"}
            </span>
          </div>
          {status?.latest ? (
            <div className="flex gap-6">
              <span className="w-32 text-muted-foreground">{t("latest")}</span>
              <a
                href={status.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                data-testid="general-version-latest"
              >
                {displayVersion(status.latest)}
                <ExternalLink className="size-3 shrink-0 opacity-70" />
              </a>
            </div>
          ) : null}
          {status?.checkedAt ? (
            <p className="text-xs text-muted-foreground">
              {t("checkedAt", { time: new Date(status.checkedAt).toLocaleString() })}
            </p>
          ) : null}
          {status?.checkFailed ? (
            <p className="text-xs text-muted-foreground">{t("checkFailedHint")}</p>
          ) : null}
        </div>

        {status?.updateAvailable && status.latest && status.notes ? (
          <details data-testid="update-notes">
            <summary className="cursor-pointer text-sm font-medium">
              {t("whatsNew", { version: displayVersion(status.latest) })}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
              {status.notes}
            </div>
          </details>
        ) : null}

        {status ? <ServerUpdateSection status={status} onChanged={reload} /> : null}
        {desktop && status ? <DesktopUpdateSection releaseUrl={status.releaseUrl} /> : null}
        {status ? (
          <UpdateSettings
            settings={status.settings}
            method={status.method}
            onSaved={(settings) => void mutate({ ...status, settings }, { revalidate: false })}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">{t("devicesNote")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void checkNow()}
            disabled={checking || isLoading}
            data-testid="general-update-check"
          >
            <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
            {t("checkNow")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
