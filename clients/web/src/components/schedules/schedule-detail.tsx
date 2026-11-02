"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, ExternalLink, Pencil, Play, Sparkles, XCircle } from "lucide-react";

import { Alert, AlertDescription } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "ui/sheet";
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
  isOneShotSchedule,
  isPastOneTimeSchedule,
} from "./schedule-helpers";

function runVariant(status: string) {
  const s = status.toLowerCase();
  if (s === "failed" || s === "error") return "destructive" as const;
  if (s === "ok" || s === "done" || s === "running") return "secondary" as const;
  return "outline" as const;
}

/** The body of the schedule side sheet: what it does, when, and how it went. */
export function ScheduleDetailSheet({
  schedule,
  usageSummary,
  onEdit,
  onRefine,
  onRunNow,
  onCancelOneTime,
  refreshKey,
}: {
  schedule: Schedule;
  usageSummary?: ScheduleUsageSummary | null;
  onEdit: () => void;
  onRefine: () => void;
  onRunNow: () => void;
  onCancelOneTime: () => void;
  /** Bumps when parent observes lastRunAt/lastStatus change or a run-now completes. */
  refreshKey?: number;
}) {
  const t = useTranslations("Schedules");
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
    setLoading((was) => was && runs === null);
    setError(null);
    listScheduleRuns(schedule.id)
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t("runsLoadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule.id, refreshKey, schedule.lastRunAt, schedule.lastStatus]);

  const status =
    schedule.status === "cancelled"
      ? t("whenCancelled")
      : schedule.status === "fired"
        ? t("whenCompleted")
        : schedule.enabled
          ? t("statusOn")
          : t("whenPaused");
  const facts: [string, string][] = [
    [t("whenItRuns"), schedule.cadenceDescription || "—"],
    [t("nextRun"), formatInTimezone(schedule.nextRunAt, schedule.timezone)],
    [t("howItRuns"), t(`modeLong.${schedule.mode}`)],
    [t("status"), status],
  ];
  if (schedule.lastRunAt) facts.push([t("lastRun"), formatInTimezone(schedule.lastRunAt, schedule.timezone)]);
  facts.push([t("timezone"), schedule.timezone]);
  if (schedule.model) facts.push([t("model"), schedule.model]);
  if (usageSummary && usageSummary.runCount > 0) {
    facts.push([t("costLabel"), formatScheduleCost(usageSummary.totalEstimatedCostUsd)]);
    facts.push([t("runsLabel"), usageSummary.runCount.toLocaleString()]);
  }

  return (
    <div data-testid="schedule-detail" className="flex h-full min-h-0 flex-col">
      <SheetHeader className="shrink-0 border-b pr-12">
        <SheetTitle className="break-words">{schedule.name}</SheetTitle>
        <SheetDescription className={schedule.description ? "" : "sr-only"}>
          {schedule.description || t("detailDescription")}
        </SheetDescription>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" className="gap-1.5 rounded-full" onClick={onRunNow} data-testid="schedule-detail-run-now">
            <Play className="size-3.5" />
            {t("runNow")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 rounded-full"
            onClick={onRefine}
            data-testid="schedule-detail-refine"
          >
            <Sparkles className="size-3.5" />
            {t("refineWithAmiro")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 rounded-full"
            onClick={onEdit}
            data-testid="schedule-detail-edit"
          >
            <Pencil className="size-3.5" />
            {t("edit")}
          </Button>
          {canCancelPending ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancelOneTime}
              data-testid="schedule-detail-cancel-once"
              className="gap-1.5 rounded-full text-destructive hover:text-destructive"
            >
              <XCircle className="size-3.5" />
              {t("cancelOneTime")}
            </Button>
          ) : null}
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        <div>
          <h4 className="mb-1 text-xs font-semibold">{t("itsInstructions")}</h4>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-2.5 text-xs leading-relaxed">
            {schedule.mode === "script" ? schedule.script || schedule.prompt : schedule.prompt}
          </p>
        </div>

        <div className="flex flex-wrap gap-3 text-xs font-medium">
          {schedule.threadId ? (
            <a
              href={`/?thread=${encodeURIComponent(schedule.threadId)}`}
              data-testid="schedule-detail-open-thread"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("openConversation")} <ExternalLink className="size-3" />
            </a>
          ) : null}
          {schedule.createdBy === "agent" && schedule.createdFromThreadId ? (
            <a
              href={`/?thread=${encodeURIComponent(schedule.createdFromThreadId)}`}
              data-testid="schedule-detail-created-in-chat"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("createdInChat")} <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>

        <div>
          <h4 className="text-xs font-semibold">{t("runHistory")}</h4>
          <div className="mt-2 space-y-2" data-testid="schedule-runs-list">
            {loading ? (
              <>
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </>
            ) : error ? (
              <Alert variant="destructive" data-testid="schedule-runs-error">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : !runs || runs.length === 0 ? (
              <p
                className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
                data-testid="schedule-runs-empty"
              >
                {t("noRunsYet")}
              </p>
            ) : (
              runs.map((r) => {
                const isExpanded = expandedId === r.id;
                const statusLabel = t.has(`runStatus.${r.status}`) ? t(`runStatus.${r.status}`) : r.status;
                return (
                  <div key={r.id} data-testid={`schedule-run-${r.id}`} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <Badge variant={runVariant(r.status)} className="text-[11px]">
                        {statusLabel}
                      </Badge>
                      <span>{formatInTimezone(r.startedAt ?? r.scheduledAt, schedule.timezone)}</span>
                      {r.durationMs != null ? <span>· {formatDuration(r.durationMs)}</span> : null}
                      {r.estimatedCostUsd != null ? <span>· {formatScheduleCost(r.estimatedCostUsd)}</span> : null}
                      {r.threadId ? (
                        <a
                          href={`/?thread=${encodeURIComponent(r.threadId)}`}
                          data-testid={`schedule-run-open-thread-${r.id}`}
                          className="ml-auto inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          {t("open")} <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
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
                      </div>
                    ) : r.outputPreview ? (
                      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                        {r.outputPreview}
                      </p>
                    ) : r.error ? (
                      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-destructive">
                        {r.error}
                      </p>
                    ) : null}
                    {(r.outputPreview && r.outputPreview.length > 220) || r.output || r.error ? (
                      <button
                        type="button"
                        data-testid={`schedule-run-toggle-${r.id}`}
                        onClick={() => setExpandedId(isExpanded ? null : r.id)}
                        className="mt-1.5 text-xs font-medium text-primary hover:underline"
                      >
                        {isExpanded ? t("showLess") : t("showMore")}
                      </button>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
