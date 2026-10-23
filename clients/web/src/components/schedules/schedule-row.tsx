"use client";

import {
  AlertCircle,
  CalendarClock,
  Clock3,
  Edit2,
  Pause,
  PlayCircle,
  Trash2,
} from "lucide-react";

import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card } from "ui/card";
import { Skeleton } from "ui/skeleton";
import { Switch } from "ui/switch";
import type { Schedule } from "@/lib/backend/schedules-api";
import { formatInTimezone } from "./schedule-helpers";

function friendlyScheduleSummary(s: Schedule): string {
  const k = s.schedule;
  if (k.kind === "once") return `Once at ${formatInTimezone(k.at, s.timezone)}`;
  if (k.kind === "interval") {
    if (k.minutes % 1440 === 0) return `Every ${k.minutes / 1440} day(s)`;
    if (k.minutes % 60 === 0) return `Every ${k.minutes / 60} hour(s)`;
    return `Every ${k.minutes} min`;
  }
  // cron: try to render friendly preset labels for the ones we generate
  const expr = k.expression.trim();
  const parts = expr.split(/\s+/);
  if (parts.length === 5) {
    const [mmS, hhS, dom, mon, dow] = parts;
    // only render friendly label when the preset used plain numeric fields
    const isSimpleNumeric = /^\d+$/.test(mmS) && /^\d+$/.test(hhS);
    if (isSimpleNumeric) {
      const hh = Number(hhS);
      const mm = Number(mmS);
      const pad = (n: number) => String(n).padStart(2, "0");
      const time = `${pad(hh)}:${pad(mm)}`;
      if (dom === "*" && mon === "*" && dow === "*") return `Every day at ${time}`;
      if (dom === "*" && mon === "*" && dow === "1-5") return `Weekdays at ${time}`;
      if (dom === "*" && mon === "*" && /^\d$/.test(dow)) {
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return `Every ${days[Number(dow)] ?? dow} at ${time}`;
      }
      if (dom !== "*" && mon === "*" && dow === "*" && /^\d+$/.test(dom)) return `Monthly on day ${dom} at ${time}`;
    }
  }
  return `Cron ${expr}`;
}

function isCompletedOnce(s: Schedule): boolean {
  // One-shot that has already produced a terminal run is complete, not paused
  if (s.schedule.kind !== "once") return false;
  return s.lastStatus === "ok" || s.lastStatus === "failed" || s.lastStatus === "skipped";
}

export function statusDot(lastStatus: Schedule["lastStatus"]) {
  if (lastStatus === "ok") return "bg-emerald-500";
  if (lastStatus === "failed") return "bg-destructive";
  if (lastStatus === "skipped") return "bg-amber-500";
  return "bg-muted-foreground/40";
}

export function ScheduleCardSkeleton() {
  return (
    <Card className="p-4 py-4">
      <div className="flex gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
    </Card>
  );
}

export function ScheduleRowCard({
  schedule,
  selected,
  onSelect,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  selected?: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const completedOnce = isCompletedOnce(schedule);
  const isPaused = !schedule.enabled && !completedOnce;

  return (
    <Card
      data-testid={`schedule-row-${schedule.id}`}
      className={`group relative overflow-hidden p-4 py-4 transition-all duration-150 ${selected ? "border-primary/40 bg-accent/40 shadow-sm" : "hover:bg-accent/30 hover:border-border/80"} ${isPaused ? "opacity-[0.96]" : ""}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border ${isPaused ? "bg-muted text-muted-foreground border-border" : "bg-primary/10 text-primary border-primary/15"}`}
          aria-hidden="true"
        >
          <CalendarClock className="size-4" />
        </div>

        <button
          type="button"
          data-testid={`schedule-row-select-${schedule.id}`}
          onClick={onSelect}
          className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md -m-1 p-1"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold leading-none max-w-[14rem] sm:max-w-[22rem]">
              {schedule.name}
            </span>
            {completedOnce ? (
              <Badge
                variant="secondary"
                className="shrink-0 text-[11px] font-medium"
                data-testid={`schedule-badge-completed-${schedule.id}`}
              >
                Completed
              </Badge>
            ) : isPaused ? (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 py-0 text-[11px] font-medium max-w-[7rem] truncate"
                data-testid={`schedule-badge-paused-${schedule.id}`}
              >
                <Pause className="size-3" /> Paused
              </Badge>
            ) : null}
            <Badge
              variant="secondary"
              className="shrink-0 text-[11px] font-medium max-w-[10rem] truncate"
              data-testid={`schedule-badge-mode-${schedule.id}`}
              title={schedule.mode === "execute" ? "Execute" : "In-app reminder"}
            >
              {schedule.mode === "execute" ? "Execute" : "In-app reminder"}
            </Badge>
            {schedule.lastStatus ? (
              <span
                className={`size-2 shrink-0 rounded-full ${statusDot(schedule.lastStatus)}`}
                aria-hidden="true"
                title={schedule.lastStatus}
                data-testid={`schedule-last-status-${schedule.id}`}
              />
            ) : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 min-w-0">
              <Clock3 className="size-3.5 opacity-70 shrink-0" />
              <span className="truncate">{friendlyScheduleSummary(schedule)}</span>
            </span>
            <span className="inline-flex items-center gap-1 min-w-0">
              <span className="truncate">Next: {formatInTimezone(schedule.nextRunAt, schedule.timezone)}</span>
            </span>
            <span className="inline-flex items-center gap-1 truncate max-w-[12rem]" title={schedule.timezone}>
              {schedule.timezone}
            </span>
            {schedule.model ? (
              <span
                className="max-w-[10rem] sm:max-w-[14rem] truncate"
                title={schedule.model}
                data-testid={`schedule-model-${schedule.id}`}
              >
                {schedule.model}
              </span>
            ) : null}
          </div>

          <div className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground/90 break-words">
            {schedule.prompt}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={schedule.enabled}
            disabled={completedOnce}
            onCheckedChange={onToggle}
            aria-label={
              completedOnce
                ? `${schedule.name} is completed`
                : schedule.enabled
                  ? `Pause ${schedule.name}`
                  : `Resume ${schedule.name}`
            }
            data-testid={`schedule-toggle-${schedule.id}`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onRunNow}
          data-testid={`schedule-run-now-${schedule.id}`}
          className="h-8 gap-1.5"
        >
          <PlayCircle className="size-3.5" />
          Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          data-testid={`schedule-edit-${schedule.id}`}
          className="h-8 gap-1.5"
        >
          <Edit2 className="size-3.5" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          data-testid={`schedule-delete-${schedule.id}`}
          className="h-8 gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
        {schedule.threadId ? (
          <a
            href={`/?thread=${encodeURIComponent(schedule.threadId)}`}
            data-testid={`schedule-open-thread-${schedule.id}`}
            className="ml-auto inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            Open conversation
          </a>
        ) : null}
      </div>

      {schedule.lastStatus === "failed" ? (
        <div
          className="mt-3 flex items-center gap-1.5 rounded-md border border-destructive/20 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          data-testid={`schedule-last-failed-${schedule.id}`}
        >
          <AlertCircle className="size-3.5 shrink-0" />
          Last run failed
          {schedule.lastRunAt ? ` at ${formatInTimezone(schedule.lastRunAt, schedule.timezone)}` : ""}
        </div>
      ) : null}
    </Card>
  );
}

export function EmptySchedules({
  onCreate,
}: {
  onCreate: () => void;
}) {
  return (
    <Card className="border-dashed p-8 text-center" data-testid="schedules-empty">
      <div className="mx-auto flex max-w-md flex-col items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CalendarClock className="size-6" />
        </div>
        <h3 className="text-base font-semibold">No schedules yet</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Create a schedule to run your agent on a cadence: daily briefings,
          weekly reviews, reminders, or any prompt. In-app reminders notify
          you; execute tasks run the agent for real.
        </p>
        <Button
          onClick={onCreate}
          data-testid="schedules-empty-create-button"
          className="mt-1"
        >
          Create schedule
        </Button>
      </div>
    </Card>
  );
}

export function SchedulesToolbarSkeleton() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Skeleton className="h-9 w-full sm:max-w-sm" />
      <Skeleton className="h-9 w-32" />
      <Skeleton className="h-9 w-32" />
    </div>
  );
}
