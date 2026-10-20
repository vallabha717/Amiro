"use client";

import {
  type EditRowSummary,
  type StepKind,
  stepGroupLabel,
} from "lib/ai/tools/step-kind";
import type { InlineImage } from "lib/chat-ux/inline-images";
import { cn } from "lib/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type ReactNode,
  memo,
  useMemo,
  useState,
} from "react";
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

  // A single-tool group (or a named file edit row) already renders its own
  // inline collapsible ToolMessagePart description row directly, so we avoid
  // wrapping it in a redundant outer "Ran 1 command" toggle.
  if (row.file || row.glances.length === 1) {
    const singleNode = row.glances[0]?.node;
    return (
      <div data-testid="worklog-row" className="flex flex-col py-0.5">
        {row.children}
        {singleNode ? <div className="pl-5 pt-0.5">{singleNode}</div> : null}
        {images}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="worklog-row"
        aria-expanded={open}
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
          happened without being expanded into full tool cards. Clicking any
          glance description expands the inline tool details. */}
      {!open ? (
        <div
          className="pl-[18px] flex flex-col cursor-pointer"
          onClick={() => setOpen(true)}
        >
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
                  "text-[11px] truncate leading-5 hover:text-foreground transition-colors",
                  g.failed ? "text-destructive" : "text-muted-foreground/70",
                )}
              >
                {g.text}
              </span>
            ),
          )}
        </div>
      ) : (
        <div className="pl-[18px] flex flex-col gap-1.5 py-1">{row.children}</div>
      )}
      {images ? <div className="pl-[18px]">{images}</div> : null}
    </div>
  );
}

export const WorkLog = memo(function WorkLog({
  rows,
  isRunning,
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
  const stripImages = useMemo(() => {
    if (!images?.length) return [];
    const inRows = new Set<string>();
    for (const r of rows) {
      if (r.type === "group") r.images?.forEach((img) => inRows.add(img.src));
    }
    return images.filter((img) => !inRows.has(img.src));
  }, [images, rows]);

  // Every call filtered out: no header to draw, but the images must stay.
  if (!rows.length) {
    return images?.length ? (
      <InlineImageStrip images={images} size="sm" />
    ) : null;
  }

  // The "Working / Worked" summary lives in the dock above the composer
  // (work-status-dock.tsx); here the calls are simply listed inline, each a
  // description that opens its details on click.
  return (
    <div className="flex flex-col w-full my-1">
      {stripImages.length ? (
        <InlineImageStrip images={stripImages} size="sm" className="mb-1" />
      ) : null}
      <PresenterSurface value="chat">
        <div className="flex flex-col gap-1">
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
    </div>
  );
});
