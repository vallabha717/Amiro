"use client";

import {
  type EditRowSummary,
  type StepKind,
  stepGroupLabel,
  workLogHeader,
} from "lib/ai/tools/step-kind";
import { cn } from "lib/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type ReactNode,
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PresenterSurface } from "./tool-presenters/surface";

/** One row in the log: either a group of tool calls or a block of prose. */
export type WorkLogRow =
  | {
      type: "group";
      kind: StepKind;
      /** Per-call glance lines, shown collapsed under the group header. */
      glances: { text: string; failed: boolean }[];
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

  // A named file row already says everything its glance line would, so the
  // sub-line is dropped -- except on a failure, where the glance carries the
  // reason the edit did not apply and the header cannot.
  const showGlances = !row.file || failed;

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
        {row.file ? (
          <span
            className="flex items-center gap-1.5 min-w-0"
            title={row.file.path}
          >
            <span className={cn(failed && "text-destructive")}>
              {row.file.verb}
            </span>
            <FileIcon className="size-3 shrink-0" />
            <span
              className={cn(
                "font-mono font-medium truncate",
                failed ? "text-destructive" : "text-foreground",
              )}
            >
              {row.file.name}
            </span>
            {row.file.added !== undefined ? (
              <span className="font-mono text-emerald-600 dark:text-emerald-400">
                +{row.file.added}
              </span>
            ) : null}
            {row.file.removed !== undefined ? (
              <span className="font-mono text-destructive">
                −{row.file.removed}
              </span>
            ) : null}
          </span>
        ) : (
          <span className={cn("truncate", failed && "text-destructive")}>
            {stepGroupLabel(row.kind, row.glances.length, running)}
          </span>
        )}
      </button>

      {/* Collapsed: one glance line per call, so the row still says what
          happened without being expanded into full tool cards. */}
      {!open ? (
        showGlances ? (
          <div className="pl-[18px] flex flex-col">
            {row.glances.map((g, i) => (
              <span
                key={i}
                className={cn(
                  "text-[11px] truncate leading-5",
                  g.failed ? "text-destructive" : "text-muted-foreground/70",
                )}
              >
                {g.text}
              </span>
            ))}
          </div>
        ) : null
      ) : (
        <div className="pl-[18px] flex flex-col gap-2 py-1">{row.children}</div>
      )}
    </div>
  );
}

export const WorkLog = memo(function WorkLog({
  rows,
  isRunning,
  stepCount,
  durationMs,
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
}) {
  // Expanded while running so the user can watch; folds itself away on
  // completion. Only auto-folds once -- reopening it must stick, or the
  // component fights the user on the next render.
  const [open, setOpen] = useState(isRunning);
  const autoCollapsed = useRef(false);

  useEffect(() => {
    if (!isRunning && !autoCollapsed.current) {
      autoCollapsed.current = true;
      setOpen(false);
    }
    if (isRunning) setOpen(true);
  }, [isRunning]);

  // Duration is measured, never guessed. While the turn is running the
  // clock is local, because there is no message metadata until it finishes;
  // once it finishes the server's figure wins, because it is the one that
  // survives a reload and the one that already excludes time spent waiting
  // on an approval.
  //
  // The local clock restarts on each running stretch and resumes from the
  // total so far, so a turn that stopped to ask does not count the asking:
  // the user taking two minutes over an approval card is not the agent
  // working for two minutes.
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

  const header = workLogHeader({ isRunning, elapsedMs: elapsed, stepCount });

  if (!rows.length) return null;

  return (
    <div className="flex flex-col w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 w-fit"
      >
        {isRunning ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : open ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
        <span className="font-medium">{header}</span>
      </button>

      {open ? (
        // Everything inside the log renders as a log entry, not as a full
        // record: the diff, the file body and the rest live one click away
        // in the Workflow View, where there is room for them.
        <PresenterSurface value="chat">
          <div className="flex flex-col gap-1 border-l ml-1.5 pl-3 mt-1">
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
      ) : null}
    </div>
  );
});
