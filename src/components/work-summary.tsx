"use client";

import type { StepKind } from "lib/ai/tools/step-kind";
import type { InlineImage } from "lib/chat-ux/inline-images";
import { cn } from "lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { WorkLog, type WorkLogRow } from "./work-log";

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

/**
 * A run of thinking and tool calls folded into one quiet row that opens on
 * click. While the run is still going its details stay open; once it settles
 * they fold unless the reader already chose a state.
 */
function Fold({
  settled,
  label,
  children,
}: {
  settled: boolean;
  label: string;
  children: ReactNode;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !settled;
  if (!settled || !label) return <>{children}</>;
  return (
    <div className="flex flex-col w-full" data-testid="work-summary">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 self-start text-left text-sm py-0.5 rounded-sm",
          "text-muted-foreground hover:text-foreground transition-colors",
        )}
      >
        <span className="truncate">{label}</span>
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )}
      </button>
      {open ? <div className="pl-1">{children}</div> : null}
    </div>
  );
}

type Segment =
  | { type: "prose"; row: WorkLogRow }
  | { type: "work"; rows: WorkLogRow[] };

/**
 * The turn's work, one fold per run of tool calls. Prose the agent wrote
 * between runs stays visible, so the page reads: fold, sentence, fold,
 * sentence. Thinking joins the first run.
 */
export function FoldedWork({
  rows,
  thought,
  reasoning,
  turnSettled,
  isRunning,
  images,
  stepCount,
  durationMs,
  hiddenCount,
}: {
  rows: WorkLogRow[];
  thought: boolean;
  reasoning: ReactNode;
  turnSettled: boolean;
  isRunning: boolean;
  images: InlineImage[];
  stepCount: number;
  durationMs?: number;
  hiddenCount?: number;
}) {
  const segments = useMemo(() => {
    const out: Segment[] = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (row.type === "prose") out.push({ type: "prose", row });
      else if (last?.type === "work") last.rows.push(row);
      else out.push({ type: "work", rows: [row] });
    }
    if (out[0]?.type !== "work" && thought) {
      out.unshift({ type: "work", rows: [] });
    }
    return out;
  }, [rows, thought]);

  // Images no row carries are shown once, with the first run.
  const looseImages = useMemo(() => {
    const inRows = new Set<string>();
    for (const r of rows) {
      if (r.type === "group") r.images?.forEach((i) => inRows.add(i.src));
    }
    return images.filter((i) => !inRows.has(i.src));
  }, [images, rows]);

  const firstWork = segments.findIndex((s) => s.type === "work");

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "prose") {
          return (
            <WorkLog
              key={i}
              rows={[seg.row]}
              isRunning={false}
              stepCount={stepCount}
            />
          );
        }
        const isLast = i === segments.length - 1;
        const settled = turnSettled || !isLast;
        const withThought = i === firstWork && thought;
        return (
          <Fold
            key={i}
            settled={settled}
            label={summarizeWork(seg.rows, withThought)}
          >
            {withThought ? reasoning : null}
            <WorkLog
              rows={seg.rows}
              images={i === firstWork ? looseImages : undefined}
              hiddenCount={hiddenCount}
              isRunning={isRunning && isLast}
              stepCount={stepCount}
              durationMs={durationMs}
            />
          </Fold>
        );
      })}
      {/* Thinking that has not produced a run yet (live, before any tool). */}
      {firstWork === -1 && thought ? reasoning : null}
    </>
  );
}
