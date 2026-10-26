"use client";

import { cn } from "lib/utils";
import { useTranslations } from "next-intl";

/**
 * One colour family per kind of step. The colour always travels with an
 * icon or a label (the rail disc, the tooltip), so it is never the only
 * thing that says what a step was.
 */
export const STEP_TONE: Record<
  string,
  { bar: string; disc: string; dot: string }
> = {
  thought: {
    bar: "bg-violet-400 dark:bg-violet-400/80",
    disc: "text-violet-600 border-violet-500/40 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  search: {
    bar: "bg-sky-400 dark:bg-sky-400/80",
    disc: "text-sky-600 border-sky-500/40 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  command: {
    bar: "bg-amber-400 dark:bg-amber-400/80",
    disc: "text-amber-600 border-amber-500/40 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  edit: {
    bar: "bg-emerald-400 dark:bg-emerald-400/80",
    disc: "text-emerald-600 border-emerald-500/40 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  explore: {
    bar: "bg-slate-400 dark:bg-slate-400/70",
    disc: "text-slate-600 border-slate-400/50 dark:text-slate-300",
    dot: "bg-slate-500",
  },
  ask: {
    bar: "bg-fuchsia-400 dark:bg-fuchsia-400/80",
    disc: "text-fuchsia-600 border-fuchsia-500/40 dark:text-fuchsia-300",
    dot: "bg-fuchsia-500",
  },
  plan: {
    bar: "bg-teal-400 dark:bg-teal-400/80",
    disc: "text-teal-600 border-teal-500/40 dark:text-teal-300",
    dot: "bg-teal-500",
  },
  note: {
    bar: "bg-primary/70",
    disc: "text-primary border-primary/40",
    dot: "bg-primary",
  },
  other: {
    bar: "bg-zinc-400 dark:bg-zinc-500",
    disc: "text-muted-foreground",
    dot: "bg-zinc-500",
  },
};

export function toneFor(kind: string) {
  if (kind === "orient" || kind === "remember") return STEP_TONE.explore;
  if (kind === "summarize") return STEP_TONE.plan;
  if (kind === "delegate" || kind === "visualize") return STEP_TONE.other;
  return STEP_TONE[kind] ?? STEP_TONE.other;
}

export interface StripStep {
  /** Which timeline row this is ("lead" for the opening thought). */
  row: string;
  kind: string;
  title: string;
  state: "running" | "failed" | "done";
}

/**
 * The turn at a glance: one segment per step, coloured by what kind of
 * step it was, in order. It stays on the folded card, so every reply keeps
 * a small fingerprint of how it was made; a segment opens the card at that
 * step.
 */
export function StepStrip({
  steps,
  onJump,
}: {
  steps: StripStep[];
  onJump: (row: string) => void;
}) {
  const t = useTranslations("ChatStream.Timeline");
  if (!steps.length) return null;
  return (
    <div
      data-testid="step-strip"
      role="group"
      aria-label={t("steps", { count: steps.length })}
      className="flex h-3 items-center gap-[3px]"
    >
      {steps.map((step, i) => {
        const tone = toneFor(step.kind);
        // An update from the agent is a moment, not work: a dot between
        // the bars rather than a bar of its own.
        if (step.kind === "note") {
          return (
            <button
              key={`${step.row}-${i}`}
              type="button"
              data-testid="step-strip-segment"
              data-kind="note"
              data-state={step.state}
              title={step.title}
              aria-label={t("goToStep", { index: i + 1, title: step.title })}
              onClick={() => onJump(step.row)}
              className="group/seg flex h-full w-2.5 shrink-0 items-center justify-center focus-visible:outline-none"
            >
              <span
                className={cn(
                  "block size-1.5 rounded-full ring-2 ring-card transition-transform group-hover/seg:scale-150 group-focus-visible/seg:scale-150",
                  tone.dot,
                  step.state === "running" && "step-seg-live",
                )}
              />
            </button>
          );
        }
        return (
          <button
            key={`${step.row}-${i}`}
            type="button"
            data-testid="step-strip-segment"
            data-kind={step.kind}
            data-state={step.state}
            title={step.title}
            aria-label={t("goToStep", { index: i + 1, title: step.title })}
            onClick={() => onJump(step.row)}
            className="group/seg flex h-full min-w-1.5 max-w-10 flex-1 items-center focus-visible:outline-none"
          >
            <span
              className={cn(
                "block h-1 w-full rounded-full transition-[height,opacity] duration-200 group-hover/seg:h-2 group-focus-visible/seg:h-2 group-focus-visible/seg:ring-2 group-focus-visible/seg:ring-ring",
                step.state === "failed" ? "bg-destructive" : tone.bar,
                step.state === "running" && "step-seg-live",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
