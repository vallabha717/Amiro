"use client";

import type { ScheduleDraft } from "@/components/schedules/schedule-dialog";
import type { Schedule, ScheduleTemplate } from "@/lib/backend/schedules-api";
import { listScheduleTemplates } from "@/lib/backend/schedules-api";
import { cn } from "lib/utils";
import {
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Coffee,
  type LucideIcon,
  MailCheck,
  Moon,
  Newspaper,
  Plug,
  Receipt,
  ShieldCheck,
  Sparkles,
  Sunrise,
  Target,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import useSWR from "swr";
import { Alert, AlertDescription } from "ui/alert";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Skeleton } from "ui/skeleton";

const TEMPLATE_ICON: Record<string, LucideIcon> = {
  "mail-check": MailCheck,
  sunrise: Sunrise,
  target: Target,
  moon: Moon,
  "calendar-check": CalendarCheck,
  "calendar-range": CalendarRange,
  "clipboard-check": ClipboardCheck,
  receipt: Receipt,
  newspaper: Newspaper,
  coffee: Coffee,
};

export function templateIcon(icon: string | undefined): LucideIcon {
  return (icon && TEMPLATE_ICON[icon]) || CalendarClock;
}

const CATEGORIES = ["all", "daily", "work", "inbox", "learning", "wellbeing"] as const;
const INBOX_CLEAN = ["inboxClean1", "inboxClean2", "inboxClean3", "inboxClean4"] as const;
const INBOX_KEEP = ["inboxKeep1", "inboxKeep2", "inboxKeep3", "inboxKeep4"] as const;

/** A template's text in the viewer's language; the catalog's English otherwise. */
function useTemplateText() {
  const t = useTranslations("Schedules");
  return (template: ScheduleTemplate) => {
    const key = `templates.${template.id}`;
    return {
      title: t.has(`${key}.title`) ? t(`${key}.title`) : template.name,
      summary: t.has(`${key}.summary`) ? t(`${key}.summary`) : template.summary,
      cadence: t.has(`${key}.cadence`) ? t(`${key}.cadence`) : "",
    };
  };
}

/** Which of the user's schedules already came from this template. */
export function scheduleFromTemplate(
  schedules: Schedule[],
  template: ScheduleTemplate,
  title: string,
): Schedule | undefined {
  const names = [template.name.toLowerCase(), title.toLowerCase()];
  return schedules.find(
    (s) =>
      s.templateId === template.id ||
      (!s.templateId && names.includes(s.name.trim().toLowerCase())),
  );
}

export function ScheduleTemplates({
  schedules,
  onAdd,
  onCustomize,
  onView,
}: {
  schedules: Schedule[];
  /** Open the schedule form, prefilled. */
  onAdd: (draft: ScheduleDraft) => void;
  /** Start the guided setup in chat, or refine the copy they already have. */
  onCustomize: (template: ScheduleTemplate, title: string, existing?: Schedule) => void;
  onView: (schedule: Schedule) => void;
}) {
  const t = useTranslations("Schedules");
  const text = useTemplateText();
  const { data, error, isLoading, mutate } = useSWR("/api/schedules/templates", listScheduleTemplates, {
    revalidateOnFocus: false,
  });
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const [previewId, setPreviewId] = useState<string | null>(null);

  if (error) {
    return (
      <Alert variant="destructive" data-testid="schedule-templates-error">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{t("templatesLoadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void mutate()}>
            {t("retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-44 rounded-2xl" />
        ))}
      </div>
    );
  }

  const draftOf = (template: ScheduleTemplate): ScheduleDraft => {
    const { title, summary } = text(template);
    return {
      name: title,
      description: summary,
      prompt: template.prompt,
      mode: template.mode,
      cadence: template.cadence.kind,
      time: template.cadence.time,
      weekday: template.cadence.weekday,
      templateId: template.id,
    };
  };
  const preview = data.find((x) => x.id === previewId) ?? null;
  const visible = data.filter((x) => category === "all" || x.category === category);

  const actions = (template: ScheduleTemplate, compact: boolean) => {
    const { title } = text(template);
    const existing = scheduleFromTemplate(schedules, template, title);
    return (
      <div className={cn("flex flex-wrap items-center gap-2", compact && "mt-auto pt-1")}>
        <Button
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => onCustomize(template, title, existing)}
          data-testid={`schedule-setup-chat-${template.id}`}
          aria-label={t("customizeLabel", { name: title })}
        >
          <Sparkles className="size-3.5" />
          {t("customize")}
        </Button>
        {existing ? (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            onClick={() => onView(existing)}
            data-testid={`schedule-template-view-${template.id}`}
          >
            {t("viewSchedule")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            onClick={() => onAdd(draftOf(template))}
            data-testid={`schedule-recipe-${template.id}`}
            aria-label={t("reviewAddLabel", { name: title })}
          >
            {t("reviewAndAdd")}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="schedules-templates">
      <div
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        role="group"
        aria-label={t("templateCategories")}
      >
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
            data-testid={`schedule-category-${c}`}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              category === c
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`category.${c}`)}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((template) => {
          const { title, summary, cadence } = text(template);
          const Icon = templateIcon(template.icon);
          const added = !!scheduleFromTemplate(schedules, template, title);
          return (
            <article
              key={template.id}
              data-testid={`schedule-playbook-${template.id}`}
              className={cn(
                "flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-foreground/20",
                template.featured && "sm:col-span-2 lg:col-span-3",
              )}
            >
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => setPreviewId(template.id)}
                        data-testid={`schedule-template-open-${template.id}`}
                      >
                        {title}
                      </button>
                    </h3>
                    {added ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
                        data-testid={`schedule-template-added-${template.id}`}
                      >
                        <CheckCircle2 className="size-3" />
                        {t("added")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 className="size-3 shrink-0" />
                    {cadence}
                  </p>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
              {template.id === "inbox-cleanup" ? <InboxRules /> : null}
              {template.needs.length > 0 ? (
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Plug className="size-3 shrink-0" />
                  {t("worksBestWith", {
                    needs: template.needs.map((n) => t(`need.${n}`)).join(", "),
                  })}
                </p>
              ) : null}
              {actions(template, true)}
            </article>
          );
        })}
      </div>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreviewId(null)}>
        {preview ? (
          <DialogContent className="sm:max-w-lg" data-testid="schedule-template-preview">
            <DialogHeader>
              <DialogTitle>{text(preview).title}</DialogTitle>
              <DialogDescription>{text(preview).summary}</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-3 text-xs">
              <div>
                <dt className="text-muted-foreground">{t("whenItRuns")}</dt>
                <dd className="font-medium">{text(preview).cadence}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("howItRuns")}</dt>
                <dd className="font-medium">{t(`modeLong.${preview.mode}`)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("itsInstructions")}</dt>
                <dd
                  className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-2.5 leading-relaxed"
                  lang="en"
                  data-testid="schedule-template-prompt"
                >
                  {preview.prompt}
                </dd>
              </div>
            </dl>
            {actions(preview, false)}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function InboxRules() {
  const t = useTranslations("Schedules");
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <RuleList
        testId="playbook-clean-defaults"
        title={t("cleanByDefaultLabel")}
        icon={<Trash2 className="size-3.5 text-rose-600 dark:text-rose-400" />}
        items={INBOX_CLEAN.map((k) => t(k))}
      />
      <RuleList
        testId="playbook-keep-defaults"
        title={t("keepByDefaultLabel")}
        icon={<ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
        items={INBOX_KEEP.map((k) => t(k))}
      />
    </div>
  );
}

function RuleList({
  testId,
  title,
  icon,
  items,
}: {
  testId: string;
  title: string;
  icon: React.ReactNode;
  items: string[];
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-3" data-testid={testId}>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold">
        {icon}
        {title}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item} className="rounded-md border bg-background px-2 py-0.5 text-[11px]">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
