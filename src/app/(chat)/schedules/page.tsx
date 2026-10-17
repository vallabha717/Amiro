"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  Loader2,
  Plus,
  Search,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { Card } from "ui/card";
import { Input } from "ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Skeleton } from "ui/skeleton";
import { useSession } from "@/lib/backend/session-context";
import {
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/lib/backend/schedules-api";
import type { Schedule } from "@/lib/backend/schedules-api";
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
import { EmptySchedules, ScheduleCardSkeleton, ScheduleRowCard } from "@/components/schedules/schedule-row";
import { ScheduleDialog } from "@/components/schedules/schedule-dialog";
import { ScheduleDetailSheet } from "@/components/schedules/schedule-detail";

type StatusFilter = "all" | "active" | "paused" | "failed";

export default function SchedulesPage() {
  const { data: session } = useSession();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listSchedules();
      setSchedules(list);
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

  if (!session) return null;

  const isLoading = schedules === null && !error;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 p-4 sm:p-6" data-testid="schedules-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <CalendarClock className="size-6 text-primary" />
            Schedules
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Run prompts on a schedule. In this version tools are off for
            scheduled execute runs, so they cannot send email or use skills that
            require tools, and in-app reminders post a message you can open as a
            conversation. Schedules run while your Amiro backend is running.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          data-testid="schedules-create-button"
          className="shrink-0 gap-1.5"
        >
          <Plus className="size-4" />
          Create schedule
        </Button>
      </div>

      <Alert data-testid="schedules-daemon-notice">
        <AlertCircle className="size-4" />
        <AlertTitle className="text-sm font-medium">Daemon must stay running</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          Schedules fire only while your Amiro backend is running. If the app
          or daemon stops, recurring schedules resume on next start and a
          pending one-shot that was already due will run once on the next tick.
          Keep the app open or run Amiro as a service for reliable delivery.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, instructions, timezone, model"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
            data-testid="schedules-search-input"
            aria-label="Search schedules"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger
            className="w-full sm:w-[180px]"
            data-testid="schedules-status-filter"
            aria-label="Filter by status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="failed">Last failed</SelectItem>
          </SelectContent>
        </Select>
        <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
          {schedules ? `${filtered.length} of ${schedules.length}` : ""}
        </div>
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

      {isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-9 w-full max-w-sm" />
          <ScheduleCardSkeleton />
          <ScheduleCardSkeleton />
        </div>
      ) : !schedules || schedules.length === 0 ? (
        <EmptySchedules onCreate={() => { setEditing(null); setDialogOpen(true); }} />
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground" data-testid="schedules-no-results">
          No schedules match your filters.
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setQuery(""); setStatus("all"); }}
              data-testid="schedules-clear-filters-button"
            >
              Clear filters
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="min-w-0 space-y-3" data-testid="schedules-list">
            {filtered.map((s) => (
              <ScheduleRowCard
                key={s.id}
                schedule={s}
                selected={selectedId === s.id}
                onSelect={() => setSelectedId(s.id)}
                onToggle={(enabled) => void handleToggle(s, enabled)}
                onRunNow={() => void handleRunNow(s)}
                onEdit={() => {
                  setEditing(s);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(s)}
              />
            ))}
            {busyId ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="schedules-busy">
                <Loader2 className="size-3.5 animate-spin" />
                Updating…
              </div>
            ) : null}
          </div>

          <div className="min-w-0 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden">
            {selected ? (
              <ScheduleDetailSheet
                schedule={selected}
                onClose={() => setSelectedId(null)}
                onEdit={() => {
                  setEditing(selected);
                  setDialogOpen(true);
                }}
                refreshKey={detailRefresh}
              />
            ) : (
              <Card className="hidden lg:flex min-h-[320px] flex-col items-center justify-center p-8 text-center" data-testid="schedules-detail-empty">
                <CalendarClock className="size-8 text-muted-foreground/60" />
                <p className="mt-3 text-sm font-medium">Select a schedule</p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Choose a schedule to see its next run, run history, and output.
                  Use Run now even while paused.
                </p>
              </Card>
            )}
            {/* On mobile the same column flows below the list; no duplicate sheet instance needed */}
            {selected ? (
              <p className="mt-3 hidden text-center text-xs text-muted-foreground lg:hidden">
                Scroll up to see the schedule list.
              </p>
            ) : null}
          </div>
        </div>
      )}

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditing(null);
        }}
        schedule={editing}
        onSaved={() => void refresh()}
      />

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
