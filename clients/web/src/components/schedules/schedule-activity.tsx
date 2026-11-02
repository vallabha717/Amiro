"use client";

import { apiJson } from "@/lib/backend/client";
import type { Schedule } from "@/lib/backend/schedules-api";
import { cn } from "lib/utils";
import { Activity, Brain, ChevronRight, History, Loader2, Play } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "ui/button";
import { Switch } from "ui/switch";

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
  const t = useTranslations("Schedules");
  const format = useFormatter();
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
      toast.error(e instanceof Error ? e.message : t("heartbeatUpdateFailed"));
    } finally {
      setBusy(null);
    }
  };
  const runHeartbeat = async () => {
    setBusy("heartbeat");
    try {
      const res = await apiJson<{ result?: string }>("/api/agent-home/heartbeat/run", { method: "POST" });
      toast.success(res?.result === "message" ? t("heartbeatNote") : t("heartbeatQuiet"));
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("heartbeatFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="schedules-system-tasks">
      <div>
        <h2 className="text-sm font-semibold">{t("systemTasks")}</h2>
        <p className="text-xs text-muted-foreground">{t("systemTasksHint")}</p>
      </div>
      <div className="divide-y divide-border/60 rounded-2xl border border-border/60 bg-card">
        {data.tasks.map((task) => {
          const Icon = TASK_ICON[task.id] ?? Activity;
          const status =
            task.lastStatus === "message"
              ? t("taskLeftNote")
              : task.lastStatus === "quiet"
                ? t("taskQuiet")
                : task.lastStatus === "error"
                  ? t("taskFailed")
                  : null;
          return (
            <div key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`system-task-${task.id}`}>
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p className="text-sm font-medium">{task.name}</p>
                <p className="text-xs text-muted-foreground">
                  {task.cadence}
                  {task.lastRunAt
                    ? ` · ${t("lastRanAgo", { when: format.relativeTime(new Date(task.lastRunAt), new Date()) })}${status ? `, ${status}` : ""}`
                    : ""}
                </p>
              </div>
              {task.id === "heartbeat" ? (
                <div className="flex items-center gap-1">
                  {task.threadId ? (
                    <Button asChild size="sm" variant="ghost" className="h-8 text-xs">
                      <Link href={`/?thread=${encodeURIComponent(task.threadId)}`}>{t("notes")}</Link>
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    disabled={!canWrite || busy !== null}
                    onClick={runHeartbeat}
                  >
                    {busy === "heartbeat" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    {t("runNow")}
                  </Button>
                  <Switch
                    checked={task.enabled}
                    disabled={!canWrite || busy !== null}
                    onCheckedChange={toggleHeartbeat}
                    aria-label={t("heartbeatToggle")}
                  />
                </div>
              ) : (
                <span className="text-[11px] text-muted-foreground">{t("alwaysOn")}</span>
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
  const t = useTranslations("Schedules");
  const format = useFormatter();
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
        .slice(0, 12);
    },
    { revalidateOnFocus: true, keepPreviousData: true },
  );
  return (
    <section className="flex flex-col gap-2" data-testid="schedules-recent-runs">
      <div>
        <h2 className="text-sm font-semibold">{t("recentRuns")}</h2>
        <p className="text-xs text-muted-foreground">{t("recentRunsHint")}</p>
      </div>
      {!ids.length || !data?.length ? (
        <div
          className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-6 py-8 text-center"
          data-testid="schedules-recent-runs-empty"
        >
          <History className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{t("recentRunsEmpty")}</p>
        </div>
      ) : (
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
              <span className="min-w-0 flex-1">
                <span className="block text-xs">
                  <span className="font-medium">{r.scheduleName}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {t.has(`runStatus.${r.status}`) ? t(`runStatus.${r.status}`) : r.status}
                    {r.at ? ` · ${format.relativeTime(new Date(r.at), new Date())}` : ""}
                  </span>
                </span>
                {r.preview ? <span className="block truncate text-xs text-muted-foreground">{r.preview}</span> : null}
              </span>
              <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
