"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Clock3, ExternalLink } from "lucide-react";

import { Alert, AlertDescription } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card } from "ui/card";
import { Skeleton } from "ui/skeleton";
import type { Schedule, ScheduleRun } from "@/lib/backend/schedules-api";
import { listScheduleRuns } from "@/lib/backend/schedules-api";
import { formatInTimezone } from "./schedule-helpers";

function runStatusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "ok" || s === "done") return { label: "Succeeded", variant: "secondary" as const };
  if (s === "failed" || s === "error") return { label: "Failed", variant: "destructive" as const };
  if (s === "skipped") return { label: "Skipped", variant: "outline" as const };
  if (s === "running") return { label: "Running", variant: "secondary" as const };
  if (s === "interrupted") return { label: "Interrupted", variant: "outline" as const };
  return { label: status, variant: "outline" as const };
}

export function ScheduleDetailSheet({
  schedule,
  onClose,
  onEdit,
  refreshKey,
}: {
  schedule: Schedule;
  onClose: () => void;
  onEdit: () => void;
  /** Bumps when parent observes lastRunAt/lastStatus change or a run-now completes. */
  refreshKey?: number;
}) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listScheduleRuns(schedule.id)
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load runs.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [schedule.id, refreshKey, schedule.lastRunAt, schedule.lastStatus]);

  return (
    <div
      data-testid="schedule-detail"
      className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="shrink-0 border-b px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{schedule.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {schedule.prompt}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="schedule-detail-close">
            Close
          </Button>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Mode</dt>
            <dd className="font-medium">
              {schedule.mode === "execute" ? "Execute" : "In-app reminder"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Enabled</dt>
            <dd className="font-medium">{schedule.enabled ? "Yes" : "Paused"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Timezone</dt>
            <dd className="font-medium">{schedule.timezone}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Next run</dt>
            <dd className="font-medium">
              {formatInTimezone(schedule.nextRunAt, schedule.timezone)}
            </dd>
          </div>
          {schedule.lastRunAt ? (
            <div>
              <dt className="text-muted-foreground">Last run</dt>
              <dd className="font-medium">
                {formatInTimezone(schedule.lastRunAt, schedule.timezone)}
              </dd>
            </div>
          ) : null}
          {schedule.model ? (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-medium truncate">{schedule.model}</dd>
            </div>
          ) : null}
          <div className="col-span-2">
            <dt className="text-muted-foreground">Schedule</dt>
            <dd className="font-mono text-[12px] break-all">
              {schedule.schedule.kind === "once"
                ? `once at ${schedule.schedule.at}`
                : schedule.schedule.kind === "cron"
                  ? schedule.schedule.expression
                  : `every ${schedule.schedule.minutes} min`}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            data-testid="schedule-detail-edit"
          >
            Edit
          </Button>
          {schedule.threadId ? (
            <a
              href={`/?thread=${encodeURIComponent(schedule.threadId)}`}
              data-testid="schedule-detail-open-thread"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent"
            >
              Open conversation <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <Clock3 className="size-4 opacity-70" />
          Run history
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Latest runs for this schedule. Output is preview only; open the
          conversation for full history.
        </p>

        <div className="mt-4 space-y-2" data-testid="schedule-runs-list">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : error ? (
            <Alert variant="destructive" data-testid="schedule-runs-error">
              <AlertCircle className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : !runs || runs.length === 0 ? (
            <Card className="p-4 text-center text-sm text-muted-foreground" data-testid="schedule-runs-empty">
              No runs yet. Use Run now to fire immediately, or wait for the
              next scheduled tick (daemon must be running).
            </Card>
          ) : (
            runs.map((r) => {
              const badge = runStatusBadge(r.status);
              const isExpanded = expandedId === r.id;
              return (
                <Card
                  key={r.id}
                  data-testid={`schedule-run-${r.id}`}
                  className={`p-3 ${isExpanded ? "bg-accent/30" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={badge.variant} className="text-[11px]">
                          {badge.label}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatInTimezone(r.startedAt ?? r.scheduledAt, schedule.timezone)}
                        </span>
                      </div>
                      {r.outputPreview ? (
                        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                          {r.outputPreview}
                        </p>
                      ) : r.error ? (
                        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-destructive">
                          {r.error}
                        </p>
                      ) : null}
                    </div>
                    {r.threadId ? (
                      <a
                        href={`/?thread=${encodeURIComponent(r.threadId)}`}
                        data-testid={`schedule-run-open-thread-${r.id}`}
                        className="shrink-0 inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-accent"
                      >
                        Open <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                  {(r.outputPreview && r.outputPreview.length > 220) || r.error ? (
                    <button
                      type="button"
                      data-testid={`schedule-run-toggle-${r.id}`}
                      onClick={() => setExpandedId(isExpanded ? null : r.id)}
                      className="mt-2 text-xs font-medium text-primary hover:underline"
                    >
                      {isExpanded ? "Show less" : "Show more"}
                    </button>
                  ) : null}
                  {isExpanded ? (
                    <div className="mt-2 space-y-2">
                      {r.outputPreview ? (
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-xs">
                          {r.outputPreview}
                        </pre>
                      ) : null}
                      {r.error ? (
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
                          {r.error}
                        </pre>
                      ) : null}
                      <div className="text-[11px] text-muted-foreground">
                        {r.scheduledAt ? `Scheduled: ${formatInTimezone(r.scheduledAt, schedule.timezone)} · ` : ""}
                        {r.finishedAt ? `Finished: ${formatInTimezone(r.finishedAt, schedule.timezone)}` : ""}
                        {r.jobId ? ` · job ${r.jobId.slice(0, 8)}` : ""}
                      </div>
                    </div>
                  ) : null}
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
