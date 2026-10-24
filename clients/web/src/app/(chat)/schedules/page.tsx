"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  ChevronRight,
  Plus,
  Search,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { Input } from "ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { useSession } from "@/lib/backend/session-context";
import {
  cancelSchedule,
  deleteSchedule,
  fetchScheduleUsageSummaries,
  listSchedules,
  reassignScheduleModel,
  runScheduleNow,
  updateSchedule,
} from "@/lib/backend/schedules-api";
import type {
  Schedule,
  ScheduleUsageSummary,
} from "@/lib/backend/schedules-api";
import {
  groupSchedules,
  isPastOneTimeSchedule,
} from "@/components/schedules/schedule-helpers";
import { useChatModels } from "@/hooks/queries/use-chat-models";
import { appStore } from "@/app/store";
import { useTranslations } from "next-intl";
import { handleErrorWithToast } from "ui/shared-toast";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog";
import { ScheduleCardSkeleton } from "@/components/schedules/schedule-row";
import { RecentRuns, ScheduleListRow, SuggestedSchedules, SystemTasks } from "@/components/schedules/schedule-list";
import { ScheduleDialog, type ScheduleDraft } from "@/components/schedules/schedule-dialog";
import { ScheduleDetailSheet } from "@/components/schedules/schedule-detail";

type StatusFilter = "all" | "active" | "paused" | "failed";

export default function SchedulesPage() {
  const { data: session } = useSession();
  const t = useTranslations("Schedules");
  const { data: modelProviders } = useChatModels();
  const chatModel = appStore((s) => s.chatModel);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [usageSummaries, setUsageSummaries] = useState<
    Record<string, ScheduleUsageSummary>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [pastOpen, setPastOpen] = useState(true);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [rebasing, setRebasing] = useState(false);

  const defaultModelRoute = useMemo(() => {
    if (chatModel?.provider && chatModel?.model) {
      return `${chatModel.provider}:${chatModel.model}`;
    }
    const first = (modelProviders ?? []).find(
      (p) => p.models && p.models.length > 0,
    );
    return first ? `${first.provider}:${first.models[0].name}` : null;
  }, [chatModel, modelProviders]);

  const offDefaultCount = useMemo(() => {
    if (!defaultModelRoute || !schedules) return 0;
    return schedules.filter(
      (s) =>
        (s.mode === "agent" || s.mode === "execute") &&
        !isPastOneTimeSchedule(s) &&
        s.model !== defaultModelRoute,
    ).length;
  }, [defaultModelRoute, schedules]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [list, summaries] = await Promise.all([
        listSchedules(),
        fetchScheduleUsageSummaries().catch(() => []),
      ]);
      setSchedules(list);
      const map: Record<string, ScheduleUsageSummary> = {};
      for (const s of summaries) {
        map[s.scheduleId] = s;
      }
      setUsageSummaries(map);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load schedules.";
      setError(msg);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void refresh();
  }, [session, refresh]);

  // Poll while any schedule is in a running state or a run-now is in flight,
  // so timer ticks and history/output appear without manual refresh.
  const isPollingNeeded = useMemo(() => {
    if (busyId) return true;
    if (!schedules) return false;
    return schedules.some((s) => {
      const st = (s.lastStatus ?? "").toLowerCase();
      return st === "running";
    });
  }, [schedules, busyId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!isPollingNeeded) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshRef.current();
      setDetailRefresh((n) => n + 1);
    }, 3000);
    return () => window.clearInterval(id);
  }, [isPollingNeeded]);

  // Keep selection valid after delete/refresh
  useEffect(() => {
    if (!schedules) return;
    if (selectedId && !schedules.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }, [schedules, selectedId]);

  const filtered = useMemo(() => {
    if (!schedules) return [];
    const q = query.trim().toLowerCase();
    return schedules.filter((s) => {
      if (q) {
        const hay = `${s.name} ${s.prompt} ${s.timezone} ${s.model ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (status === "active" && !s.enabled) return false;
      if (status === "paused" && s.enabled) return false;
      if (status === "failed" && s.lastStatus !== "failed") return false;
      return true;
    });
  }, [schedules, query, status]);

  const selected = useMemo(
    () => (selectedId ? (schedules ?? []).find((s) => s.id === selectedId) ?? null : null),
    [schedules, selectedId],
  );

  const grouped = useMemo(() => groupSchedules(filtered), [filtered]);

  const handleCancelOneTime = async (s: Schedule) => {
    setBusyId(s.id);
    try {
      const updated = await cancelSchedule(s.id);
      setSchedules((prev) =>
        (prev ?? []).map((x) => (x.id === s.id ? updated : x)),
      );
      setDetailRefresh((n) => n + 1);
      toast.success("One-time schedule cancelled");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (s: Schedule, enabled: boolean) => {
    setBusyId(s.id);
    try {
      const updated = await updateSchedule(s.id, { enabled });
      setSchedules((prev) => (prev ?? []).map((x) => (x.id === s.id ? updated : x)));
      toast.success(enabled ? "Schedule resumed" : "Schedule paused");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (s: Schedule) => {
    setBusyId(s.id);
    try {
      const { schedule: updated } = await runScheduleNow(s.id);
      setSchedules((prev) => (prev ?? []).map((x) => (x.id === s.id ? updated : x)));
      setDetailRefresh((n) => n + 1);
      toast.success("Schedule triggered");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await deleteSchedule(deleting.id);
      setSchedules((prev) => (prev ?? []).filter((x) => x.id !== deleting.id));
      if (selectedId === deleting.id) setSelectedId(null);
      toast.success("Schedule deleted");
      setDeleting(null);
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setBusyId(null);
    }
  };

  const handleRebaseModels = async () => {
    if (!defaultModelRoute) return;
    setRebasing(true);
    try {
      const res = await reassignScheduleModel({ to: defaultModelRoute });
      await refresh();
      setRebaseOpen(false);
      toast.success(
        res.reassigned === 0
          ? `All schedules already use ${defaultModelRoute}`
          : `Moved ${res.reassigned} schedule(s) to ${defaultModelRoute}`,
      );
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setRebasing(false);
    }
  };

  if (!session) return null;

  const isLoading = schedules === null && !error;

  const openCreate = (draft: ScheduleDraft | null = null) => {
    setEditing(null);
    setDraft(draft);
    setDialogOpen(true);
  };
  const canWrite = session.user.role === "admin";
  const showSearch = (schedules?.length ?? 0) > 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 sm:p-8" data-testid="schedules-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-brand text-2xl font-bold tracking-tight sm:text-[28px]">Schedules</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Your agent works on its own, on a cadence. Results land in each schedule&apos;s conversation. You can also
            just ask it: &ldquo;remind me every Monday at 9 to plan the week.&rdquo;
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => openCreate()}
          data-testid="schedules-create-button"
          className="shrink-0 gap-1.5 rounded-full px-4 font-medium"
        >
          <Plus className="size-4" />
          New schedule
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid="schedules-error">
          <AlertCircle className="size-4" />
          <AlertTitle>Could not load schedules</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()} data-testid="schedules-retry-button">
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {schedules ? <SuggestedSchedules schedules={schedules} onAdd={(d) => openCreate(d)} /> : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">
            Your schedules
            {schedules && schedules.length > 0 ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">{schedules.length}</span>
            ) : null}
          </h2>
          {showSearch ? (
            <div className="flex flex-wrap items-center gap-2">
              {canWrite && defaultModelRoute && offDefaultCount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRebaseOpen(true)}
                  data-testid="schedules-rebase-model-button"
                  className="h-8 rounded-full text-xs"
                >
                  {t("useModelForAll", { model: defaultModelRoute })}
                </Button>
              ) : null}
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search schedules"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-8 w-56 rounded-full pl-8 text-xs"
                  data-testid="schedules-search-input"
                  aria-label="Search schedules"
                />
              </div>
              <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <SelectTrigger className="h-8 w-[140px] rounded-full text-xs" data-testid="schedules-status-filter" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">On</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="failed">Last failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        {isLoading ? (
          <div className="grid gap-3">
            <ScheduleCardSkeleton />
            <ScheduleCardSkeleton />
          </div>
        ) : !schedules || schedules.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card/60 px-6 py-10 text-center"
            data-testid="schedules-empty"
          >
            <CalendarClock className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No schedules yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Add a suggestion above, ask your agent in chat, or create one yourself.
            </p>
            <Button size="sm" variant="outline" className="mt-2 rounded-full" onClick={() => openCreate()} data-testid="schedules-empty-create-button">
              <Plus className="size-4" /> New schedule
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-border/60 p-8 text-center text-sm text-muted-foreground" data-testid="schedules-no-results">
            No schedules match.{" "}
            <button type="button" className="underline" onClick={() => { setQuery(""); setStatus("all"); }} data-testid="schedules-clear-filters-button">
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="min-w-0 self-start rounded-2xl border border-border/60 bg-card p-1.5" data-testid="schedules-list">
              {grouped.recurring.map((sc) => (
                <ScheduleListRow
                  key={sc.id}
                  schedule={sc}
                  usageSummary={usageSummaries[sc.id]}
                  selected={selectedId === sc.id}
                  busy={busyId === sc.id}
                  onSelect={() => setSelectedId(sc.id)}
                  onToggle={(enabled) => void handleToggle(sc, enabled)}
                  onRunNow={() => void handleRunNow(sc)}
                  onEdit={() => {
                    setEditing(sc);
                    setDraft(null);
                    setDialogOpen(true);
                  }}
                  onDelete={() => setDeleting(sc)}
                />
              ))}
              {grouped.upcomingOneTime.length > 0 ? (
                <div className={grouped.recurring.length > 0 ? "mt-2 border-t border-border/60 pt-2" : ""}>
                  {grouped.recurring.length > 0 ? (
                    <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      One-time
                    </div>
                  ) : null}
                  {grouped.upcomingOneTime.map((sc) => (
                    <ScheduleListRow
                      key={sc.id}
                      schedule={sc}
                      usageSummary={usageSummaries[sc.id]}
                      selected={selectedId === sc.id}
                      busy={busyId === sc.id}
                      onSelect={() => setSelectedId(sc.id)}
                      onToggle={(enabled) => void handleToggle(sc, enabled)}
                      onRunNow={() => void handleRunNow(sc)}
                      onEdit={() => {
                        setEditing(sc);
                        setDraft(null);
                        setDialogOpen(true);
                      }}
                      onDelete={() => setDeleting(sc)}
                    />
                  ))}
                </div>
              ) : null}
              {grouped.pastOneTime.length > 0 ? (
                <div className="mt-2 border-t border-border/60 pt-1">
                  <button
                    type="button"
                    data-testid="schedules-past-toggle"
                    onClick={() => setPastOpen((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight
                      className={`size-3.5 transition-transform ${pastOpen ? "rotate-90" : ""}`}
                    />
                    <span>Past ({grouped.pastOneTime.length})</span>
                  </button>
                  {pastOpen
                    ? grouped.pastOneTime.map((sc) => (
                        <ScheduleListRow
                          key={sc.id}
                          schedule={sc}
                          usageSummary={usageSummaries[sc.id]}
                          selected={selectedId === sc.id}
                          busy={busyId === sc.id}
                          onSelect={() => setSelectedId(sc.id)}
                          onToggle={(enabled) => void handleToggle(sc, enabled)}
                          onRunNow={() => void handleRunNow(sc)}
                          onEdit={() => {
                            setEditing(sc);
                            setDraft(null);
                            setDialogOpen(true);
                          }}
                          onDelete={() => setDeleting(sc)}
                        />
                      ))
                    : null}
                </div>
              ) : null}
            </div>
            <div className="min-w-0 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden">
              {selected ? (
                <ScheduleDetailSheet
                  schedule={selected}
                  usageSummary={usageSummaries[selected.id]}
                  onClose={() => setSelectedId(null)}
                  onEdit={() => {
                    setEditing(selected);
                    setDraft(null);
                    setDialogOpen(true);
                  }}
                  onRunNow={() => void handleRunNow(selected)}
                  onCancelOneTime={() => void handleCancelOneTime(selected)}
                  refreshKey={detailRefresh}
                />
              ) : (
                <div className="hidden min-h-[240px] flex-col items-center justify-center rounded-2xl border border-dashed border-border p-8 text-center lg:flex" data-testid="schedules-detail-empty">
                  <CalendarClock className="size-7 text-muted-foreground/60" />
                  <p className="mt-3 text-sm font-medium">Pick a schedule</p>
                  <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                    See its next run, its run history and what it produced.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {schedules && schedules.length > 0 ? (
        <RecentRuns schedules={schedules} refreshKey={detailRefresh} onOpen={(id) => setSelectedId(id)} />
      ) : null}

      <SystemTasks canWrite={canWrite} />

      <p className="text-[11px] text-muted-foreground" data-testid="schedules-daemon-notice">
        Schedules run while Amiro is running. If it was off, recurring schedules pick up at their next time and a
        missed one-time schedule runs once on start.
      </p>

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditing(null);
        }}
        schedule={editing}
        initial={draft}
        onSaved={() => void refresh()}
      />

      <AlertDialog open={rebaseOpen} onOpenChange={setRebaseOpen}>
        <AlertDialogContent data-testid="schedule-rebase-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("moveSchedulesTitle", { model: defaultModelRoute ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("moveSchedulesDescription", {
                count: offDefaultCount,
                model: defaultModelRoute ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={rebasing}
              onClick={() => setRebaseOpen(false)}
              data-testid="schedule-rebase-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={rebasing}
              onClick={() => void handleRebaseModels()}
              data-testid="schedule-rebase-confirm"
            >
              {t("moveSchedulesConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent data-testid="schedule-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">{deleting?.name}</span>.
              Runs already created are kept, but no further runs will fire.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setDeleting(null)}
              data-testid="schedule-delete-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              data-testid="schedule-delete-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
