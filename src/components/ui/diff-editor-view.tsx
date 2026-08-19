"use client";

import { cn } from "lib/utils";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileDiffIcon,
  Maximize2Icon,
  UnfoldVerticalIcon,
  XCircleIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";

export type DiffStatus = "pending" | "success" | "error";

/**
 * One contiguous region of a file, in both of its states.
 *
 * A whole-file diff is a single section. Several sections mean the view is
 * showing fragments -- the legacy path, where all anyone kept was the tool's
 * few-line hunk preview -- and the header says so rather than letting a
 * fragment pass for the file.
 */
export interface DiffSection {
  before: string;
  after: string;
  /** 1-based file line that `before`/`after` begin at. */
  startLine: number;
}

export interface DiffEditorViewProps {
  path: string;
  sections: DiffSection[];
  added: number;
  removed: number;
  status: DiffStatus;
  errorText?: string;
  /** e.g. multi_edit's atomic-failure note. Shown under a failed body. */
  note?: string;
  /** The file was too large to ship whole; this is the area around the change. */
  windowed?: boolean;
  className?: string;
  hideMaximize?: boolean;
  forceExpanded?: boolean;
  maxBodyHeight?: string;
}

/** Drops the single trailing empty string a trailing newline produces. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/* -------------------------------------------------------------------- */
/* Reading an edit tool's output                                         */
/* -------------------------------------------------------------------- */

/**
 * Turns edit_file/multi_edit's observation into sections to render.
 *
 * Two shapes, because two eras. `ui_view` is the whole file (or a wide window
 * of it) that the backend now ships alongside the result specifically for
 * this view. Messages written before that existed only kept the tool's own
 * few-line hunk preview, so they fall back to rendering those fragments --
 * which is worth doing rather than showing an old thread nothing at all.
 *
 * Exported and pure so both call sites -- the presenter and the workflow node
 * face -- read a result the same way.
 */
export function sectionsFromEditOutput(output: any): {
  sections: DiffSection[];
  windowed: boolean;
} {
  const view = output?.ui_view;
  if (
    view &&
    typeof view.before === "string" &&
    typeof view.after === "string"
  ) {
    return {
      sections: [
        {
          before: view.before,
          after: view.after,
          startLine: view.start_line ?? 1,
        },
      ],
      windowed: Boolean(view.windowed),
    };
  }

  const edits = Array.isArray(output?.edits) ? output.edits : [];
  const sections: DiffSection[] = [];
  for (const edit of edits) {
    const hunk: string[] = Array.isArray(edit?.hunk) ? edit.hunk : [];
    const before: string[] = [];
    const after: string[] = [];
    for (const line of hunk) {
      if (line.startsWith("+")) after.push(line.slice(1));
      else if (line.startsWith("-")) before.push(line.slice(1));
    }
    if (before.length === 0 && after.length === 0) continue;
    sections.push({
      before: before.join("\n"),
      after: after.join("\n"),
      startLine: edit?.at_line ?? 1,
    });
  }
  // Fragments, never the file -- say so, so the gutter's line numbers are
  // read as "around here" rather than as the whole story.
  return { sections, windowed: sections.length > 0 };
}

/* -------------------------------------------------------------------- */
/* Line-level diff (which lines are shared, removed, or added)          */
/* -------------------------------------------------------------------- */

export type LineOp =
  | { type: "equal"; text: string }
  | { type: "delete"; text: string }
  | { type: "insert"; text: string };

/**
 * A classic LCS backtrack over two line arrays.
 *
 * Quadratic, and bounded by the payload cap the backend applies before
 * sending a file (see tools.maxDiffViewBytes) -- a few thousand lines a side
 * at worst, which is milliseconds. What it buys is real alignment: an
 * unchanged line appears once, on both sides, instead of being crossed out
 * and retyped, which is the difference between reading a diff and decoding
 * one.
 */
export function lineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "equal", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "delete", text: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "insert", text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "delete", text: oldLines[i++] });
  while (j < m) ops.push({ type: "insert", text: newLines[j++] });
  return ops;
}

/* -------------------------------------------------------------------- */
/* Character-level diff (which part of a changed line actually moved)   */
/* -------------------------------------------------------------------- */

export interface Segment {
  text: string;
  changed: boolean;
}

/**
 * Trims the common prefix and suffix off a changed line pair, so only the
 * part that actually differs takes the stronger highlight -- a renamed
 * identifier reads as one word inside an otherwise calm line, instead of the
 * whole line shouting.
 */
export function charDiff(a: string, b: string): { a: Segment[]; b: Segment[] } {
  const maxCommon = Math.min(a.length, b.length);
  let start = 0;
  while (start < maxCommon && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < maxCommon - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }

  const build = (text: string): Segment[] => {
    const segments: Segment[] = [];
    if (start > 0)
      segments.push({ text: text.slice(0, start), changed: false });
    const mid = text.slice(start, text.length - end);
    if (mid) segments.push({ text: mid, changed: true });
    if (end > 0)
      segments.push({ text: text.slice(text.length - end), changed: false });
    return segments.length > 0 ? segments : [{ text, changed: false }];
  };

  return { a: build(a), b: build(b) };
}

/* -------------------------------------------------------------------- */
/* Rows                                                                  */
/* -------------------------------------------------------------------- */

export interface DiffCell {
  text: string;
  tone: "context" | "removed" | "added";
  segments?: Segment[];
}

export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
  leftNo: number | null;
  rightNo: number | null;
  changed: boolean;
}

/**
 * Pairs one section's two sides into aligned rows.
 *
 * A run of deletes immediately followed by a run of inserts -- one block
 * replacing another -- pairs up position by position, which is what makes a
 * modified line show as a single red/green pair rather than a wall of
 * removals stacked above a wall of additions. Whichever run is longer leaves
 * blank filler on the other side, keeping the two panes on the same rows.
 *
 * Both panes render from this one list, so they cannot drift out of
 * alignment no matter what the text does.
 */
export function buildDiffRows(
  beforeText: string,
  afterText: string,
  startLine = 1,
): DiffRow[] {
  const ops = lineDiff(splitLines(beforeText), splitLines(afterText));
  const rows: DiffRow[] = [];
  let leftNo = startLine;
  let rightNo = startLine;

  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "equal") {
      const text = ops[i].text;
      rows.push({
        left: { text, tone: "context" },
        right: { text, tone: "context" },
        leftNo: leftNo++,
        rightNo: rightNo++,
        changed: false,
      });
      i++;
      continue;
    }

    const deletes: string[] = [];
    while (i < ops.length && ops[i].type === "delete")
      deletes.push(ops[i++].text);
    const inserts: string[] = [];
    while (i < ops.length && ops[i].type === "insert")
      inserts.push(ops[i++].text);

    for (let k = 0; k < Math.max(deletes.length, inserts.length); k++) {
      const oldText = deletes[k];
      const newText = inserts[k];
      if (oldText !== undefined && newText !== undefined) {
        const d = charDiff(oldText, newText);
        rows.push({
          left: { text: oldText, tone: "removed", segments: d.a },
          right: { text: newText, tone: "added", segments: d.b },
          leftNo: leftNo++,
          rightNo: rightNo++,
          changed: true,
        });
      } else if (oldText !== undefined) {
        rows.push({
          left: { text: oldText, tone: "removed" },
          right: null,
          leftNo: leftNo++,
          rightNo: null,
          changed: true,
        });
      } else {
        rows.push({
          left: null,
          right: { text: newText, tone: "added" },
          leftNo: null,
          rightNo: rightNo++,
          changed: true,
        });
      }
    }
  }
  return rows;
}

export type DiffBlock =
  | { kind: "rows"; rows: DiffRow[] }
  | { kind: "gap"; rows: DiffRow[] };

/**
 * Folds long stretches of untouched code into an expandable band.
 *
 * This is what makes a whole-file diff readable rather than merely complete:
 * a 900-line file with a two-line edit should open showing the edit, not
 * demand nine hundred lines of scrolling to find it. `context` lines stay
 * visible on each side of every change, and the fold is only worth drawing
 * when it hides more lines than the band itself occupies.
 */
export function collapseRows(
  rows: DiffRow[],
  context = 3,
  minHidden = 4,
): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const pushRows = (chunk: DiffRow[]) => {
    if (chunk.length === 0) return;
    const last = blocks[blocks.length - 1];
    if (last?.kind === "rows") last.rows.push(...chunk);
    else blocks.push({ kind: "rows", rows: chunk });
  };

  let i = 0;
  while (i < rows.length) {
    if (rows[i].changed) {
      pushRows([rows[i]]);
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && !rows[end].changed) end++;
    const run = rows.slice(i, end);

    // Leading and trailing runs need context on one side only -- there is no
    // change above the first run or below the last.
    const head = i === 0 ? 0 : context;
    const tail = end === rows.length ? 0 : context;
    const hidden = run.length - head - tail;
    if (hidden < minHidden) {
      pushRows(run);
    } else {
      pushRows(run.slice(0, head));
      blocks.push({ kind: "gap", rows: run.slice(head, run.length - tail) });
      pushRows(run.slice(run.length - tail));
    }
    i = end;
  }
  return blocks;
}

/* -------------------------------------------------------------------- */
/* Rendering                                                             */
/* -------------------------------------------------------------------- */

/**
 * Tracks whether the view is too narrow for two panes.
 *
 * Measured on the element, not the viewport: this same component renders in
 * a 320px side panel and in a full-screen dialog, and only the element knows
 * which. Below the threshold it falls back to a unified diff, the way every
 * editor and code host does, rather than squeezing two columns into a space
 * that fits neither.
 */
function useIsNarrow(
  ref: React.RefObject<HTMLElement | null>,
  threshold = 620,
) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < threshold);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return narrow;
}

const CODE_TINT: Record<DiffCell["tone"], string> = {
  context: "",
  removed: "bg-rose-500/10",
  added: "bg-emerald-500/10",
};

const MARK_TINT: Record<DiffCell["tone"], string> = {
  context: "",
  removed: "bg-rose-500/30",
  added: "bg-emerald-500/25",
};

const TEXT_TONE: Record<DiffCell["tone"], string> = {
  context: "text-zinc-400",
  removed: "text-rose-100",
  added: "text-emerald-50",
};

/** Line height and gutter width are shared constants because the two panes
 *  must agree on them exactly or the rows stop lining up. */
const ROW_H = "h-[1.125rem] leading-[1.125rem]";
const GUTTER_W = "w-11";

function CellText({ cell }: { cell: DiffCell }) {
  if (!cell.segments) return <>{cell.text || " "}</>;
  return (
    <>
      {cell.segments.map((seg, i) => (
        <span key={i} className={cn(seg.changed && MARK_TINT[cell.tone])}>
          {seg.text}
        </span>
      ))}
    </>
  );
}

function CodeRow({
  cell,
  lineNo,
  sign,
}: {
  cell: DiffCell | null;
  lineNo: number | null;
  /** Shown in unified mode, where a row has no opposite side to compare to. */
  sign?: boolean;
}) {
  const tone = cell?.tone ?? "context";
  return (
    <div className={cn("flex", ROW_H)}>
      {/* Pinned so the line numbers stay put when a long line scrolls the
          code sideways -- an unpinned gutter slides away exactly when you
          most need to know where you are. */}
      <span
        className={cn(
          "sticky left-0 z-10 shrink-0 select-none bg-zinc-950 pr-2 text-right tabular-nums text-zinc-600 border-r border-zinc-800/70",
          GUTTER_W,
        )}
      >
        {lineNo ?? ""}
      </span>
      <span
        className={cn(
          "flex-1 whitespace-pre pl-3 pr-6",
          CODE_TINT[tone],
          TEXT_TONE[tone],
          !cell && "bg-zinc-900/40",
        )}
      >
        {cell ? (
          <>
            {sign ? (
              <span
                className={cn(
                  "select-none",
                  tone === "removed"
                    ? "text-rose-400"
                    : tone === "added"
                      ? "text-emerald-400"
                      : "text-transparent",
                )}
              >
                {tone === "removed" ? "-" : tone === "added" ? "+" : " "}{" "}
              </span>
            ) : null}
            <CellText cell={cell} />
          </>
        ) : (
          " "
        )}
      </span>
    </div>
  );
}

function GapBand({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={cn(
        "flex w-full items-center gap-2 bg-zinc-900/70 pl-3 pr-6 text-zinc-500",
        "hover:bg-zinc-800/70 hover:text-zinc-300 transition-colors",
        ROW_H,
      )}
    >
      <UnfoldVerticalIcon className="size-3 shrink-0" />
      <span className="truncate">
        {count} unchanged {count === 1 ? "line" : "lines"}
      </span>
    </button>
  );
}

/** One scrollable column of code. */
function Pane({
  blocks,
  side,
  expanded,
  onExpand,
  scrollRef,
  onScroll,
  unified,
}: {
  blocks: DiffBlock[];
  side: "left" | "right";
  expanded: Set<number>;
  onExpand: (index: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  unified?: boolean;
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-w-0 flex-1 overflow-auto scrollbar-thin"
    >
      {/* Sized to the longest line so the pane scrolls horizontally instead
          of letting non-wrapping code spill into the other column. */}
      <div className="min-w-max">
        {blocks.map((block, bi) => {
          if (block.kind === "gap" && !expanded.has(bi)) {
            // Rendered in both panes so the two stay on the same rows.
            return (
              <GapBand
                key={bi}
                count={block.rows.length}
                onExpand={() => onExpand(bi)}
              />
            );
          }
          return block.rows.map((row, ri) => {
            if (unified) {
              return (
                <CodeRow
                  key={`${bi}-${ri}`}
                  cell={row.left ?? row.right}
                  lineNo={row.leftNo ?? row.rightNo}
                  sign
                />
              );
            }
            return (
              <CodeRow
                key={`${bi}-${ri}`}
                cell={side === "left" ? row.left : row.right}
                lineNo={side === "left" ? row.leftNo : row.rightNo}
              />
            );
          });
        })}
      </div>
    </div>
  );
}

function UnifiedRows({
  blocks,
  expanded,
  onExpand,
  scrollRef,
}: {
  blocks: DiffBlock[];
  expanded: Set<number>;
  onExpand: (index: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={scrollRef}
      className="min-w-0 flex-1 overflow-auto scrollbar-thin"
    >
      <div className="min-w-max">
        {blocks.map((block, bi) => {
          if (block.kind === "gap" && !expanded.has(bi)) {
            return (
              <GapBand
                key={bi}
                count={block.rows.length}
                onExpand={() => onExpand(bi)}
              />
            );
          }
          // A replaced line becomes two rows here, removed above added --
          // that is what "unified" means, there being no second column to put
          // the new text in. An unchanged line is only emitted once, from the
          // left, since both sides hold the same text.
          return block.rows.flatMap((row, ri) =>
            [
              row.left && (
                <CodeRow
                  key={`${bi}-${ri}-l`}
                  cell={row.left}
                  lineNo={row.leftNo}
                  sign
                />
              ),
              row.changed && row.right && (
                <CodeRow
                  key={`${bi}-${ri}-r`}
                  cell={row.right}
                  lineNo={row.rightNo}
                  sign
                />
              ),
            ].filter(Boolean),
          );
        })}
      </div>
    </div>
  );
}

function DiffStatBadge({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const addedPct = total > 0 ? (added / total) * 100 : 0;
  return (
    <span className="flex items-center gap-2 shrink-0">
      <span className="flex items-center gap-1.5 text-[11px] font-mono whitespace-nowrap">
        <span className="text-emerald-400">+{added}</span>
        <span className="text-rose-400">−{removed}</span>
      </span>
      {total > 0 && (
        <span className="hidden sm:flex h-1 w-12 overflow-hidden rounded-full bg-zinc-800">
          <span
            className="h-full bg-emerald-400"
            style={{ width: `${addedPct}%` }}
          />
          <span
            className="h-full bg-rose-400"
            style={{ width: `${100 - addedPct}%` }}
          />
        </span>
      )}
    </span>
  );
}

function StatusBadge({ status }: { status: DiffStatus }) {
  if (status === "pending") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded shrink-0 whitespace-nowrap">
        <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
        Applying
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/30 px-2 py-0.5 rounded shrink-0 whitespace-nowrap">
        <XCircleIcon className="size-3" />
        Not applied
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded shrink-0 whitespace-nowrap">
      <CheckIcon className="size-3" />
      Applied
    </span>
  );
}

function diffToText(path: string, sections: DiffSection[]): string {
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const section of sections) {
    const rows = buildDiffRows(
      section.before,
      section.after,
      section.startLine,
    );
    for (const row of rows) {
      if (!row.changed) {
        out.push(` ${row.left?.text ?? ""}`);
        continue;
      }
      if (row.left) out.push(`-${row.left.text}`);
      if (row.right) out.push(`+${row.right.text}`);
    }
  }
  return out.join("\n");
}

function PureDiffEditorView({
  path,
  sections,
  added,
  removed,
  status,
  errorText,
  note,
  windowed,
  className,
  hideMaximize,
  forceExpanded,
  maxBodyHeight,
}: DiffEditorViewProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(new Set());

  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const unifiedRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const narrow = useIsNarrow(rootRef);

  const blocks = useMemo(
    () =>
      collapseRows(
        sections.flatMap((section) =>
          buildDiffRows(section.before, section.after, section.startLine),
        ),
      ),
    [sections],
  );

  // Scroll sync: the two panes are separate scroll containers (which is what
  // stops long lines in one column from spilling into the other), so they
  // have to be kept on the same line by hand. The guard stops the two
  // onScroll handlers from bouncing the event back and forth; releasing it on
  // the next frame keeps dragging a scrollbar 1:1 rather than fighting it.
  const syncFrom = useCallback(
    (from: React.RefObject<HTMLDivElement | null>) => () => {
      if (syncing.current) return;
      const source = from.current;
      const target = (from === leftRef ? rightRef : leftRef).current;
      if (!source || !target) return;
      syncing.current = true;
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        syncing.current = false;
      });
    },
    [],
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(diffToText(path, sections));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const expandGap = useCallback((index: number) => {
    setExpandedGaps((prev) => new Set(prev).add(index));
  }, []);

  const isOpen = forceExpanded ?? open;
  const name = path.split("/").pop() || path;
  const hasRows = blocks.some((b) => b.rows.length > 0);

  const body = (() => {
    if (status === "error") {
      return (
        <div className="rounded-b-lg border border-t-0 border-zinc-800 bg-zinc-950 p-3 space-y-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-rose-300">
            {errorText || "the anchor did not match; nothing was written"}
          </pre>
          {note && (
            <div className="border-t border-zinc-800 pt-2 text-[11px] italic text-zinc-500">
              {note}
            </div>
          )}
        </div>
      );
    }
    if (status === "pending") {
      return (
        <div className="rounded-b-lg border border-t-0 border-zinc-800 bg-zinc-950 p-3">
          <span className="animate-pulse text-xs text-zinc-500">
            Applying edit…
          </span>
        </div>
      );
    }
    if (!hasRows) {
      return (
        <div className="rounded-b-lg border border-t-0 border-zinc-800 bg-zinc-950 p-3">
          <span className="text-xs italic text-zinc-600">
            No changes to show.
          </span>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "relative flex flex-col overflow-hidden rounded-b-lg border border-t-0 border-zinc-800 bg-zinc-950 font-mono text-xs",
          maxBodyHeight ?? "max-h-[480px]",
        )}
      >
        {!narrow && (
          <div className="flex shrink-0 border-b border-zinc-800 bg-zinc-900/80 text-[11px] font-medium text-zinc-500">
            <div className="flex-1 px-3 py-1">Before</div>
            <div className="flex-1 border-l border-zinc-800 px-3 py-1">
              After
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {narrow ? (
            <UnifiedRows
              blocks={blocks}
              expanded={expandedGaps}
              onExpand={expandGap}
              scrollRef={unifiedRef}
            />
          ) : (
            <>
              <Pane
                blocks={blocks}
                side="left"
                expanded={expandedGaps}
                onExpand={expandGap}
                scrollRef={leftRef}
                onScroll={syncFrom(leftRef)}
              />
              <div className="w-px shrink-0 bg-zinc-800" />
              <Pane
                blocks={blocks}
                side="right"
                expanded={expandedGaps}
                onExpand={expandGap}
                scrollRef={rightRef}
                onScroll={syncFrom(rightRef)}
              />
            </>
          )}
        </div>

        <div className="absolute right-2 top-8">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 border border-zinc-700/60 bg-zinc-900/90 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={handleCopy}
            title="Copy diff"
          >
            {copied ? (
              <CheckIcon className="size-3 text-emerald-400" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        </div>
      </div>
    );
  })();

  return (
    <div
      ref={rootRef}
      className={cn("flex w-full flex-col text-xs", className)}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 sm:flex-nowrap">
        {!forceExpanded && (
          <Button
            variant="ghost"
            size="icon"
            className="order-1 size-6 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => setOpen((v) => !v)}
          >
            {isOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </Button>
        )}

        <FileDiffIcon className="order-2 size-4 shrink-0 text-zinc-400" />

        <span
          className="order-4 min-w-0 flex-1 basis-full truncate font-mono font-semibold text-zinc-100 sm:order-3 sm:basis-auto"
          title={path}
        >
          {name}
        </span>

        {windowed && status === "success" && (
          <span
            className="order-5 hidden shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 md:inline"
            title="The file was too large to show whole; this is the area around the change."
          >
            partial file
          </span>
        )}

        <div className="order-3 ml-auto flex shrink-0 items-center gap-2 sm:order-6">
          {status === "success" && (
            <DiffStatBadge added={added} removed={removed} />
          )}
          <StatusBadge status={status} />

          {!hideMaximize && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={() => setDialogOpen(true)}
              title="Open full diff"
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {isOpen && body}

      {!hideMaximize && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="flex h-[85vh] w-[95vw] sm:max-w-6xl flex-col gap-3 p-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 truncate font-mono text-sm">
                <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{path}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                Side-by-side diff for {path}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col text-xs">
              <DiffEditorView
                path={path}
                sections={sections}
                added={added}
                removed={removed}
                status={status}
                errorText={errorText}
                note={note}
                windowed={windowed}
                forceExpanded
                hideMaximize
                maxBodyHeight="flex-1 h-full max-h-none"
                className="min-h-0 flex-1"
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export const DiffEditorView = memo(PureDiffEditorView);
DiffEditorView.displayName = "DiffEditorView";

/**
 * Node-face preview: filename, counts, and the first changed line. Clicking
 * anywhere opens the full side-by-side diff, the same gesture the terminal
 * nodes already teach.
 */
function PureDiffEditorViewCompact({
  path,
  sections,
  added,
  removed,
  status,
  errorText,
  note,
  windowed,
}: DiffEditorViewProps) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() || path;

  const preview = useMemo(() => {
    if (status !== "success") return null;
    for (const section of sections) {
      const row = buildDiffRows(
        section.before,
        section.after,
        section.startLine,
      ).find((r) => r.changed);
      if (row) return row.right ?? row.left;
    }
    return null;
  }, [sections, status]);

  return (
    <>
      <button
        type="button"
        className="flex w-full flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-left text-[11px] transition-colors hover:border-zinc-700"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Open the full diff"
      >
        <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-2 py-1.5">
          <FileDiffIcon className="size-3 shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate font-mono font-medium text-zinc-100">
            {name}
          </span>
          {status === "success" && (
            <DiffStatBadge added={added} removed={removed} />
          )}
          <StatusBadge status={status} />
        </div>
        <div className="truncate px-2 py-1.5 font-mono text-zinc-400">
          {status === "pending" ? (
            <span className="animate-pulse italic">Applying edit…</span>
          ) : status === "error" ? (
            <span className="truncate text-rose-400">
              {errorText || "edit not applied"}
            </span>
          ) : preview ? (
            <span
              className={cn(
                "truncate",
                preview.tone === "added" ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {preview.tone === "added" ? "+" : "-"} {preview.text}
            </span>
          ) : (
            <span className="italic text-zinc-600">No changes to show.</span>
          )}
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex h-[85vh] w-[95vw] sm:max-w-6xl flex-col gap-3 p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 truncate font-mono text-sm">
              <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{path}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Side-by-side diff for {path}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col text-xs">
            <DiffEditorView
              path={path}
              sections={sections}
              added={added}
              removed={removed}
              status={status}
              errorText={errorText}
              note={note}
              windowed={windowed}
              forceExpanded
              hideMaximize
              maxBodyHeight="flex-1 h-full max-h-none"
              className="min-h-0 flex-1"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const DiffEditorViewCompact = memo(PureDiffEditorViewCompact);
DiffEditorViewCompact.displayName = "DiffEditorViewCompact";
