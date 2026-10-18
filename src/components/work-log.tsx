"use client";

import {
  type EditRowSummary,
  type StepKind,
  formatDuration,
  stepGroupLabel,
} from "lib/ai/tools/step-kind";
import type { InlineImage } from "lib/chat-ux/inline-images";
import { cn } from "lib/utils";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type ReactNode,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TextShimmer } from "ui/text-shimmer";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { InlineImageStrip } from "./workspace/inline-images";
import { PresenterSurface } from "./tool-presenters/surface";

/** One row in the log: either a group of tool calls or a block of prose. */
export type WorkLogRow =
  | {
      type: "group";
      kind: StepKind;
      /** Per-call glance lines, shown collapsed under the group header. */
      glances: {
        text: string;
        failed: boolean;
        /**
         * Replaces the text when set -- a todo write reads better as a
         * checklist delta than as "Updated todos". `text` is still filled in
         * because the header pill uses it as the running step's name.
         */
        node?: ReactNode;
      }[];
      /**
       * Images this group's tools returned. Shown under the glance lines
       * even while the row is collapsed, so a screenshot is never behind a
       * click.
       */
      images?: InlineImage[];
      /**
       * Set on a row about one specific file, which replaces the counted
       * label with the file's name and its +/- counts. Only writes get this
       * -- see editRowSummary for why reads deliberately stay a count.
       */
      file?: EditRowSummary;
      children: ReactNode;
    }
  | { type: "prose"; children: ReactNode };

/**
 * Ticks once a second, but only while something is actually running.
 *
 * A plain setInterval in the component would keep re-rendering every
 * finished message in a long thread forever. Subscribing lazily means a
 * completed log costs nothing.
 */
function useNow(active: boolean): number {
  return useSyncExternalStore(
    (onChange) => {
      if (!active) return () => {};
      const id = setInterval(onChange, 1000);
      return () => clearInterval(id);
    },
    () => (active ? Math.floor(Date.now() / 1000) * 1000 : 0),
    () => 0,
  );
}

function GroupRow({
  row,
  running,
}: {
  row: Extract<WorkLogRow, { type: "group" }>;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const failed = row.glances.some((g) => g.failed);
  // The shimmer loops forever, so reduced-motion users get plain text
  // (the spinner next to the label already says the row is live).
  const reducedMotion = usePrefersReducedMotion();
  const images = row.images?.length ? (
    <InlineImageStrip images={row.images} size="md" />
  ) : null;

  // A named file row's card (a colored +N/-M stat that opens the full
  // side-by-side diff on click, or a create/overwrite badge) already says
  // everything the chevron+glance header would, in a form that's directly
  // interactive -- so it renders straight away instead of waiting for a
  // second click to reveal what the first click already named.
  if (row.file) {
    return (
      <div className="flex flex-col py-0.5">
        {row.children}
        {images}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group/row flex items-center gap-1.5 text-left text-xs py-1 rounded-sm",
          "text-muted-foreground hover:text-foreground transition-colors",
        )}
      >
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        {running ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
        ) : failed ? (
          <TriangleAlertIcon className="size-3 shrink-0 text-destructive" />
        ) : null}
        <span className={cn("truncate", failed && "text-destructive")}>
          {stepGroupLabel(row.kind, row.glances.length, running)}
        </span>
      </button>

      {/* Collapsed: one glance line per call, so the row still says what
          happened without being expanded into full tool cards. */}
      {!open ? (
        <div className="pl-[18px] flex flex-col">
          {row.glances.map((g, i) =>
            g.node ? (
              <div key={i} className="min-w-0 leading-5">
                {g.node}
              </div>
            ) : running && !g.failed && !reducedMotion ? (
              <TextShimmer
                key={i}
                as="span"
                className="block max-w-full text-[11px] truncate leading-5"
              >
                {g.text}
              </TextShimmer>
            ) : (
              <span
                key={i}
                className={cn(
                  "text-[11px] truncate leading-5",
                  g.failed ? "text-destructive" : "text-muted-foreground/70",
                )}
              >
                {g.text}
              </span>
            ),
          )}
        </div>
      ) : (
        <div className="pl-[18px] flex flex-col gap-2 py-1">{row.children}</div>
      )}
      {images ? <div className="pl-[18px]">{images}</div> : null}
    </div>
  );
}

export const WorkLog = memo(function WorkLog({
  rows,
  isRunning,
  stepCount,
  durationMs,
  hiddenCount = 0,
  images,
}: {
  rows: WorkLogRow[];
  isRunning: boolean;
  stepCount: number;
  /**
   * How long the turn worked, as measured by the server and carried on the
   * message.
   *
   * The browser can only time a turn it watched happen, so this is the only
   * number a reopened thread has -- and on a turn split by approvals it is
   * also the only *correct* one, since the server excludes the stretches
   * that were spent waiting for the user to answer.
   */
  durationMs?: number;
  /** Tool calls the transcript filter removed from `rows`. */
  hiddenCount?: number;
  /**
   * Every image the turn's tools returned, including ones from filtered-out
   * calls. WorkLog decides where they show: under the header while collapsed,
   * and -- while open -- only those no visible row already carries.
   */
  images?: InlineImage[];
}) {
  // Expanded while running so the user can watch; auto-minimizes smoothly
  // into a summary pill bar when completed.
  const [open, setOpen] = useState(isRunning);
  const wasRunningPrev = useRef(isRunning);

  useEffect(() => {
    if (wasRunningPrev.current && !isRunning) {
      setOpen(false);
    } else if (!wasRunningPrev.current && isRunning) {
      setOpen(true);
    }
    wasRunningPrev.current = isRunning;
  }, [isRunning]);

  // Duration is measured, never guessed. While the turn is running the
  // clock is local, because there is no message metadata until it finishes;
  // once it finishes the server's figure wins, because it is the one that
  // survives a reload and the one that already excludes time spent waiting
  // on an approval.
  const runStartedAt = useRef<number | null>(null);
  const runBaseMs = useRef(0);
  const wasRunning = useRef(false);
  const measuredMs = useRef<number | null>(null);

  // `now` both re-renders once a second and supplies the clock, so render
  // stays a function of its inputs rather than of whenever React happened
  // to call it.
  const now = useNow(isRunning);

  if (isRunning && !wasRunning.current) {
    runStartedAt.current = Date.now();
    runBaseMs.current = durationMs ?? measuredMs.current ?? 0;
  }
  if (!isRunning && wasRunning.current && runStartedAt.current !== null) {
    measuredMs.current =
      runBaseMs.current + (Date.now() - runStartedAt.current);
  }
  wasRunning.current = isRunning;

  const elapsed = isRunning
    ? runBaseMs.current +
      Math.max(0, (now || Date.now()) - (runStartedAt.current ?? now))
    : (durationMs ?? measuredMs.current);

  const hasError = useMemo(() => {
    return rows.some(
      (r) => r.type === "group" && r.glances.some((g) => g.failed),
    );
  }, [rows]);

  const editTotals = useMemo(() => {
    let added = 0;
    let removed = 0;
    let fileCount = 0;
    for (const r of rows) {
      if (r.type === "group" && r.file) {
        fileCount++;
        if (typeof r.file.added === "number") added += r.file.added;
        if (typeof r.file.removed === "number") removed += r.file.removed;
      }
    }
    return { added, removed, fileCount };
  }, [rows]);

  const activeStepGlance = useMemo(() => {
    if (!isRunning) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.type === "group" && row.glances.length > 0) {
        const last = row.glances[row.glances.length - 1];
        return last.text;
      }
    }
    return null;
  }, [rows, isRunning]);

  // Open: rows already show their own images, so only the orphans (from
  // calls the filter removed) go under the header. Collapsed: no rows are
  // visible, so everything does. Either way no image appears twice.
  const stripImages = useMemo(() => {
    if (!images?.length) return [];
    if (!open) return images;
    const inRows = new Set<string>();
    for (const r of rows) {
      if (r.type === "group") r.images?.forEach((img) => inRows.add(img.src));
    }
    return images.filter((img) => !inRows.has(img.src));
  }, [images, rows, open]);

  // Every call filtered out: no header to draw, but the images must stay.
  if (!rows.length) {
    return images?.length ? (
      <InlineImageStrip images={images} size="sm" />
    ) : null;
  }

  const hiddenSuffix = hiddenCount > 0 ? ` · ${hiddenCount} hidden` : "";
  const headerText =
    (isRunning
      ? `Working… ${formatDuration(elapsed ?? 0)}`
      : elapsed !== null && elapsed !== undefined
        ? `Worked for ${formatDuration(elapsed)} · ${stepCount} ${stepCount === 1 ? "step" : "steps"}`
        : `Worked · ${stepCount} ${stepCount === 1 ? "step" : "steps"}`) +
    hiddenSuffix;

  return (
    <div className="flex flex-col w-full my-1 select-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group/worklog flex items-center gap-2 text-xs py-1 px-2.5 rounded-lg border transition-all text-left w-fit max-w-full",
          isRunning
            ? "border-primary/30 bg-primary/5 text-foreground hover:bg-primary/10"
            : hasError
              ? "border-amber-500/30 bg-card text-muted-foreground hover:text-foreground hover:bg-muted/30"
              : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/30",
        )}
      >
        {isRunning ? (
          <div className="relative flex items-center justify-center shrink-0 size-3.5">
            <span className="absolute size-2.5 rounded-full bg-primary/30 animate-ping" />
            <Loader2Icon className="size-3.5 animate-spin text-primary" />
          </div>
        ) : hasError ? (
          <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" />
        )}

        <span className="font-medium text-foreground tracking-tight">
          {headerText}
        </span>

        {isRunning && activeStepGlance ? (
          <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-mono truncate max-w-[200px] sm:max-w-xs hidden sm:inline">
            {activeStepGlance}
          </span>
        ) : null}

        {!isRunning && editTotals.fileCount > 0 ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded-full bg-muted border shrink-0">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{editTotals.added}
            </span>
            <span className="text-destructive">−{editTotals.removed}</span>
          </span>
        ) : null}

        {!isRunning && hasError ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive border border-destructive/20 font-medium shrink-0">
            Failed
          </span>
        ) : null}

        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ml-1",
            open && "rotate-180",
          )}
        />
      </button>

      {stripImages.length ? (
        <InlineImageStrip images={stripImages} size="sm" className="mt-1" />
      ) : null}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="work-log-timeline"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <PresenterSurface value="chat">
              <div className="flex flex-col gap-1 border-l ml-2 pl-3 mt-1.5 mb-1">
                {rows.map((row, i) =>
                  row.type === "group" ? (
                    <GroupRow
                      key={i}
                      row={row}
                      running={isRunning && i === rows.length - 1}
                    />
                  ) : (
                    <div key={i} className="py-1">
                      {row.children}
                    </div>
                  ),
                )}
              </div>
            </PresenterSurface>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
