"use client";

import { appStore } from "@/app/store";
import { RecentRuns, SystemTasks } from "@/components/schedules/schedule-activity";
import {
  ScheduleAgenda,
  ScheduleAgendaSkeleton,
  type ScheduleRowActions,
} from "@/components/schedules/schedule-agenda";
import { ScheduleDetailSheet } from "@/components/schedules/schedule-detail";
import { ScheduleDialog, type ScheduleDraft } from "@/components/schedules/schedule-dialog";
import { isPastOneTimeSchedule } from "@/components/schedules/schedule-helpers";
import { ScheduleTemplates } from "@/components/schedules/schedule-templates";
import { useChatModels } from "@/hooks/queries/use-chat-models";
import { useSession } from "@/lib/backend/session-context";
import type {
  Schedule,
  ScheduleTemplate,
  ScheduleUsageSummary,
} from "@/lib/backend/schedules-api";
import {
  cancelSchedule,
  deleteSchedule,
  fetchScheduleUsageSummaries,
  listSchedules,
  listScheduleTemplates,
  reassignScheduleModel,
  runScheduleNow,
  updateSchedule,
} from "@/lib/backend/schedules-api";
import { cn } from "lib/utils";
import { AlertCircle, ArrowUp, CalendarClock, Plus, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
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
import { Button } from "ui/button";
import { Input } from "ui/input";
import { handleErrorWithToast } from "ui/shared-toast";
import { Sheet, SheetContent } from "ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";

type Tab = "yours" | "templates" | "activity";
const TABS: Tab[] = ["yours", "templates", "activity"];
const FILTERS = ["all", "active", "paused", "failed"] as const;
type StatusFilter = (typeof FILTERS)[number];

function tabFromUrl(): Tab | null {
  if (typeof window === "undefined") return null;
  const tab = new URLSearchParams(window.location.search).get("tab");
  return TABS.includes(tab as Tab) ? (tab as Tab) : null;
}

export function SchedulesPage() {
  const { data: session } = useSession();
  const t = useTranslations("Schedules");
  const format = useFormatter();
  const router = useRouter();
  const { data: modelProviders } = useChatModels();
  const { data: templates } = useSWR("/api/schedules/templates", listScheduleTemplates, {
    revalidateOnFocus: false,
  });
  const chatModel = appStore((s) => s.chatModel);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [usageSummaries, setUsageSummaries] = useState<Record<string, ScheduleUsageSummary>>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [ask, setAsk] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [rebasing, setRebasing] = useState(false);

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const defaultModelRoute = useMemo(() => {
    if (chatModel?.provider && chatModel?.model) {
      return `${chatModel.provider}:${chatModel.model}`;
    }
    const first = (modelProviders ?? []).find((p) => p.models && p.models.length > 0);
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
      setError(e instanceof Error ? e.message : t("loadError"));
    }
  }, [t]);

  useEffect(() => {
    if (!session) return;
    void refresh();
  }, [session, refresh]);

  // Someone with no schedules yet starts on the templates; the URL wins otherwise.
  const hasNone = schedules?.length === 0;
  useEffect(() => {
    if (schedules === null) return;
    setTabState((current) => current ?? tabFromUrl() ?? (hasNone ? "templates" : "yours"));
  }, [schedules, hasNone]);

  // Poll while any schedule is in a running state or a run-now is in flight,
  // so timer ticks and history/output appear without manual refresh.
  const isPollingNeeded = useMemo(() => {
    if (busyId) return true;
    if (!schedules) return false;
    return schedules.some((s) => (s.lastStatus ?? "").toLowerCase() === "running");
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

  const counts = useMemo(() => {
    const list = schedules ?? [];
    return {
      all: list.length,
      active: list.filter((s) => s.enabled).length,
      paused: list.filter((s) => !s.enabled).length,
      failed: list.filter((s) => s.lastStatus === "failed").length,
    };
  }, [schedules]);

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

  const nextUp = useMemo(() => {
    const upcoming = (schedules ?? []).filter((s) => s.enabled && s.nextRunAt);
    return upcoming.sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))[0] ?? null;
  }, [schedules]);

  const selected = useMemo(
    () => (selectedId ? ((schedules ?? []).find((s) => s.id === selectedId) ?? null) : null),
    [schedules, selectedId],
  );

  if (!session) return null;

  const replace = (updated: Schedule) =>
    setSchedules((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));

  /** Busy spinner + error toast around one schedule's action. */
  const withBusy = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = () => {
    if (!deleting) return;
    const target = deleting;
    void withBusy(target.id, async () => {
      await deleteSchedule(target.id);
      setSchedules((prev) => (prev ?? []).filter((x) => x.id !== target.id));
      if (selectedId === target.id) setSelectedId(null);
      toast.success(t("toastDeleted"));
      setDeleting(null);
    });
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
          ? t("toastRebaseNone", { model: defaultModelRoute })
          : t("toastRebased", { count: res.reassigned, model: defaultModelRoute }),
      );
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setRebasing(false);
    }
  };

  const openCreate = (initial: ScheduleDraft | null = null) => {
    setEditing(null);
    setDraft(initial);
    setDialogOpen(true);
  };
  const openEdit = (s: Schedule) => {
    setSelectedId(null);
    setEditing(s);
    setDraft(null);
    setDialogOpen(true);
  };

  /** Hand over to the agent in a new chat, with the schedules skill loaded. */
  const startChat = (prompt: string) => {
    appStore.setState({
      pendingThreadMention: {
        type: "skill",
        name: "schedules",
        description: "Create, change, pause, run and troubleshoot the user's schedules.",
      },
      pendingChatPrompt: prompt,
    });
    router.push("/");
  };
  const refine = (s: Schedule) =>
    startChat(
      s.lastStatus === "failed"
        ? t("fixPrompt", { name: s.name, id: s.id })
        : t("refinePrompt", { name: s.name, id: s.id }),
    );
  const customize = (template: ScheduleTemplate, title: string, existing?: Schedule) => {
    if (existing) return refine(existing);
    startChat(t("customizePrompt", { name: title, id: template.id }));
  };
  const submitAsk = () => {
    const text = ask.trim();
    if (text) startChat(text);
  };

  const actions: ScheduleRowActions = {
    onSelect: (s) => setSelectedId(s.id),
    onToggle: (s, enabled) =>
      void withBusy(s.id, async () => {
        replace(await updateSchedule(s.id, { enabled }));
        toast.success(enabled ? t("toastResumed") : t("toastPaused"));
      }),
    onRunNow: (s) =>
      void withBusy(s.id, async () => {
        replace((await runScheduleNow(s.id)).schedule);
        setDetailRefresh((n) => n + 1);
        toast.success(t("toastTriggered"));
      }),
    onEdit: openEdit,
    onDelete: setDeleting,
    onRefine: refine,
  };

  const canWrite = session.user.role === "admin";
  const activeTab = tab ?? "yours";
  const isLoading = schedules === null && !error;
  const clearFilters = () => {
    setQuery("");
    setStatus("all");
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-8" data-testid="schedules-page">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="font-brand text-2xl font-bold tracking-tight sm:text-[28px]">{t("title")}</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground" data-testid="schedules-next-up">
            {nextUp?.nextRunAt
              ? t("nextUpLine", {
                  name: nextUp.name,
                  when: format.relativeTime(new Date(nextUp.nextRunAt), new Date()),
                })
              : t("subtitleShort")}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => openCreate()}
          data-testid="schedules-create-button"
          className="shrink-0 gap-1.5 rounded-full px-4 font-medium"
        >
          <Plus className="size-4" />
          {t("newSchedule")}
        </Button>
      </header>

      <form
        className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-4 pr-1.5 shadow-xs focus-within:ring-2 focus-within:ring-ring/40"
        onSubmit={(e) => {
          e.preventDefault();
          submitAsk();
        }}
      >
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
        <input
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder={t("askPlaceholder")}
          aria-label={t("askLabel")}
          data-testid="schedules-ask-input"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="submit"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          disabled={!ask.trim()}
          aria-label={t("askSend")}
          data-testid="schedules-ask-send"
        >
          <ArrowUp className="size-4" />
        </Button>
      </form>

      {error ? (
        <Alert variant="destructive" data-testid="schedules-error">
          <AlertCircle className="size-4" />
          <AlertTitle>{t("loadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()} data-testid="schedules-retry-button">
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={activeTab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
        <TabsList className="w-full sm:w-fit">
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id} data-testid={`schedules-tab-${id}`} className="flex-1 sm:flex-none">
              {t(`tab.${id}`)}
              {id === "yours" && counts.all > 0 ? (
                <span className="ml-1 text-xs font-normal text-muted-foreground">{counts.all}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="yours" className="flex flex-col gap-4">
          {isLoading ? (
            <ScheduleAgendaSkeleton />
          ) : !schedules || schedules.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card/60 px-6 py-12 text-center"
              data-testid="schedules-empty"
            >
              <CalendarClock className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("emptyTitle")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">{t("emptyHint")}</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Button size="sm" className="rounded-full" onClick={() => setTab("templates")} data-testid="schedules-empty-templates">
                  {t("browseTemplates")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => openCreate()}
                  data-testid="schedules-empty-create-button"
                >
                  <Plus className="size-4" /> {t("newSchedule")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label={t("filterLabel")}>
                  {FILTERS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={status === f}
                      onClick={() => setStatus(f)}
                      data-testid={`schedules-filter-${f}`}
                      className={cn(
                        "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        status === f
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`filter.${f}`)} <span className="font-normal opacity-70">{counts[f]}</span>
                    </button>
                  ))}
                </div>
                <div className="relative ml-auto w-full sm:w-52">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t("searchPlaceholder")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-8 rounded-full pl-8 text-xs"
                    data-testid="schedules-search-input"
                    aria-label={t("searchPlaceholder")}
                  />
                </div>
              </div>
              {filtered.length === 0 ? (
                <div className="rounded-2xl border border-border/60 p-8 text-center text-sm text-muted-foreground" data-testid="schedules-no-results">
                  {t("noMatches")}{" "}
                  <button type="button" className="underline" onClick={clearFilters} data-testid="schedules-clear-filters-button">
                    {t("clearFilters")}
                  </button>
                </div>
              ) : (
                <ScheduleAgenda
                  schedules={filtered}
                  templates={templates ?? []}
                  selectedId={selectedId}
                  busyId={busyId}
                  actions={actions}
                />
              )}
              {canWrite && defaultModelRoute && offDefaultCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setRebaseOpen(true)}
                  data-testid="schedules-rebase-model-button"
                  className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {t("useModelForAll", { model: defaultModelRoute })}
                </button>
              ) : null}
            </>
          )}
        </TabsContent>

        <TabsContent value="templates">
          <ScheduleTemplates
            schedules={schedules ?? []}
            onAdd={openCreate}
            onCustomize={customize}
            onView={(s) => {
              setTab("yours");
              setSelectedId(s.id);
            }}
          />
        </TabsContent>

        <TabsContent value="activity" className="flex flex-col gap-6">
          <RecentRuns schedules={schedules ?? []} refreshKey={detailRefresh} onOpen={setSelectedId} />
          <SystemTasks canWrite={canWrite} />
        </TabsContent>
      </Tabs>

      <p className="text-[11px] text-muted-foreground" data-testid="schedules-daemon-notice">
        {t("daemonNotice")}
      </p>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-lg">
          {selected ? (
            <ScheduleDetailSheet
              schedule={selected}
              usageSummary={usageSummaries[selected.id]}
              onEdit={() => openEdit(selected)}
              onRefine={() => refine(selected)}
              onRunNow={() => actions.onRunNow(selected)}
              onCancelOneTime={() =>
                void withBusy(selected.id, async () => {
                  replace(await cancelSchedule(selected.id));
                  setDetailRefresh((n) => n + 1);
                  toast.success(t("toastCancelled"));
                })
              }
              refreshKey={detailRefresh}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditing(null);
        }}
        schedule={editing}
        initial={draft}
        onSaved={() => {
          void refresh();
          setTab("yours");
        }}
      />

      <AlertDialog open={rebaseOpen} onOpenChange={setRebaseOpen}>
        <AlertDialogContent data-testid="schedule-rebase-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("moveSchedulesTitle", { model: defaultModelRoute ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("moveSchedulesDescription", { count: offDefaultCount, model: defaultModelRoute ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rebasing} data-testid="schedule-rebase-cancel">
              {t("cancel")}
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
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteDescription", { name: deleting?.name ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="schedule-delete-cancel">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              data-testid="schedule-delete-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
