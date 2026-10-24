"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CalendarClock, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "ui/alert";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Switch } from "ui/switch";
import { Textarea } from "ui/textarea";
import { handleErrorWithToast } from "ui/shared-toast";
import { useChatModels } from "@/hooks/queries/use-chat-models";
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleKind,
} from "@/lib/backend/schedules-api";
import { type ScheduleMode, previewSchedule } from "@/lib/backend/schedules-api";
import {
  COMMON_TIMEZONES,
  detectBrowserTimezone,
  presetToCron,
  storedAtToWallLocal,
  validateCronExpression,
  wallTimeToAt,
  WEEKDAYS,
} from "./schedule-helpers";

type CadenceTab =
  | "once"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "interval"
  | "cron";

function inferCadenceTab(kind: ScheduleKind): CadenceTab {
  if (kind.kind === "once") return "once";
  if (kind.kind === "interval") return "interval";
  if (kind.kind === "cron") {
    const e = kind.expression.trim();
    const p = e.split(/\s+/);
    if (p.length === 5) {
      const [mmS, hhS, dom, mon, dow] = p;
      // Only map to a preset tab when the time fields are plain numeric
      // minutes/hours — otherwise a custom like `*/5 * * * *` would be
      // mis-edited as Daily 09:00.
      if (!/^\d+$/.test(mmS) || !/^\d+$/.test(hhS)) return "cron";
      if (dom === "*" && mon === "*" && dow === "*") return "daily";
      if (dom === "*" && mon === "*" && dow === "1-5") return "weekdays";
      if (dom === "*" && mon === "*" && /^\d$/.test(dow)) return "weekly";
      if (/^\d+$/.test(dom) && mon === "*" && dow === "*") return "monthly";
    }
    return "cron";
  }
  return "daily";
}

function parseCronToTimeFields(expression: string): {
  time: string;
  weekday: number;
  day: number;
} {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return { time: "09:00", weekday: 1, day: 1 };
  const mm = Number(parts[0]);
  const hh = Number(parts[1]);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time =
    Number.isFinite(hh) && Number.isFinite(mm)
      ? `${pad(hh)}:${pad(mm)}`
      : "09:00";
  const dom = Number(parts[2]);
  const dow = Number(parts[4]);
  return {
    time,
    weekday: Number.isFinite(dow) ? dow % 7 : 1,
    day: Number.isFinite(dom) ? dom : 1,
  };
}

/** A pre-filled new schedule, e.g. from a suggested recipe. */
export interface ScheduleDraft {
  name: string;
  description?: string;
  prompt: string;
  script?: string;
  mode: ScheduleMode;
  cadence: "daily" | "weekdays" | "weekly";
  time: string;
  weekday?: number;
  quiet?: boolean;
  reuseConversation?: boolean;
}

export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  schedule: Schedule | null;
  initial?: ScheduleDraft | null;
  onSaved: () => void;
}) {
  const isEdit = !!schedule;
  const { data: modelProviders } = useChatModels();

  const allModels = useMemo(() => {
    const out: Array<{ provider: string; providerName: string; name: string }> =
      [];
    for (const p of modelProviders ?? []) {
      for (const m of p.models ?? []) {
        out.push({
          provider: p.provider,
          providerName: p.providerName || p.provider,
          name: m.name,
        });
      }
    }
    return out;
  }, [modelProviders]);

  const browserTz = useMemo(() => detectBrowserTimezone(), []);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ScheduleMode>("agent");
  const [timezone, setTimezone] = useState(browserTz);
  const [model, setModel] = useState<string>("");
  const [cadence, setCadence] = useState<CadenceTab>("daily");
  const [quiet, setQuiet] = useState(false);
  const [reuseConversation, setReuseConversation] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(60);

  const [onceAt, setOnceAt] = useState("");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [weekdaysTime, setWeekdaysTime] = useState("09:00");
  const [weeklyTime, setWeeklyTime] = useState("09:00");
  const [weeklyWeekday, setWeeklyWeekday] = useState(1);
  const [monthlyTime, setMonthlyTime] = useState("09:00");
  const [monthlyDay, setMonthlyDay] = useState(1);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cronExpr, setCronExpr] = useState("0 9 * * *");

  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Track whether we have hydrated this open session, so async model catalog
  // arrivals do not overwrite what the user is typing.
  const hydratedForIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      hydratedForIdRef.current = null;
      return;
    }
    const key = schedule?.id ?? `__create__${initial?.name ?? ""}`;
    if (hydratedForIdRef.current === key) return;
    hydratedForIdRef.current = key;

    if (schedule) {
      setName(schedule.name);
      setDescription(schedule.description ?? "");
      setPrompt(
        schedule.mode === "script"
          ? schedule.script || schedule.prompt
          : schedule.prompt,
      );
      setMode(schedule.mode);
      setTimezone(schedule.timezone || browserTz);
      setModel(schedule.model ?? "");
      setQuiet(Boolean(schedule.quiet));
      setReuseConversation(Boolean(schedule.reuseConversation));
      setTimeoutSec(
        schedule.timeoutMs
          ? Math.max(1, Math.round(schedule.timeoutMs / 1000))
          : 60,
      );
      const tab = inferCadenceTab(schedule.schedule);
      setCadence(tab);
      if (schedule.schedule.kind === "once") {
        setOnceAt(storedAtToWallLocal(schedule.schedule.at, schedule.timezone || browserTz));
      }
      if (schedule.schedule.kind === "interval") {
        setIntervalMinutes(schedule.schedule.minutes);
      }
      if (schedule.schedule.kind === "cron") {
        const parsed = parseCronToTimeFields(schedule.schedule.expression);
        if (tab === "daily") setDailyTime(parsed.time);
        if (tab === "weekdays") setWeekdaysTime(parsed.time);
        if (tab === "weekly") {
          setWeeklyTime(parsed.time);
          setWeeklyWeekday(parsed.weekday);
        }
        if (tab === "monthly") {
          setMonthlyTime(parsed.time);
          setMonthlyDay(parsed.day);
        }
        setCronExpr(schedule.schedule.expression);
      }
    } else {
      setName(initial?.name ?? "");
      setDescription(initial?.description ?? "");
      setPrompt(initial?.prompt ?? "");
      setMode(initial?.mode ?? "agent");
      setTimezone(browserTz);
      // model default is handled by the separate effect below so it can wait
      // for the catalog without re-hydrating the whole form.
      setModel("");
      setQuiet(Boolean(initial?.quiet));
      setReuseConversation(Boolean(initial?.reuseConversation));
      setTimeoutSec(60);
      setCadence(initial?.cadence ?? "daily");
      setOnceAt("");
      setDailyTime(initial?.cadence === "daily" ? initial.time : "09:00");
      setWeekdaysTime(initial?.cadence === "weekdays" ? initial.time : "09:00");
      setWeeklyTime(initial?.cadence === "weekly" ? initial.time : "09:00");
      setWeeklyWeekday(initial?.weekday ?? 1);
      setMonthlyTime("09:00");
      setMonthlyDay(1);
      setIntervalMinutes(60);
      setCronExpr("0 9 * * *");
    }
    setPreview(null);
    setPreviewError(null);
    setFormError(null);
  }, [open, schedule, initial, browserTz]);

  // Default model once catalog arrives — separate from hydration so catalog
  // refresh does not wipe the form.
  useEffect(() => {
    if (!open || schedule) return;
    if (model) return;
    if (allModels.length === 0) return;
    // Use provider:model (colon) — runtime expects colon; slash inside model
    // name (e.g. muse/muse-spark-1.3) must be preserved verbatim.
    setModel(`${allModels[0].provider}:${allModels[0].name}`);
  }, [open, schedule, allModels, model]);

  const builtSchedule: ScheduleKind | null = useMemo(() => {
    if (cadence === "once") {
      if (!onceAt) return null;
      return { kind: "once", at: wallTimeToAt(onceAt) };
    }
    if (cadence === "daily") {
      if (!dailyTime) return null;
      return { kind: "cron", expression: presetToCron({ kind: "daily", time: dailyTime }) };
    }
    if (cadence === "weekdays") {
      if (!weekdaysTime) return null;
      return { kind: "cron", expression: presetToCron({ kind: "weekdays", time: weekdaysTime }) };
    }
    if (cadence === "weekly") {
      if (!weeklyTime) return null;
      return { kind: "cron", expression: presetToCron({ kind: "weekly", time: weeklyTime, weekday: weeklyWeekday }) };
    }
    if (cadence === "monthly") {
      if (!monthlyTime) return null;
      return { kind: "cron", expression: presetToCron({ kind: "monthly", time: monthlyTime, day: monthlyDay }) };
    }
    if (cadence === "interval") {
      if (!intervalMinutes || intervalMinutes < 5) return null;
      return { kind: "interval", minutes: intervalMinutes };
    }
    if (cadence === "cron") {
      if (!cronExpr.trim()) return null;
      return { kind: "cron", expression: cronExpr.trim() };
    }
    return null;
  }, [cadence, onceAt, dailyTime, weekdaysTime, weeklyTime, weeklyWeekday, monthlyTime, monthlyDay, intervalMinutes, cronExpr]);

  useEffect(() => {
    if (!open || !builtSchedule) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (cadence === "cron") {
      const err = validateCronExpression(cronExpr);
      if (err) {
        setPreview(null);
        setPreviewError(err);
        return;
      }
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    previewSchedule({ schedule: builtSchedule, timezone })
      .then((nextRuns) => {
        if (cancelled) return;
        setPreview(nextRuns);
        setPreviewError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg =
          e instanceof Error
            ? e.message
            : typeof (e as { message?: string })?.message === "string"
              ? (e as { message: string }).message
              : "Preview failed. Check cron and timezone.";
        setPreview(null);
        setPreviewError(msg);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, builtSchedule, timezone, cadence, cronExpr]);

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    timezone.trim().length > 0 &&
    !!builtSchedule &&
    !previewError;

  const handleSave = async () => {
    setFormError(null);
    if (!name.trim()) {
      setFormError("Name is required.");
      return;
    }
    if (!prompt.trim()) {
      setFormError("Instructions are required.");
      return;
    }
    if (!builtSchedule) {
      setFormError("Complete the schedule timing.");
      return;
    }
    if (cadence === "cron") {
      const err = validateCronExpression(cronExpr);
      if (err) {
        setFormError(err);
        return;
      }
    }
    if (cadence === "interval" && (intervalMinutes < 5 || intervalMinutes > 43200)) {
      setFormError("Interval must be 5 minutes to 30 days (43200).");
      return;
    }
    if (previewError) {
      setFormError(previewError);
      return;
    }

    setSaving(true);
    try {
      const payload: CreateScheduleInput = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        prompt: prompt.trim(),
        ...(mode === "script" ? { script: prompt.trim() } : {}),
        mode,
        timezone,
        schedule: builtSchedule,
        model:
          mode === "notify" || mode === "script" ? null : model.trim() || null,
        quiet,
        reuseConversation: cadence === "once" ? false : reuseConversation,
        ...(mode === "script"
          ? { timeoutMs: Math.max(1, Math.min(1800, timeoutSec)) * 1000 }
          : {}),
      };
      const { createSchedule, updateSchedule } = await import(
        "@/lib/backend/schedules-api"
      );
      if (schedule) {
        await updateSchedule(schedule.id, payload);
      } else {
        await createSchedule(payload);
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      handleErrorWithToast(e as Error);
      const msg =
        (e as { message?: string })?.message ||
        (e as { info?: { error?: string } })?.info?.error ||
        "Could not save schedule.";
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const tzs = useMemo(() => {
    const set = new Set<string>(COMMON_TIMEZONES);
    set.add(browserTz);
    if (timezone) set.add(timezone);
    if (schedule?.timezone) set.add(schedule.timezone);
    return Array.from(set).sort();
  }, [browserTz, timezone, schedule?.timezone]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="schedule-dialog"
        className="max-h-[92vh] overflow-hidden flex flex-col sm:max-w-[640px]"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-5 text-primary" />
            {isEdit ? "Edit schedule" : "Create schedule"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the prompt, timing, or timezone. Next run is recomputed on save."
              : "A schedule runs your agent on a cadence or sends an in-app reminder."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-5 pr-1 -mr-1">
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="schedule-name">Name</Label>
              <Input
                id="schedule-name"
                data-testid="schedule-name-input"
                placeholder="Morning briefing"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="schedule-prompt">
                {mode === "script" ? "Script command" : "Instructions"}
              </Label>
              <Textarea
                id="schedule-prompt"
                data-testid="schedule-prompt-input"
                placeholder={
                  mode === "script"
                    ? "echo \"Checking status...\" && curl -fsSL https://example.com/health"
                    : "What should Amiro do when this fires? Be specific and include files, repos, or checks to run."
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className={`min-h-[96px] resize-y ${mode === "script" ? "font-mono text-xs" : ""}`}
              />
              <p className="text-xs text-muted-foreground">
                {mode === "script"
                  ? "Runs in your agent workspace with __SCHEDULE_ID and __SCHEDULE_RUN_ID."
                  : "Write it like a message to your agent. Results land in this schedule's conversation with the prompt and reply."}
              </p>
            </div>

            <div className="grid gap-2">
              <Label>Mode</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["agent", "Agent", "Uses tools and connectors, like a chat"],
                    ["execute", "Text only", "Writes a reply, no tools"],
                    ["notify", "Reminder", "Posts your text as-is"],
                    ["script", "Script", "Runs a shell command directly"],
                  ] as const
                ).map(([id, title, sub]) => (
                  <button
                    key={id}
                    type="button"
                    data-testid={`schedule-mode-${id}`}
                    onClick={() => setMode(id)}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${mode === id ? "border-primary bg-primary/10" : "border-border hover:bg-accent"}`}
                    aria-pressed={mode === id}
                  >
                    <div className="text-sm font-medium">{title}</div>
                    <div className="text-xs text-muted-foreground">{sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {mode === "script" ? (
              <div className="grid gap-2">
                <Label htmlFor="schedule-timeout">Script timeout (seconds)</Label>
                <Input
                  id="schedule-timeout"
                  data-testid="schedule-timeout-input"
                  type="number"
                  min={1}
                  max={1800}
                  value={String(timeoutSec)}
                  onChange={(e) =>
                    setTimeoutSec(
                      Math.max(1, Math.min(1800, Number(e.target.value) || 60)),
                    )
                  }
                />
              </div>
            ) : null}

            {mode !== "notify" && mode !== "script" ? (
              <div className="grid gap-2">
                <Label htmlFor="schedule-model">Model</Label>
                {allModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground rounded-md border border-dashed px-3 py-2">
                    No models configured yet. Configure a provider in Settings,
                    then pick a model here. Saving without a model uses the
                    server default.
                  </p>
                ) : (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger
                      id="schedule-model"
                      data-testid="schedule-model-select"
                    >
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {allModels.map((m) => {
                        const v = `${m.provider}:${m.name}`;
                        return (
                          <SelectItem key={v} value={v}>
                            {m.name}{" "}
                            <span className="text-muted-foreground">
                              · {m.providerName}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="schedule-timezone">Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger
                  id="schedule-timezone"
                  data-testid="schedule-timezone-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[280px]">
                  {tzs.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                      {tz === browserTz ? " · (browser)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                All times below are wall time in{" "}
                <span className="font-medium text-foreground">{timezone}</span>.
                Preview is shown in this zone too.
              </p>
            </div>

            <div className="grid gap-2">
              <Label>Cadence</Label>
              <div
                role="tablist"
                aria-label="Cadence"
                className="flex flex-wrap gap-1.5"
              >
                {(
                  [
                    ["once", "Once"],
                    ["daily", "Daily"],
                    ["weekdays", "Weekdays"],
                    ["weekly", "Weekly"],
                    ["monthly", "Monthly"],
                    ["interval", "Interval"],
                    ["cron", "Custom cron"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={cadence === value}
                    data-testid={`schedule-cadence-${value}`}
                    onClick={() => setCadence(value)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${cadence === value ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent border-border"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="rounded-lg border bg-card p-3">
                {cadence === "once" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-once-at">Run at</Label>
                    <Input
                      id="schedule-once-at"
                      data-testid="schedule-once-at-input"
                      type="datetime-local"
                      value={onceAt}
                      onChange={(e) => setOnceAt(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      One-shot. Interpreted as wall time in {timezone}. On
                      backend restart, overdue one-shots already due will run
                      once; past due with no catch-up needed is marked skipped.
                    </p>
                  </div>
                ) : null}
                {cadence === "daily" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-daily-time">Time</Label>
                    <Input
                      id="schedule-daily-time"
                      data-testid="schedule-daily-time-input"
                      type="time"
                      value={dailyTime}
                      onChange={(e) => setDailyTime(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Every day at {dailyTime || "no time"} {timezone}
                    </p>
                  </div>
                ) : null}
                {cadence === "weekdays" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-weekdays-time">
                      Time (Mon–Fri)
                    </Label>
                    <Input
                      id="schedule-weekdays-time"
                      data-testid="schedule-weekdays-time-input"
                      type="time"
                      value={weekdaysTime}
                      onChange={(e) => setWeekdaysTime(e.target.value)}
                    />
                  </div>
                ) : null}
                {cadence === "weekly" ? (
                  <div className="grid gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-weekly-time">Time</Label>
                      <Input
                        id="schedule-weekly-time"
                        data-testid="schedule-weekly-time-input"
                        type="time"
                        value={weeklyTime}
                        onChange={(e) => setWeeklyTime(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-weekly-weekday">Weekday</Label>
                      <Select
                        value={String(weeklyWeekday)}
                        onValueChange={(v) => setWeeklyWeekday(Number(v))}
                      >
                        <SelectTrigger
                          id="schedule-weekly-weekday"
                          data-testid="schedule-weekly-weekday-select"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAYS.map((w) => (
                            <SelectItem key={w.value} value={String(w.value)}>
                              {w.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : null}
                {cadence === "monthly" ? (
                  <div className="grid gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-monthly-time">Time</Label>
                      <Input
                        id="schedule-monthly-time"
                        data-testid="schedule-monthly-time-input"
                        type="time"
                        value={monthlyTime}
                        onChange={(e) => setMonthlyTime(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-monthly-day">Day of month</Label>
                      <Input
                        id="schedule-monthly-day"
                        data-testid="schedule-monthly-day-input"
                        type="number"
                        min={1}
                        max={31}
                        value={String(monthlyDay)}
                        onChange={(e) =>
                          setMonthlyDay(
                            Math.max(
                              1,
                              Math.min(31, Number(e.target.value) || 1),
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                ) : null}
                {cadence === "interval" ? (
                  <div className="grid gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-interval">Every</Label>
                      <div className="flex gap-2">
                        <Input
                          id="schedule-interval"
                          data-testid="schedule-interval-input"
                          type="number"
                          min={5}
                          max={43200}
                          value={String(intervalMinutes)}
                          onChange={(e) =>
                            setIntervalMinutes(
                              Math.max(5, Number(e.target.value) || 5),
                            )
                          }
                          className="flex-1"
                        />
                        <span className="inline-flex items-center text-sm text-muted-foreground">
                          minutes
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {[15, 30, 60, 360, 720, 1440].map((m) => (
                          <button
                            key={m}
                            type="button"
                            data-testid={`schedule-interval-preset-${m}`}
                            onClick={() => setIntervalMinutes(m)}
                            className={`rounded-full border px-2.5 py-1 text-xs ${intervalMinutes === m ? "bg-accent border-border font-medium" : "border-border hover:bg-accent"}`}
                          >
                            {m < 60
                              ? `${m}m`
                              : m === 60
                                ? "1h"
                                : m === 360
                                  ? "6h"
                                  : m === 720
                                    ? "12h"
                                    : "24h"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                {cadence === "cron" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-cron">Cron expression</Label>
                    <Input
                      id="schedule-cron"
                      data-testid="schedule-cron-input"
                      placeholder="0 9 * * 1-5"
                      value={cronExpr}
                      onChange={(e) => setCronExpr(e.target.value)}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      5 fields: minute hour day month weekday, wall time in{" "}
                      {timezone}. Example daily 09:00 is{" "}
                      <code className="rounded bg-muted px-1 py-0.5">
                        0 9 * * *
                      </code>
                      .
                    </p>
                  </div>
                ) : null}

                <div
                  className="mt-3 rounded-md border bg-muted/40 p-2.5"
                  data-testid="schedule-preview"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <CalendarClock className="size-3.5 opacity-70" />
                    Next runs
                    {previewLoading ? (
                      <Loader2 className="size-3.5 animate-spin opacity-60" />
                    ) : null}
                  </div>
                  {previewError ? (
                    <div
                      className="mt-1.5 flex gap-1.5 text-xs text-destructive"
                      data-testid="schedule-preview-error"
                    >
                      <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
                      <span>{previewError}</span>
                    </div>
                  ) : preview && preview.length > 0 ? (
                    <ul className="mt-1.5 space-y-1 text-xs">
                      {preview.slice(0, 5).map((iso) => {
                        const d = new Date(iso);
                        let label = iso;
                        try {
                          label = d.toLocaleString(undefined, {
                            timeZone: timezone,
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            hour12: true,
                            timeZoneName: "short",
                          });
                        } catch {
                          label = d.toLocaleString();
                        }
                        return (
                          <li
                            key={iso}
                            className="text-muted-foreground"
                            data-testid="schedule-preview-item"
                          >
                            {label}
                          </li>
                        );
                      })}
                    </ul>
                  ) : previewLoading ? (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Calculating…
                    </p>
                  ) : (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {builtSchedule
                        ? "No upcoming runs for this expression."
                        : "Complete the timing above to preview."}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {mode !== "notify" ? (
              <div className="grid gap-3 rounded-lg border bg-card p-3">
                {cadence !== "once" && mode !== "script" ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Label
                        htmlFor="schedule-reuse-conversation"
                        className="text-xs font-medium"
                      >
                        Continue in same conversation
                      </Label>
                      <p className="text-[11px] text-muted-foreground">
                        Reuse the previous run&apos;s thread so context carries
                        across recurring runs.
                      </p>
                    </div>
                    <Switch
                      id="schedule-reuse-conversation"
                      data-testid="schedule-reuse-conversation-switch"
                      checked={reuseConversation}
                      onCheckedChange={setReuseConversation}
                      aria-label="Continue in same conversation"
                    />
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Label
                      htmlFor="schedule-quiet"
                      className="text-xs font-medium"
                    >
                      Quiet mode
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Silence automatic completion notifications when a run
                      succeeds cleanly.
                    </p>
                  </div>
                  <Switch
                    id="schedule-quiet"
                    data-testid="schedule-quiet-switch"
                    checked={quiet}
                    onCheckedChange={setQuiet}
                    aria-label="Quiet mode"
                  />
                </div>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="schedule-description">Description (optional)</Label>
              <Input
                id="schedule-description"
                data-testid="schedule-description-input"
                placeholder="Short summary of what this schedule does"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={240}
              />
            </div>
          </div>

          {formError ? (
            <Alert variant="destructive" data-testid="schedule-form-error">
              <AlertCircle className="size-4" />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="pt-3 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            data-testid="schedule-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !canSave}
            data-testid="schedule-dialog-save"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : isEdit ? (
              "Save changes"
            ) : (
              "Create schedule"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
