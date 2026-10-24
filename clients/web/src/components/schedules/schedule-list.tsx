"use client";

import type { ScheduleDraft } from "@/components/schedules/schedule-dialog";
import {
  formatScheduleCost,
  formatScheduleRunCount,
} from "@/components/schedules/schedule-helpers";
import { apiJson } from "@/lib/backend/client";
import type {
  Schedule,
  ScheduleUsageSummary,
} from "@/lib/backend/schedules-api";
import { cn } from "lib/utils";
import {
  Activity,
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import useSWR from "swr";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Switch } from "ui/switch";

// ---------------------------------------------------------------------------
// Interactive Schedule Playbooks (Agent-Guided Chat Setup + 1-Click Drafts)
// ---------------------------------------------------------------------------

export interface ScheduleRecipe {
  id: string;
  emoji: string;
  title: string;
  cadence: string;
  blurb: string;
  needs?: string;
  badge?: string;
  featured?: boolean;
  /** Rules that are kept/protected by default (rendered as visual chips) */
  keepDefaults?: string[];
  /** Clutter categories swept/removed by default (rendered as visual chips) */
  cleanDefaults?: string[];
  /** CTA label for interactive setup in chat */
  setupCta?: string;
  /** Initial prompt sent to Amiro in Chat when the user clicks interactive setup */
  interactivePrompt: string;
  draft: ScheduleDraft;
}

export const SCHEDULE_RECIPES: ScheduleRecipe[] = [
  {
    id: "inbox-cleanup",
    emoji: "🧹",
    title: "Inbox cleanup",
    cadence: "Every day at 7:30 AM",
    blurb:
      "Automatically sweep away promotions, noisy alerts, and expired codes while protecting your travel reservations, bills, and VIP threads.",
    needs: "Checks Gmail or mail connector · Interactive Keep vs. Clean rules",
    badge: "Interactive Studio",
    featured: true,
    cleanDefaults: [
      "Promotions & flash sales",
      "Unwanted notifications",
      "Social & cold outreach",
      "Expired OTPs & old newsletters",
    ],
    keepDefaults: [
      "Reservations this month",
      "Bills from last 2 months",
      "Active deliveries & receipts",
      "Starred & VIP senders",
    ],
    setupCta: "Set up this schedule for me",
    interactivePrompt:
      "I want to set up the Inbox Cleanup schedule interactively. First, check if my Gmail or mail connector is connected (using mcp_connectors_list on the amiro server). If it isn't connected yet, let me know how I can connect Gmail or my mail provider. Second, call ui_render_openui on the amiro MCP server with preset=\"inbox_cleanup_setup\" so I can interactively select what to clean up (default: clear all promotions, unwanted notifications, social updates, and expired OTPs) and what to keep (default: keep reservations from this month and bills/statements from the last 2 months), and then create the schedule for me.",
    draft: {
      name: "Inbox cleanup",
      description:
        "Clear promotions and unwanted notifications while keeping this month's reservations and the last 2 months of bills",
      mode: "agent",
      cadence: "daily",
      time: "07:30",
      prompt:
        "Inbox cleanup. Using my connected Gmail or mail connector: 1) CLEAN UP (archive/remove from Inbox): all promotional emails, marketing deals, unwanted automated notifications, social media alerts, and expired OTPs/newsletters older than 14 days. 2) KEEP & PROTECT in Inbox: all travel/dining/event reservations for this month, all utility bills, bank statements, and invoices from the last 2 months, active package deliveries, receipts, and starred/VIP threads. Post a concise summary of how many clutter threads were cleaned and highlight any upcoming reservations or due bills.",
    },
  },
  {
    id: "morning-briefing",
    emoji: "☀️",
    title: "Morning briefing",
    cadence: "Weekdays at 8:00 AM",
    blurb: "Today's meetings, the emails that matter, the weather, and your focus.",
    needs: "Best with Gmail and Calendar connected",
    badge: "Daily Digest",
    keepDefaults: ["Today's calendar events", "Top 3 priority emails", "NOW.md focus"],
    cleanDefaults: ["Low-priority CC threads"],
    setupCta: "Use this schedule",
    interactivePrompt:
      "Help me set up the Morning briefing schedule interactively. Check my connected calendar and mail connectors first, then ask me what sections and delivery time I want before creating the schedule.",
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
    badge: "Journal & Memory",
    keepDefaults: ["Completed wins", "Open blockers", "Tomorrow's #1 priority"],
    setupCta: "Use this schedule",
    interactivePrompt:
      "Help me set up the Evening wrap-up schedule interactively. Ask me what time I wrap up work and what I want tracked in NOW.md and my daily journal, then create the schedule.",
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
    badge: "Zero Tools",
    keepDefaults: ["3 concrete focus sentences", "Aligned with USER.md & NOW.md"],
    setupCta: "Use this schedule",
    interactivePrompt:
      "Help me set up the Daily focus schedule interactively. Ask me what time I start my day and what current goals to prioritize, then create the schedule.",
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
  onSetupInChat,
}: {
  schedules: Schedule[];
  onAdd: (draft: ScheduleDraft) => void;
  onSetupInChat?: (recipe: ScheduleRecipe) => void;
}) {
  const t = useTranslations("Schedules");
  const taken = new Set(schedules.map((s) => s.name.trim().toLowerCase()));
  const open = SCHEDULE_RECIPES.filter((r) => !taken.has(r.draft.name.toLowerCase()));
  if (!open.length) return null;

  const featured = open.find((r) => r.featured);
  const others = open.filter((r) => !r.featured);

  return (
    <section className="flex flex-col gap-4" data-testid="schedules-suggested">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t("playbooksTitle")}</h2>
            <Badge
              variant="secondary"
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            >
              <Sparkles className="mr-1 size-3 text-primary" />
              {t("playbooksBadge")}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("playbooksSubtitle")}
          </p>
        </div>
      </div>

      {featured ? (
        <div
          data-testid={`schedule-playbook-${featured.id}`}
          className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/[0.06] via-card to-card p-5 shadow-xs transition-all hover:border-primary/50"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className="grid size-10 place-items-center rounded-xl bg-primary/15 text-xl shadow-2xs"
                  aria-hidden
                >
                  {featured.emoji}
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold tracking-tight text-foreground">
                      {featured.title}
                    </h3>
                    {featured.badge ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
                        <Sparkles className="size-3" />
                        {featured.badge}
                      </span>
                    ) : null}
                    <span className="rounded-full border border-border/70 bg-background/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {featured.cadence}
                    </span>
                  </div>
                  {featured.needs ? (
                    <p className="text-[11px] text-muted-foreground">
                      {featured.needs}
                    </p>
                  ) : null}
                </div>
              </div>

              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                {featured.blurb}
              </p>

              <div className="grid gap-2.5 sm:grid-cols-2">
                {featured.cleanDefaults && featured.cleanDefaults.length > 0 ? (
                  <div
                    data-testid="playbook-clean-defaults"
                    className="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] p-3"
                  >
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                      <Trash2 className="size-3.5" />
                      <span>{t("cleanByDefaultLabel")}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {featured.cleanDefaults.map((item) => (
                        <span
                          key={item}
                          className="inline-flex items-center rounded-md border border-rose-500/20 bg-background/80 px-2 py-0.5 text-[11px] text-foreground"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {featured.keepDefaults && featured.keepDefaults.length > 0 ? (
                  <div
                    data-testid="playbook-keep-defaults"
                    className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3"
                  >
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      <ShieldCheck className="size-3.5" />
                      <span>{t("keepByDefaultLabel")}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {featured.keepDefaults.map((item) => (
                        <span
                          key={item}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-background/80 px-2 py-0.5 text-[11px] text-foreground"
                        >
                          <CheckCircle2 className="size-3 text-emerald-500" />
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col lg:items-stretch">
              {onSetupInChat ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSetupInChat(featured)}
                  data-testid={`schedule-setup-chat-${featured.id}`}
                  className="gap-1.5 rounded-full px-4 font-medium shadow-xs"
                >
                  <Sparkles className="size-3.5" />
                  <span>{featured.setupCta || t("setupWithAmiro")}</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onAdd(featured.draft)}
                data-testid={`schedule-recipe-${featured.id}`}
                aria-label={`Add ${featured.title}`}
                className="gap-1.5 rounded-full px-4 text-xs"
              >
                <Plus className="size-3.5" />
                <span>{t("quickAddButton")}</span>
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {others.map((r) => (
            <div
              key={r.id}
              data-testid={`schedule-playbook-${r.id}`}
              className="group flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-card p-4 text-left transition-all hover:border-foreground/20 hover:shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="grid size-9 place-items-center rounded-xl bg-primary/10 text-lg"
                  aria-hidden
                >
                  {r.emoji}
                </span>
                <div className="flex items-center gap-1.5">
                  {onSetupInChat ? (
                    <button
                      type="button"
                      onClick={() => onSetupInChat(r)}
                      data-testid={`schedule-setup-chat-${r.id}`}
                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
                    >
                      <Sparkles className="size-3" />
                      <span>{r.setupCta || t("useThisSchedule")}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onAdd(r.draft)}
                    data-testid={`schedule-recipe-${r.id}`}
                    aria-label={`Add ${r.title}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary cursor-pointer"
                  >
                    <Plus className="size-3" /> Add
                  </button>
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold">{r.title}</p>
                <p className="text-[11px] font-medium text-muted-foreground">{r.cadence}</p>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{r.blurb}</p>
              {r.needs ? (
                <p className="mt-auto text-[11px] text-muted-foreground/80">{r.needs}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const MODE_LABEL: Record<string, string> = {
  agent: "Agent",
  execute: "Text only",
  notify: "Reminder",
  script: "Script",
};

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
  usageSummary,
  selected,
  busy,
  onSelect,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  usageSummary?: ScheduleUsageSummary | null;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const failed = s.lastStatus === "failed";
  const isCompletedOnce =
    s.schedule.kind === "once" &&
    (s.status === "fired" ||
      s.status === "cancelled" ||
      s.lastStatus === "ok" ||
      s.lastStatus === "failed" ||
      s.lastStatus === "skipped");
  const when =
    s.status === "cancelled"
      ? "Cancelled"
      : isCompletedOnce
        ? "Completed"
        : s.enabled
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
      <span
        data-testid={`schedule-row-${s.id}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Switch
          checked={s.enabled}
          disabled={busy || isCompletedOnce}
          onCheckedChange={onToggle}
          data-testid={`schedule-toggle-${s.id}`}
          aria-label={
            isCompletedOnce
              ? `${s.name} is completed`
              : s.enabled
                ? `Pause ${s.name}`
                : `Resume ${s.name}`
          }
        />
      </span>
      <div
        className="min-w-0 flex-1"
        data-testid={`schedule-row-select-${s.id}`}
      >
        <div className="flex items-center gap-2">
          <span className={cn("truncate text-sm font-medium", !s.enabled && "text-muted-foreground")}>{s.name}</span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {MODE_LABEL[s.mode] ?? s.mode}
          </span>
          {s.reuseConversation && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Reuses chat
            </span>
          )}
          {s.quiet && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Quiet
            </span>
          )}
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
      {usageSummary && usageSummary.runCount > 0 ? (
        <div className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
          <span>{formatScheduleCost(usageSummary.totalEstimatedCostUsd)}</span>
          <span>·</span>
          <span>{formatScheduleRunCount(usageSummary.runCount)}</span>
        </div>
      ) : null}
      {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex items-center">
        <Button
          size="icon"
          variant="ghost"
          className="size-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onRunNow}
          disabled={busy}
          data-testid={`schedule-run-now-${s.id}`}
          aria-label={`Run ${s.name} now`}
          title="Run now"
        >
          <Play className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onEdit}
          disabled={busy}
          data-testid={`schedule-edit-${s.id}`}
          aria-label={`Edit ${s.name}`}
          title="Edit"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          disabled={busy}
          data-testid={`schedule-delete-${s.id}`}
          aria-label={`Delete ${s.name}`}
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label={`More for ${s.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRunNow}>Run now</DropdownMenuItem>
            {s.threadId && (
              <DropdownMenuItem asChild>
                <Link href={`/?thread=${encodeURIComponent(s.threadId)}`}>Open conversation</Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={onDelete}
            >
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
