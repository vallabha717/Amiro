"use client";

import { Button } from "ui/button";
import { Download, ExternalLink, Laptop, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import {
  checkDesktopUpdate,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
  installDesktopUpdate,
  progressPercent,
} from "@/lib/updates/desktop-updater";
import { displayVersion } from "@/lib/updates/version";

/** The desktop app row: shown only inside the Amiro desktop app. */
export function DesktopUpdateSection({ releaseUrl }: { releaseUrl: string }) {
  const t = useTranslations("Updates");
  const [info, setInfo] = useState<DesktopUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DesktopUpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setInfo(await checkDesktopUpdate());
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const install = async () => {
    setInstallError(null);
    setProgress({ phase: "downloading", received: 0, total: null });
    try {
      // Resolves only on failure: on success the app restarts first.
      await installDesktopUpdate(setProgress);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
      setProgress(null);
    }
  };

  const percent = progressPercent(progress);
  const version = displayVersion(info?.version);

  return (
    <section className="space-y-3" data-testid="update-desktop">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Laptop className="size-4 text-muted-foreground" />
        {t("desktop.title")}
      </h3>

      {checkError ? (
        <p className="text-sm text-muted-foreground" role="alert">
          {t("desktop.checkError", { error: checkError })}
        </p>
      ) : null}

      {info && !info.available ? (
        <p className="text-sm text-muted-foreground" data-testid="update-desktop-current">
          {t("desktop.upToDate", { version: displayVersion(info.current) })}
        </p>
      ) : null}

      {info?.available ? (
        <div className="space-y-2">
          <p className="text-sm">{t("desktop.available", { version })}</p>
          {info.notes ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("whatsNew", { version })}
              </summary>
              <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
                {info.notes}
              </div>
            </details>
          ) : null}
          {info.supported ? (
            progress ? (
              <div className="space-y-1" role="status" data-testid="update-desktop-progress">
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin text-primary" />
                  {progress.phase === "downloading"
                    ? percent === null
                      ? t("desktop.downloadingUnknown")
                      : t("desktop.downloading", { percent })
                    : t("desktop.installing")}
                </p>
                {percent !== null ? (
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
                  </div>
                ) : null}
              </div>
            ) : (
              <Button onClick={() => void install()} data-testid="update-desktop-install">
                <Download className="size-4" />
                {t("desktop.install", { version })}
              </Button>
            )
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("desktop.deb")}</p>
              <Button asChild variant="outline" data-testid="update-desktop-deb">
                <a href={releaseUrl} target="_blank" rel="noreferrer">
                  {t("desktop.debLink", { version })}
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {installError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("desktop.error", { error: installError })}
        </p>
      ) : null}

      {!progress ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void check()}
          disabled={checking}
          data-testid="update-desktop-check"
        >
          <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
          {t("desktop.check")}
        </Button>
      ) : null}
    </section>
  );
}
