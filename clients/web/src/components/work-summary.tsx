"use client";

import { formatDuration, type StepKind } from "lib/ai/tools/step-kind";
import type { InlineImage } from "lib/chat-ux/inline-images";
import { cn } from "lib/utils";
import {
  BookmarkIcon,
  BrainIcon,
  ChevronRightIcon,
  CompassIcon,
  FileTextIcon,
  GlobeIcon,
  LayoutIcon,
  ListChecksIcon,
  PencilIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { TextShimmer } from "ui/text-shimmer";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { Collapse } from "./fold-card";
import { WorkLog, type WorkLogRow } from "./work-log";
import { type StripStep, StepStrip, toneFor } from "./chat-stream/step-strip";

const n = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** One phrase for a kind of work, lower case so phrases chain after a comma. */
function phrase(kind: StepKind, count: number): string {
  switch (kind) {
    case "explore":
      return `read ${n(count, "file", "files")}`;
    case "edit":
      return `edited ${n(count, "file", "files")}`;
    case "command":
      return `ran ${n(count, "command", "commands")}`;
    case "search":
      return count === 1 ? "searched the web" : `searched ${count} times`;
    case "orient":
      return "got oriented";
    case "remember":
      return `updated ${n(count, "note", "notes")}`;
    case "plan":
      return "updated the plan";
    case "summarize":
      return "wrote the walkthrough";
    case "delegate":
      return `delegated ${n(count, "task", "tasks")}`;
    case "visualize":
      return `built ${n(count, "view", "views")}`;
    default:
      return count === 1 ? "used a tool" : `used ${count} tools`;
  }
}

/** "Thought, ran 4 commands, searched the web" for a run of tool calls. */
export function summarizeWork(rows: WorkLogRow[], thought: boolean): string {
  const counts = new Map<StepKind, number>();
  for (const row of rows) {
    if (row.type !== "group") continue;
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + row.glances.length);
  }
  const parts: string[] = [];
  if (thought) parts.push("thought");
  for (const [kind, count] of counts) parts.push(phrase(kind, count));
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const STEP_ICON: Record<string, ReactNode> = {
  thought: <BrainIcon className="size-3" />,
  explore: <FileTextIcon className="size-3" />,
  edit: <PencilIcon className="size-3" />,
  command: <TerminalIcon className="size-3" />,
  search: <GlobeIcon className="size-3" />,
  orient: <CompassIcon className="size-3" />,
  remember: <BookmarkIcon className="size-3" />,
  plan: <ListChecksIcon className="size-3" />,
  summarize: <ListChecksIcon className="size-3" />,
  delegate: <UsersIcon className="size-3" />,
  visualize: <LayoutIcon className="size-3" />,
  other: <WrenchIcon className="size-3" />,
};

function iconsFor(rows: WorkLogRow[], thought: boolean): ReactNode[] {
  const kinds: string[] = thought ? ["thought"] : [];
  for (const r of rows) {
    if (r.type === "group" && !kinds.includes(r.kind)) kinds.push(r.kind);
  }
  return kinds.slice(0, 4).map((k) => STEP_ICON[k] ?? STEP_ICON.other);
}

/**
 * Seconds since this run started streaming, ticking once a second while it
 * runs. A run the browser did not watch start (a reload mid-turn) counts from
 * when it was first seen, which is the honest lower bound.
 */
function useElapsed(running: boolean): number | null {
  const startRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (running && startRef.current === null) startRef.current = Date.now();
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return startRef.current === null ? null : Math.max(0, now - startRef.current);
}

/**
 * A turn's work as one card. While it runs, the header narrates the step in
 * progress in plain words, with the step strip underneath filling in as the
 * agent goes; the timeline below lists every step. Once the turn settles it
 * folds to a one-line summary, keeping the strip as the turn's fingerprint
 * -- unless the reader already chose to keep it open.
 */
function TimelineFold({
  settled,
  running,
  label,
  icons,
  steps,
  trailing,
  durationMs,
  thinkingOnly,
  children,
}: {
  /** No tool steps, only reasoning: the live header says "Thinking". */
  thinkingOnly?: boolean;
  settled: boolean;
  running: boolean;
  label: string;
  icons: ReactNode[];
  steps: StripStep[];
  trailing?: ReactNode;
  durationMs?: number;
  children: ReactNode;
}) {
  const t = useTranslations("ChatStream.Timeline");
  const reducedMotion = usePrefersReducedMotion();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !settled;
  const elapsed = useElapsed(running);
  const shownMs = settled ? (durationMs ?? elapsed) : elapsed;
  const rootRef = useRef<HTMLDivElement>(null);

  const current = steps[steps.length - 1];
  // The latest update from the agent reads best in its own words, quoted;
  // while it is still being written the header just says so.
  const headline =
    !current || (current.kind === "thought" && current.state === "running")
      ? t("thinkingAbout")
      : current.kind === "note"
        ? current.state === "running"
          ? t("writing")
          : `“${current.title}”`
        : current.title;
  const tone = toneFor(current?.kind ?? "thought");

  // A strip segment opens the card and brings its step into view, with a
  // brief highlight so the eye lands on the right row.
  const jumpTo = (row: string) => {
    setUserOpen(true);
    window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-row="${row}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      el.classList.remove("step-flash");
      void el.offsetWidth;
      el.classList.add("step-flash");
    }, 140);
  };

  const elapsedNode =
    shownMs !== null && shownMs !== undefined ? (
      <span
        data-testid="work-summary-elapsed"
        className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
      >
        {formatDuration(shownMs)}
      </span>
    ) : null;

  return (
    <div
      ref={rootRef}
      data-testid="work-summary"
      data-state={settled ? "settled" : "running"}
      className={cn(
        "overflow-hidden rounded-xl border bg-card text-xs transition-colors",
        !settled && "shadow-xs",
      )}
    >
      {settled ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setUserOpen(!open)}
          className="group/fold flex w-full min-w-0 items-center gap-2 px-3 pb-1 pt-2 text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
              open && "rotate-90",
            )}
          />
          {icons.length ? (
            <span className="flex shrink-0 items-center">
              {icons.map((icon, i) => (
                <span
                  key={i}
                  className="fold-icon-in flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground"
                  style={{ marginLeft: i === 0 ? 0 : -6, animationDelay: `${i * 60}ms` }}
                >
                  {icon}
                </span>
              ))}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate font-medium">
            {label || t("worked")}
          </span>
          {trailing}
          {elapsedNode}
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setUserOpen(!open)}
          className="group/fold flex w-full min-w-0 items-start gap-2.5 px-3.5 pb-1.5 pt-3 text-left transition-colors hover:bg-muted/30"
        >
          <span className="relative mt-[5px] flex size-2 shrink-0" aria-hidden>
            {!reducedMotion ? (
              <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", tone.dot)} />
            ) : null}
            <span className={cn("relative inline-flex size-2 rounded-full", tone.dot)} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {reducedMotion ? (
                <span>{thinkingOnly ? t("thinking") : t("working")}</span>
              ) : (
                <TextShimmer as="span">
                  {thinkingOnly ? t("thinking") : t("working")}
                </TextShimmer>
              )}
              {steps.length > 1 ? (
                <span>· {t("steps", { count: steps.length })}</span>
              ) : null}
            </span>
            {/* Keyed by the step, not its text, so a new step rises in but a
                step whose wording updates as it streams does not flicker. */}
            <span
              key={steps.length}
              data-testid="work-summary-headline"
              className="step-headline-in truncate text-[13px] font-medium text-foreground"
            >
              {headline}
            </span>
          </span>
          <ChevronRightIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-300",
              open && "rotate-90",
            )}
          />
          {elapsedNode}
        </button>
      )}
      <div className={cn(settled ? "px-3 pb-2" : "px-3.5 pb-2.5")}>
        <StepStrip steps={steps} onJump={jumpTo} />
      </div>
      <Collapse open={open}>
        <div className="border-t px-2 pb-2 pt-1.5">{children}</div>
      </Collapse>
    </div>
  );
}

/**
 * The turn's work as one card: thinking, every tool call and anything the
 * agent said between them, step by step on one timeline. Only the final
 * answer sits outside it.
 */
export function FoldedWork({
  rows,
  thought,
  reasoning,
  reasoningTitle,
  reasoningActive,
  turnSettled,
  isRunning,
  images,
  stepCount,
  durationMs,
  hiddenCount,
  trailing,
}: {
  rows: WorkLogRow[];
  thought: boolean;
  reasoning: ReactNode;
  /** The opening thought's first sentence, for the strip's tooltip. */
  reasoningTitle?: string;
  /** The opening thought is still streaming. */
  reasoningActive?: boolean;
  turnSettled: boolean;
  isRunning: boolean;
  images: InlineImage[];
  stepCount: number;
  durationMs?: number;
  hiddenCount?: number;
  /** Shown on the folded header: source favicons, diff stat. */
  trailing?: ReactNode;
}) {
  const t = useTranslations("ChatStream.Timeline");
  // Images no row carries are shown once, at the top of the timeline.
  const looseImages = useMemo(() => {
    const inRows = new Set<string>();
    for (const r of rows) {
      if (r.type === "group") r.images?.forEach((img) => inRows.add(img.src));
    }
    return images.filter((img) => !inRows.has(img.src));
  }, [images, rows]);

  if (!rows.length && !thought) {
    return looseImages.length ? (
      <WorkLog rows={[]} images={looseImages} isRunning={false} stepCount={stepCount} />
    ) : null;
  }

  // One strip segment per step, in order; updates the agent wrote between
  // steps are dots among them.
  const steps: StripStep[] = [];
  if (thought && reasoning) {
    steps.push({
      row: "lead",
      kind: "thought",
      title: reasoningTitle || t("thinkingAbout"),
      state: reasoningActive ? "running" : "done",
    });
  }
  rows.forEach((row, i) => {
    if (row.type === "group") {
      const last = row.glances[row.glances.length - 1];
      steps.push({
        row: String(i),
        kind: last?.tone ?? row.kind,
        title: row.glances.length > 1
          ? row.glances.map((g) => g.text).join(" · ")
          : (last?.text ?? ""),
        state: row.glances.some((g) => g.failed)
          ? "failed"
          : isRunning && i === rows.length - 1
            ? "running"
            : "done",
      });
    } else if (row.thought) {
      steps.push({
        row: String(i),
        kind: "thought",
        title: row.title || t("thinkingAbout"),
        state: row.active ? "running" : "done",
      });
    } else {
      steps.push({
        row: String(i),
        kind: "note",
        title: row.title || t("update"),
        state: row.live ? "running" : "done",
      });
    }
  });

  return (
    <TimelineFold
      settled={turnSettled}
      running={!turnSettled && isRunning}
      label={summarizeWork(rows, thought)}
      icons={iconsFor(rows, thought)}
      steps={steps}
      // "Thinking" only while thinking is all there is; once it writes or
      // runs anything the header says "Working".
      thinkingOnly={rows.every((r) => r.type !== "group" && r.thought)}
      trailing={trailing}
      durationMs={durationMs}
    >
      <WorkLog
        rows={rows}
        leading={thought ? reasoning : null}
        images={looseImages}
        hiddenCount={hiddenCount}
        isRunning={isRunning}
        stepCount={stepCount}
        durationMs={durationMs}
      />
    </TimelineFold>
  );
}
