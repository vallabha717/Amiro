"use client";

import type { ScheduleDraft } from "@/components/schedules/schedule-dialog";
import { apiJson } from "@/lib/backend/client";
import type { Schedule } from "@/lib/backend/schedules-api";
import { cn } from "lib/utils";
import {
  Activity,
  Brain,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Switch } from "ui/switch";

// ---------------------------------------------------------------------------
// Suggested recipes (Vellum offers these instead of seeding schedules)
// ---------------------------------------------------------------------------

export interface ScheduleRecipe {
  id: string;
  emoji: string;
  title: string;
  cadence: string;
  blurb: string;
  needs?: string;
  draft: ScheduleDraft;
}

export const SCHEDULE_RECIPES: ScheduleRecipe[] = [
  {
    id: "morning-briefing",
    emoji: "☀️",
    title: "Morning briefing",
    cadence: "Weekdays at 8:00 AM",
    blurb: "Today's meetings, the emails that matter, the weather, and your focus.",
    needs: "Best with Gmail and Calendar connected",
    draft: {
      name: "Morning briefing",
      mode: "agent",
      cadence: "weekdays",
      time: "08:00",
      prompt:
        "Morning briefing. Using my connected calendar and mail if they're available: list today's meetings with times, the 3 most important unread emails and why they matter, today's weather where I am (see USER.md), and my focus from NOW.md. Keep it skimmable — short headings and bullets, under 200 words. If a connector isn't set up, skip that part and mention once how to connect it.",
    },
  },
  {
    id: "evening-wrap-up",
    emoji: "🌙",
    title: "Evening wrap-up",
    cadence: "Weekdays at 6:00 PM",
    blurb: "What got done, what's still open, and what comes first tomorrow.",
    draft: {
      name: "Evening wrap-up",
      mode: "agent",
      cadence: "weekdays",
      time: "18:00",
      prompt:
        "Evening wrap-up. Review today's conversations and NOW.md: what got done, what's still open, and what should come first tomorrow. Update NOW.md to match and add a short entry to today's journal (journal/<today>.md). Reply with at most 5 bullets.",
    },
  },
  {
    id: "daily-focus",
    emoji: "🎯",
    title: "Daily focus",
    cadence: "Every day at 9:00 AM",
    blurb: "Three concrete focus lines for the day, from what your agent knows.",
    draft: {
      name: "Daily focus",
      mode: "execute",
      cadence: "daily",
      time: "09:00",
      prompt:
        "Write three short focus lines for today based on NOW.md and USER.md: one concrete sentence each, no preamble.",
    },
  },
];

export function SuggestedSchedules({
  schedules,
  onAdd,
}: {
  schedules: Schedule[];
  onAdd: (draft: ScheduleDraft) => void;
}) {
  const taken = new Set(schedules.map((s) => s.name.trim().toLowerCase()));
  const open = SCHEDULE_RECIPES.filter((r) => !taken.has(r.draft.name.toLowerCase()));
  if (!open.length) return null;
  return (
    <section className="flex flex-col gap-3" data-testid="schedules-suggested">
      <div>
        <h2 className="text-sm font-semibold">Suggested</h2>
        <p className="text-xs text-muted-foreground">One click to add. Nothing runs until you do.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {open.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onAdd(r.draft)}
            data-testid={`schedule-recipe-${r.id}`}
            className="group flex flex-col gap-2 rounded-2xl border border-border/60 bg-card p-4 text-left transition-all hover:border-foreground/20 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-lg" aria-hidden>
                {r.emoji}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                <Plus className="size-3" /> Add
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold">{r.title}</p>
              <p className="text-[11px] font-medium text-muted-foreground">{r.cadence}</p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{r.blurb}</p>
            {r.needs && <p className="mt-auto text-[11px] text-muted-foreground/80">{r.needs}</p>}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const MODE_LABEL: Record<string, string> = { agent: "Agent", execute: "Text only", notify: "Reminder" };

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const fmt = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  const text =
    abs < 60_000
      ? "less than a minute"
      : abs < 3_600_000
        ? fmt(Math.round(abs / 60_000), "minute")
        : abs < 86_400_000
          ? fmt(Math.round(abs / 3_600_000), "hour")
          : fmt(Math.round(abs / 86_400_000), "day");
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

function fallbackCadence(s: Schedule): string {
  if (s.schedule.kind === "interval") return `Every ${s.schedule.minutes} minutes`;
  if (s.schedule.kind === "once") return `Once, ${new Date(s.schedule.at).toLocaleString()}`;
  return `Cron: ${s.schedule.expression}`;
}

export function ScheduleListRow({
  schedule: s,
  selected,
  busy,
  onSelect,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const failed = s.lastStatus === "failed";
  const when = s.enabled
    ? s.nextRunAt
      ? new Date(s.nextRunAt).getTime() <= Date.now()
        ? "Due now"
        : `Next ${relativeTime(s.nextRunAt)}`
      : "No upcoming run"
    : "Paused";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      data-testid="schedule-row"
      data-schedule-id={s.id}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 transition-colors",
        selected ? "bg-accent" : "hover:bg-muted/60",
      )}
    >
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Switch
          checked={s.enabled}
          disabled={busy}
          onCheckedChange={onToggle}
          aria-label={s.enabled ? `Pause ${s.name}` : `Resume ${s.name}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("truncate text-sm font-medium", !s.enabled && "text-muted-foreground")}>{s.name}</span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {MODE_LABEL[s.mode] ?? s.mode}
          </span>
          {s.createdBy === "agent" && (
            <span
              className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              data-testid="schedule-created-in-chat"
            >
              Created in chat
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {s.cadenceDescription || fallbackCadence(s)} · {when}
          {s.lastRunAt ? (
            <span className={cn(failed && "text-red-600 dark:text-red-400")}>
              {" "}
              · {failed ? "last run failed" : `ran ${relativeTime(s.lastRunAt)}`}
            </span>
          ) : null}
        </p>
      </div>
      {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex items-center">
        <Button
          size="icon"
          variant="ghost"
          className="size-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onRunNow}
          disabled={busy}
          aria-label={`Run ${s.name} now`}
          title="Run now"
        >
          <Play className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label={`More for ${s.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={onRunNow}>Run now</DropdownMenuItem>
            {s.threadId && (
              <DropdownMenuItem asChild>
                <Link href={`/?thread=${encodeURIComponent(s.threadId)}`}>Open conversation</Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// System tasks (GET /api/schedules/system)
// ---------------------------------------------------------------------------

interface SystemTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  cadence: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  threadId: string | null;
  editable: boolean;
}

const TASK_ICON: Record<string, typeof Activity> = { heartbeat: Activity, memory: Brain };

export function SystemTasks({ canWrite }: { canWrite: boolean }) {
  const { data, mutate } = useSWR<{ tasks: SystemTask[] }>("/api/schedules/system", (u: string) => apiJson(u), {
    shouldRetryOnError: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  if (!data?.tasks?.length) return null;

  const toggleHeartbeat = async (enabled: boolean) => {
    setBusy("heartbeat");
    try {
      await apiJson("/api/agent-home/heartbeat", { method: "PUT", body: JSON.stringify({ enabled }) });
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the heartbeat");
    } finally {
      setBusy(null);
    }
  };
  const runHeartbeat = async () => {
    setBusy("heartbeat");
    try {
      const res = await apiJson<{ result?: string }>("/api/agent-home/heartbeat/run", { method: "POST" });
      toast.success(res?.result === "message" ? "Heartbeat left you a note" : "Heartbeat done — nothing to report");
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Heartbeat failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="schedules-system-tasks">
      <div>
        <h2 className="text-sm font-semibold">System tasks</h2>
        <p className="text-xs text-muted-foreground">Built in. They keep your agent current between conversations.</p>
      </div>
      <div className="divide-y divide-border/60 rounded-2xl border border-border/60 bg-card">
        {data.tasks.map((t) => {
          const Icon = TASK_ICON[t.id] ?? Activity;
          const status =
            t.lastStatus === "message"
              ? "left a note"
              : t.lastStatus === "quiet"
                ? "nothing to report"
                : t.lastStatus === "error"
                  ? "failed"
                  : null;
          return (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3" data-testid={`system-task-${t.id}`}>
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.cadence}
                  {t.enabled && t.nextRunAt
                    ? new Date(t.nextRunAt).getTime() <= Date.now()
                      ? " · due now"
                      : ` · next ${relativeTime(t.nextRunAt)}`
                    : ""}
                  {t.lastRunAt ? ` · ran ${relativeTime(t.lastRunAt)}${status ? `, ${status}` : ""}` : ""}
                </p>
              </div>
              {t.id === "heartbeat" ? (
                <>
                  {t.threadId && (
                    <Button asChild size="sm" variant="ghost" className="h-8 text-xs">
                      <Link href={`/?thread=${encodeURIComponent(t.threadId)}`}>Notes</Link>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    disabled={!canWrite || busy !== null}
                    onClick={runHeartbeat}
                  >
                    {busy === "heartbeat" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Run now
                  </Button>
                  <Switch
                    checked={t.enabled}
                    disabled={!canWrite || busy !== null}
                    onCheckedChange={toggleHeartbeat}
                    aria-label="Heartbeat on or off"
                  />
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">Always on</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent runs across schedules (the page's activity log)
// ---------------------------------------------------------------------------

interface FeedRun {
  scheduleId: string;
  scheduleName: string;
  id: string;
  status: string;
  at: string | null;
  preview: string | null;
  threadId: string | null;
}

const RUN_TONE: Record<string, string> = {
  ok: "bg-emerald-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  error: "bg-red-500",
  interrupted: "bg-amber-500",
  skipped: "bg-muted-foreground/40",
  running: "bg-sky-500 animate-pulse",
};

/**
 * The latest runs of every schedule, newest first: one place to see what ran,
 * what it produced, and what failed. Each row opens that schedule's run log.
 */
export function RecentRuns({
  schedules,
  refreshKey,
  onOpen,
}: {
  schedules: Schedule[];
  refreshKey: number;
  onOpen: (scheduleId: string) => void;
}) {
  const ids = schedules
    .filter((s) => s.lastRunAt)
    .slice(0, 12)
    .map((s) => s.id);
  const { data } = useSWR<FeedRun[]>(
    ids.length ? ["schedule-feed", ids.join(","), refreshKey] : null,
    async () => {
      const lists = await Promise.all(
        ids.map(async (id) => {
          const sc = schedules.find((s) => s.id === id)!;
          try {
            const res = await apiJson<{ runs: any[] }>(`/api/schedules/${encodeURIComponent(id)}/runs`);
            return (res.runs ?? []).slice(0, 5).map(
              (r): FeedRun => ({
                scheduleId: id,
                scheduleName: sc.name,
                id: r.id,
                status: String(r.status ?? ""),
                at: r.finishedAt ?? r.startedAt ?? r.scheduledAt ?? null,
                preview: r.outputPreview ?? r.error ?? null,
                threadId: r.threadId ?? null,
              }),
            );
          } catch {
            return [];
          }
        }),
      );
      return lists
        .flat()
        .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
        .slice(0, 8);
    },
    { revalidateOnFocus: true, keepPreviousData: true },
  );
  if (!ids.length || !data?.length) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="schedules-recent-runs">
      <div>
        <h2 className="text-sm font-semibold">Recent runs</h2>
        <p className="text-xs text-muted-foreground">
          What ran and what came out. Open one for its full log, or ask your agent &ldquo;how did my briefing go?&rdquo;
        </p>
      </div>
      <div className="divide-y divide-border/60 rounded-2xl border border-border/60 bg-card">
        {data.map((r) => (
          <button
            key={`${r.scheduleId}-${r.id}`}
            type="button"
            onClick={() => onOpen(r.scheduleId)}
            className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
            data-testid="schedules-recent-run"
          >
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", RUN_TONE[r.status] ?? "bg-muted-foreground/40")} />
            <div className="min-w-0 flex-1">
              <p className="text-xs">
                <span className="font-medium">{r.scheduleName}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {r.status || "unknown"}
                  {r.at ? ` · ${relativeTime(r.at)}` : ""}
                </span>
              </p>
              {r.preview && <p className="truncate text-xs text-muted-foreground">{r.preview}</p>}
            </div>
            <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground/60" />
          </button>
        ))}
      </div>
    </section>
  );
}
