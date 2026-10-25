"use client";

import { Button } from "ui/button";
import {
  CheckCircle2,
  Loader2,
  RotateCcw,
  Server,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  getUpdateJob,
  startServerUpdate,
  type UpdateJob,
  type UpdateStatus,
} from "@/lib/backend/update-api";
import { displayVersion, sameVersion } from "@/lib/updates/version";

const POLL_MS = 2000;

function jobRunning(job: UpdateJob | undefined): boolean {
  return job?.state === "installing" || job?.state === "restarting";
}

/**
 * The server row: update button for install.sh servers, the running job's
 * progress (it survives the restart), and what to do on other builds.
 */
export function ServerUpdateSection({
  status,
  onChanged,
}: {
  status: UpdateStatus;
  onChanged: () => void;
}) {
  const t = useTranslations("Updates");
  const [job, setJob] = useState<UpdateJob>(status.job);
  const [current, setCurrent] = useState(status.current);
  const [starting, setStarting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setJob(status.job);
    setCurrent(status.current);
  }, [status.job, status.current]);

  // While an update runs, poll the job. Requests fail while the server
  // restarts; keep polling until it answers again.
  const running = jobRunning(job);
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await getUpdateJob();
        if (cancelled) return;
        setCurrent(res.current);
        setJob(res.job);
        if (!jobRunning(res.job)) {
          onChanged();
          return;
        }
      } catch {
        // The server is restarting.
      }
      if (!cancelled) pollTimer.current = setTimeout(poll, POLL_MS);
    };
    pollTimer.current = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [running, onChanged]);

  const onUpdate = async () => {
    if (!status.latest || starting) return;
    setStarting(true);
    try {
      const res = await startServerUpdate(status.latest);
      setJob(res.job);
      toast.success(t("toast.started", { version: displayVersion(res.version) }), {
        duration: 8000,
      });
    } catch (error) {
      toast.error(
        t("toast.startFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setStarting(false);
    }
  };

  const target = displayVersion(job.target);
  const succeededHere = job.state === "succeeded" && sameVersion(job.target, current);

  return (
    <section className="space-y-3" data-testid="update-server">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Server className="size-4 text-muted-foreground" />
        {t("server.title")}
      </h3>

      {running ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
          data-testid="update-job"
          data-state={job.state}
        >
          <Loader2 className="size-4 animate-spin text-primary" />
          {job.state === "installing"
            ? t("job.installing", { version: target })
            : t("job.restarting", { version: target })}
          {job.trigger === "auto" ? (
            <span className="text-muted-foreground">{t("job.auto")}</span>
          ) : null}
        </div>
      ) : null}

      {job.state === "succeeded" && job.target ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm"
          data-testid="update-job"
          data-state="succeeded"
        >
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          {t("job.succeeded", { version: target })}
          {succeededHere ? null : (
            <span className="text-muted-foreground">{t("job.reloadHint")}</span>
          )}
        </div>
      ) : null}

      {job.state === "failed" && job.target ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          data-testid="update-job"
          data-state="failed"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 text-destructive" />
            {t("job.failed", { version: target })}
          </p>
          {job.error ? <p className="text-muted-foreground">{job.error}</p> : null}
          {job.log ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("job.log")}
              </summary>
              <pre
                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs"
                data-testid="update-job-log"
              >
                {job.log}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {status.method === "installer" ? (
        <>
          {status.updateAvailable && status.latest && !running ? (
            <Button
              onClick={() => void onUpdate()}
              disabled={starting}
              data-testid="update-server-now"
            >
              {starting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : job.state === "failed" ? (
                <RotateCcw className="size-4" />
              ) : null}
              {job.state === "failed" && sameVersion(job.target, status.latest)
                ? t("job.retry")
                : t("server.update", { version: displayVersion(status.latest) })}
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("server.installerHint")}</p>
        </>
      ) : status.method === "desktop" ? (
        <p className="text-xs text-muted-foreground" data-testid="update-server-desktop">
          {t("server.insideDesktop")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="update-server-manual">
          {t("server.manual")}
        </p>
      )}
    </section>
  );
}
