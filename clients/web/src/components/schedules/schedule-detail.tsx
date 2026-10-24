"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Clock3, Coins, ExternalLink, Play, Repeat, XCircle } from "lucide-react";

import { Alert, AlertDescription } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card } from "ui/card";
import { Skeleton } from "ui/skeleton";
import type {
  Schedule,
  ScheduleRun,
  ScheduleUsageSummary,
} from "@/lib/backend/schedules-api";
import { listScheduleRuns } from "@/lib/backend/schedules-api";
import {
  formatDuration,
  formatInTimezone,
  formatScheduleCost,
  formatScheduleRunCount,
  isOneShotSchedule,
  isPastOneTimeSchedule,
} from "./schedule-helpers";

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
  usageSummary,
  onClose,
  onEdit,
  onRunNow,
  onCancelOneTime,
  refreshKey,
}: {
  schedule: Schedule;
  usageSummary?: ScheduleUsageSummary | null;
  onClose: () => void;
  onEdit: () => void;
  onRunNow?: () => void;
  onCancelOneTime?: () => void;
  /** Bumps when parent observes lastRunAt/lastStatus change or a run-now completes. */
  refreshKey?: number;
}) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const canCancelPending =
    isOneShotSchedule(schedule) &&
    !isPastOneTimeSchedule(schedule) &&
    schedule.status !== "firing";

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
            {schedule.description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {schedule.description}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {schedule.mode === "script"
                ? schedule.script || schedule.prompt
                : schedule.prompt}
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
              {schedule.mode === "agent"
                ? "Agent (tools and connectors)"
                : schedule.mode === "execute"
                  ? "Text only"
                  : schedule.mode === "script"
                    ? "Script (shell command)"
                    : "Reminder"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium">
              {schedule.status === "cancelled"
                ? "Cancelled"
                : schedule.status === "fired"
                  ? "Completed"
                  : schedule.enabled
                    ? "Enabled"
                    : "Paused"}
            </dd>
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
          {schedule.reuseConversation || schedule.quiet ? (
            <div>
              <dt className="text-muted-foreground">Options</dt>
              <dd className="font-medium">
                {[
                  schedule.reuseConversation ? "Reuses conversation" : null,
                  schedule.quiet ? "Quiet" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
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
            <dd className="break-all">
              {schedule.cadenceDescription ? (
                <>
                  {schedule.cadenceDescription}
                  {schedule.schedule.kind === "cron" ? (
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                      {schedule.schedule.expression}
                    </span>
                  ) : null}
                </>
              ) : schedule.schedule.kind === "once"
                ? `once at ${schedule.schedule.at}`
                : schedule.schedule.kind === "cron"
                  ? schedule.schedule.expression
                  : `every ${schedule.schedule.minutes} min`}
            </dd>
          </div>
        </dl>
        {usageSummary ? (
          <div
            className="mt-3 grid grid-cols-2 gap-2"
            data-testid="schedule-detail-usage"
          >
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Coins className="size-3.5 text-muted-foreground shrink-0" />
              <div>
                <div className="font-semibold">
                  {formatScheduleCost(usageSummary.totalEstimatedCostUsd)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  30 Day Cost
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Repeat className="size-3.5 text-muted-foreground shrink-0" />
              <div>
                <div className="font-semibold">
                  {formatScheduleRunCount(usageSummary.runCount)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  30 Day Runs
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            data-testid="schedule-detail-edit"
          >
            Edit
          </Button>
          {onRunNow ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRunNow}
              data-testid="schedule-detail-run-now"
              className="gap-1.5"
            >
              <Play className="size-3.5" />
              Run now
            </Button>
          ) : null}
          {canCancelPending && onCancelOneTime ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onCancelOneTime}
              data-testid="schedule-detail-cancel-once"
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <XCircle className="size-3.5" />
              Cancel reminder
            </Button>
          ) : null}
          {schedule.createdBy === "agent" && schedule.createdFromThreadId ? (
            <a
              href={`/?thread=${encodeURIComponent(schedule.createdFromThreadId)}`}
              data-testid="schedule-detail-created-in-chat"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent"
            >
              Created in chat <ExternalLink className="size-3.5" />
            </a>
          ) : null}
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
                        {r.durationMs != null || r.estimatedCostUsd != null ? (
                          <span className="text-[11px] text-muted-foreground">
                            · {formatDuration(r.durationMs)}
                            {r.estimatedCostUsd != null
                              ? ` · ${formatScheduleCost(r.estimatedCostUsd)}`
                              : ""}
                          </span>
                        ) : null}
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
                  {(r.outputPreview && r.outputPreview.length > 220) ||
                  r.output ||
                  r.error ? (
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
                      {r.output || r.outputPreview ? (
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-xs">
                          {r.output || r.outputPreview}
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
