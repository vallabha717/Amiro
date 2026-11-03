"use client";

import { Eraser, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "ui/button";
import { Checkbox } from "ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "ui/dialog";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "ui/select";
import { Switch } from "ui/switch";
import {
  type CleanupReport,
  type CleanupSettings,
  HOUSEKEEPING_KEY,
  getCleanup,
  runCleanup,
  saveCleanup,
} from "@/lib/backend/housekeeping-api";

/** Ages offered in the picker, in hours; anything else is "custom". */
export const CLEANUP_AGES = [24, 48, 72, 168, 336, 720] as const;

type Scope = "chats" | "archived" | "scheduleRuns" | "logFiles";
const SCOPES: Scope[] = ["chats", "archived", "scheduleRuns", "logFiles"];

export function CleanupDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Schedules");
  const { data, mutate } = useSWR(open ? HOUSEKEEPING_KEY : null, getCleanup, { shouldRetryOnError: false });
  const [draft, setDraft] = useState<CleanupSettings | null>(null);
  const [custom, setCustom] = useState(false);
  const [preview, setPreview] = useState<CleanupReport | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | "save" | null>(null);

  useEffect(() => {
    if (open && data && !draft) {
      setDraft(data.settings);
      setCustom(!CLEANUP_AGES.includes(data.settings.olderThanHours as (typeof CLEANUP_AGES)[number]));
    }
    if (!open) {
      setDraft(null);
      setPreview(null);
    }
  }, [open, data, draft]);

  const update = (patch: Partial<CleanupSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setPreview(null);
  };
  const nothingChosen = draft ? !draft.chats && !draft.scheduleRuns && !draft.logFiles : true;
  const ageLabel = (hours: number) =>
    hours % 168 === 0
      ? t("cleanupWeeks", { count: hours / 168 })
      : hours % 24 === 0
        ? t("cleanupDays", { count: hours / 24 })
        : t("cleanupHours", { count: hours });
  const reportLine = (report: CleanupReport) =>
    t(report.dryRun ? "cleanupWouldDelete" : "cleanupDeleted", {
      chats: report.chats,
      runs: report.scheduleRuns,
      files: report.logFiles,
      size: (report.bytes / 1_048_576).toFixed(1),
    });

  const act = async (kind: "preview" | "run" | "save") => {
    if (!draft) return;
    setBusy(kind);
    try {
      if (kind === "save") {
        await saveCleanup(draft);
        toast.success(draft.enabled ? t("cleanupSavedOn") : t("cleanupSavedOff"));
        onSaved();
        onOpenChange(false);
      } else {
        const { report } = await runCleanup(draft, kind === "preview");
        setPreview(report);
        if (kind === "run") {
          toast.success(reportLine(report));
          await mutate();
          onSaved();
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("cleanupFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cleanup-dialog" className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eraser className="size-5 text-primary" />
            {t("cleanupTitle")}
          </DialogTitle>
          <DialogDescription>{t("cleanupDescription")}</DialogDescription>
        </DialogHeader>
        {!draft ? (
          <div className="grid place-items-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="cleanup-enabled">{t("cleanupDaily")}</Label>
              <Switch
                id="cleanup-enabled"
                data-testid="cleanup-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>{t("cleanupAge")}</Label>
                <Select
                  value={custom ? "custom" : String(draft.olderThanHours)}
                  onValueChange={(v) => {
                    if (v === "custom") {
                      setCustom(true);
                    } else {
                      setCustom(false);
                      update({ olderThanHours: Number(v) });
                    }
                  }}
                >
                  <SelectTrigger data-testid="cleanup-age" aria-label={t("cleanupAge")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLEANUP_AGES.map((hours) => (
                      <SelectItem key={hours} value={String(hours)} data-testid={`cleanup-age-${hours}`}>
                        {ageLabel(hours)}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom" data-testid="cleanup-age-custom">
                      {t("cleanupCustom")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {custom ? (
                  <Input
                    type="number"
                    min={1}
                    max={8760}
                    data-testid="cleanup-hours"
                    aria-label={t("cleanupHoursLabel")}
                    value={draft.olderThanHours}
                    onChange={(e) => update({ olderThanHours: Math.max(1, Number(e.target.value) || 1) })}
                  />
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cleanup-time">{t("cleanupTime", { tz: data?.timezone ?? "UTC" })}</Label>
                <Input
                  id="cleanup-time"
                  type="time"
                  data-testid="cleanup-time"
                  value={draft.time}
                  onChange={(e) => update({ time: e.target.value })}
                />
              </div>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t("cleanupWhat")}</legend>
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    data-testid={`cleanup-scope-${scope}`}
                    checked={draft[scope]}
                    disabled={scope === "archived" && !draft.chats}
                    onCheckedChange={(v) => update({ [scope]: v === true })}
                    className="mt-0.5"
                  />
                  <span>
                    {t(`cleanupScope_${scope}`)}
                    <span className="block text-xs text-muted-foreground">{t(`cleanupScopeHint_${scope}`)}</span>
                  </span>
                </label>
              ))}
              {nothingChosen ? <p className="text-xs text-destructive">{t("cleanupChooseOne")}</p> : null}
            </fieldset>
            {preview ? (
              <div data-testid="cleanup-preview" className="rounded-xl border border-border/60 bg-muted/40 p-3 text-sm">
                <p className="font-medium">{reportLine(preview)}</p>
                {preview.chatList.length ? (
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                    {preview.chatList.slice(0, 5).map((c) => (
                      <li key={c.id}>{c.title || t("cleanupUntitled")}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("cleanupAlwaysKept")}</p>
            )}
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-testid="cleanup-preview-button"
              disabled={!draft || nothingChosen || busy !== null}
              onClick={() => act("preview")}
            >
              {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("cleanupPreviewButton")}
            </Button>
            <Button
              variant="destructive"
              data-testid="cleanup-run-button"
              disabled={!preview?.dryRun || busy !== null}
              title={preview?.dryRun ? undefined : t("cleanupPreviewFirst")}
              onClick={() => act("run")}
            >
              {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("cleanupRunButton")}
            </Button>
          </div>
          <Button data-testid="cleanup-save" disabled={!draft || nothingChosen || busy !== null} onClick={() => act("save")}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("cleanupSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
