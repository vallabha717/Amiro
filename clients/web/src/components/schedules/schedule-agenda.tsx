"use client";

import {
  type AgendaBucket,
  formatInTimezone,
  groupByAgenda,
} from "@/components/schedules/schedule-helpers";
import { templateIcon } from "@/components/schedules/schedule-templates";
import type { Schedule, ScheduleTemplate } from "@/lib/backend/schedules-api";
import { cn } from "lib/utils";
import {
  AlertTriangle,
  BellRing,
  Bot,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Play,
  Sparkles,
  Terminal,
  Type,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Skeleton } from "ui/skeleton";
import { Switch } from "ui/switch";

const MODE_ICON = { agent: Bot, execute: Type, notify: BellRing, script: Terminal };

export interface ScheduleRowActions {
  onSelect: (s: Schedule) => void;
  onToggle: (s: Schedule, enabled: boolean) => void;
  onRunNow: (s: Schedule) => void;
  onEdit: (s: Schedule) => void;
  onDelete: (s: Schedule) => void;
  onRefine: (s: Schedule) => void;
}

export function isFinishedOnce(s: Schedule): boolean {
  return (
    s.schedule.kind === "once" &&
    (s.status === "fired" ||
      s.status === "cancelled" ||
      s.lastStatus === "ok" ||
      s.lastStatus === "failed" ||
      s.lastStatus === "skipped")
  );
}

/** "in 3 hours", "Paused", "Completed": the one thing to know about a row. */
function useWhenLabel() {
  const t = useTranslations("Schedules");
  const format = useFormatter();
  return (s: Schedule) => {
    if (s.status === "cancelled") return t("whenCancelled");
    if (isFinishedOnce(s)) return t("whenCompleted");
    if (!s.enabled) return t("whenPaused");
    if (!s.nextRunAt) return t("whenNoRun");
    const next = new Date(s.nextRunAt);
    return next.getTime() <= Date.now() ? t("whenDue") : format.relativeTime(next, new Date());
  };
}

function ScheduleRow({
  schedule: s,
  template,
  selected,
  busy,
  running,
  actions,
}: {
  schedule: Schedule;
  template?: ScheduleTemplate;
  selected: boolean;
  busy: boolean;
  running: boolean;
  actions: ScheduleRowActions;
}) {
  const t = useTranslations("Schedules");
  const format = useFormatter();
  const when = useWhenLabel();
  const failed = s.lastStatus === "failed";
  const finished = isFinishedOnce(s);
  const Icon = template ? templateIcon(template.icon) : (MODE_ICON[s.mode] ?? Bot);
  return (
    <div
      data-testid="schedule-row"
      data-schedule-id={s.id}
      className={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
        selected ? "bg-accent" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={() => actions.onSelect(s)}
        data-testid={`schedule-row-select-${s.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          data-testid={`schedule-row-${s.id}`}
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg",
            s.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate text-sm font-medium", !s.enabled && "text-muted-foreground")}>
              {s.name}
            </span>
            {s.createdBy === "agent" ? (
              <span
                className="hidden shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary sm:inline"
                data-testid="schedule-created-in-chat"
              >
                {t("createdInChat")}
              </span>
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground sm:hidden">{when(s)} · </span>
            {s.cadenceDescription || s.prompt}
            {" · "}
            {t(`mode.${s.mode}`)}
          </span>
        </span>
        <span className="hidden shrink-0 flex-col items-end text-xs sm:flex">
          <span className="flex items-center gap-1 font-medium">
            {running ? <Loader2 className="size-3 animate-spin" /> : null}
            {running ? t("runStatus.running") : when(s)}
          </span>
          {s.lastRunAt ? (
            <span className={cn("text-[11px] text-muted-foreground", failed && "text-red-600 dark:text-red-400")}>
              {failed
                ? t("lastRunFailed")
                : t("lastRanAgo", { when: format.relativeTime(new Date(s.lastRunAt), new Date()) })}
            </span>
          ) : s.enabled && s.nextRunAt ? (
            <span className="text-[11px] text-muted-foreground">
              {formatInTimezone(s.nextRunAt, s.timezone)}
            </span>
          ) : null}
        </span>
      </button>
      {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
      <Switch
        checked={s.enabled}
        disabled={busy || finished}
        onCheckedChange={(enabled) => actions.onToggle(s, enabled)}
        data-testid={`schedule-toggle-${s.id}`}
        aria-label={
          finished
            ? t("toggleFinished", { name: s.name })
            : s.enabled
              ? t("togglePause", { name: s.name })
              : t("toggleResume", { name: s.name })
        }
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={t("moreFor", { name: s.name })}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy} onClick={() => actions.onRunNow(s)} data-testid={`schedule-run-now-${s.id}`}>
            <Play className="size-3.5" />
            {t("runNow")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.onRefine(s)} data-testid={`schedule-refine-${s.id}`}>
            <Sparkles className="size-3.5" />
            {t("refineWithAmiro")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.onEdit(s)} data-testid={`schedule-edit-${s.id}`}>
            {t("edit")}
          </DropdownMenuItem>
          {s.threadId ? (
            <DropdownMenuItem asChild>
              <Link href={`/?thread=${encodeURIComponent(s.threadId)}`}>{t("openConversation")}</Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="text-red-600 focus:text-red-600"
            onClick={() => actions.onDelete(s)}
            data-testid={`schedule-delete-${s.id}`}
          >
            {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground/50 sm:block" />
    </div>
  );
}

/** The user's schedules as an agenda: what needs attention, then what runs next. */
export function ScheduleAgenda({
  schedules,
  templates,
  selectedId,
  busyId,
  runningIds,
  actions,
}: {
  schedules: Schedule[];
  templates: ScheduleTemplate[];
  selectedId: string | null;
  busyId: string | null;
  /** Schedules whose Run now is still going in the background. */
  runningIds: string[];
  actions: ScheduleRowActions;
}) {
  const t = useTranslations("Schedules");
  const [pastOpen, setPastOpen] = useState(false);
  const failing = schedules.filter((s) => s.lastStatus === "failed" && s.enabled);
  const rest = schedules.filter((s) => !failing.includes(s));
  const row = (s: Schedule) => (
    <ScheduleRow
      key={s.id}
      schedule={s}
      template={templates.find((x) => x.id === s.templateId)}
      selected={selectedId === s.id}
      busy={busyId === s.id}
      running={runningIds.includes(s.id) || s.status === "firing"}
      actions={actions}
    />
  );
  return (
    <div className="flex flex-col gap-5" data-testid="schedules-list">
      {failing.length > 0 ? (
        <section
          className="rounded-2xl border border-red-500/30 bg-red-500/[0.04] p-1.5"
          data-testid="schedules-attention"
          aria-label={t("needsAttention")}
        >
          <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-xs font-semibold text-red-700 dark:text-red-400">
            <AlertTriangle className="size-3.5" />
            {t("needsAttention")}
          </h3>
          {failing.map((s) => (
            <div key={s.id}>
              {row(s)}
              <div className="px-3 pb-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 rounded-full text-xs"
                  onClick={() => actions.onRefine(s)}
                  data-testid={`schedule-fix-${s.id}`}
                >
                  <Sparkles className="size-3" />
                  {t("askAmiroToFix")}
                </Button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {groupByAgenda(rest).map(({ bucket, items }) => (
        <AgendaSection
          key={bucket}
          bucket={bucket}
          count={items.length}
          collapsed={bucket === "past" && !pastOpen}
          onToggle={bucket === "past" ? () => setPastOpen((v) => !v) : undefined}
        >
          {items.map(row)}
        </AgendaSection>
      ))}
    </div>
  );
}

function AgendaSection({
  bucket,
  count,
  collapsed,
  onToggle,
  children,
}: {
  bucket: AgendaBucket;
  count: number;
  collapsed: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("Schedules");
  const label = (
    <>
      {t(`agenda.${bucket}`)}
      <span className="font-normal">{count}</span>
    </>
  );
  return (
    <section data-testid={`schedules-agenda-${bucket}`}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          data-testid="schedules-past-toggle"
          className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
          {label}
        </button>
      ) : (
        <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">{label}</h3>
      )}
      {collapsed ? null : <div className="rounded-2xl border border-border/60 bg-card p-1.5">{children}</div>}
    </section>
  );
}

export function ScheduleAgendaSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-16 rounded-2xl" />
      <Skeleton className="h-16 rounded-2xl" />
    </div>
  );
}
