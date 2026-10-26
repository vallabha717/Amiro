"use client";

import {
  type EditRowSummary,
  type StepKind,
  stepGroupLabel,
} from "lib/ai/tools/step-kind";
import type { InlineImage } from "lib/chat-ux/inline-images";
import { cn } from "lib/utils";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  SparklesIcon,
  PencilIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import {
  type ReactNode,
  createContext,
  memo,
  useMemo,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { TextShimmer } from "ui/text-shimmer";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { InlineImageStrip } from "./workspace/inline-images";
import { PresenterSurface } from "./tool-presenters/surface";
import { toneFor } from "./chat-stream/step-strip";

/**
 * True inside the timeline. A tool pill there leaves its running/failed
 * glyph to the rail disc, so one step never shows two spinners.
 */
export const InTimelineContext = createContext(false);

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
        /** Overrides the row's kind for colour, e.g. "ask" for a question. */
        tone?: string;
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
  | {
      type: "prose";
      children: ReactNode;
      /** Reasoning between steps rather than something the agent said. */
      thought?: boolean;
      /** That reasoning is streaming right now. */
      active?: boolean;
      /** One line saying what this thought or note was about. */
      title?: string;
      /**
       * Text the running turn is writing right now. It may turn out to be
       * the answer, so it is set at full size until the turn says otherwise.
       */
      live?: boolean;
    };

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
        {/* Running/failed state is on the timeline disc beside this row. */}
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
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

/**
 * One stop on the timeline rail: the step's kind as a small disc, a spinner
 * while it runs, a warning when it failed. The rail line itself is drawn by
 * the list, so a disc only has to cover it.
 */
function RailNode({
  icon,
  state,
  tone,
}: {
  icon: ReactNode;
  state: "running" | "failed" | "done";
  /** The step's kind, which picks the disc's colour. */
  tone: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute left-0 top-1 z-10 flex size-[18px] items-center justify-center rounded-full border bg-card transition-colors",
        state === "failed"
          ? "border-destructive/50 text-destructive"
          : toneFor(tone).disc,
      )}
    >
      {state === "running" ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : state === "failed" ? (
        <TriangleAlertIcon className="size-3" />
      ) : (
        icon
      )}
    </span>
  );
}

const RAIL_ICON: Record<string, ReactNode> = {
  thought: <BrainIcon className="size-3" />,
  explore: <FileTextIcon className="size-3" />,
  edit: <PencilIcon className="size-3" />,
  command: <TerminalIcon className="size-3" />,
  search: <GlobeIcon className="size-3" />,
  note: <SparklesIcon className="size-3" />,
  ask: <MessageCircleQuestionIcon className="size-3" />,
  plan: <ListChecksIcon className="size-3" />,
  other: <WrenchIcon className="size-3" />,
};

export const WorkLog = memo(function WorkLog({
  rows,
  isRunning,
  images,
  leading,
}: {
  rows: WorkLogRow[];
  isRunning: boolean;
  /** The run's thinking, drawn as the first stop on the rail. */
  leading?: ReactNode;
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
  const tStream = useTranslations("ChatStream.Timeline");
  const stripImages = useMemo(() => {
    if (!images?.length) return [];
    const inRows = new Set<string>();
    for (const r of rows) {
      if (r.type === "group") r.images?.forEach((img) => inRows.add(img.src));
    }
    return images.filter((img) => !inRows.has(img.src));
  }, [images, rows]);

  // Every call filtered out: no rail to draw, but the images must stay.
  if (!rows.length && !leading) {
    return images?.length ? (
      <InlineImageStrip images={images} size="sm" />
    ) : null;
  }

  // The steps as a timeline: one disc per step on a thin rail, newest at the
  // bottom, so a live run reads top-to-bottom as it streams in.
  return (
    <div className="flex flex-col w-full">
      {stripImages.length ? (
        <InlineImageStrip images={stripImages} size="sm" className="mb-1" />
      ) : null}
      <PresenterSurface value="chat">
        <InTimelineContext.Provider value={true}>
        <ol
          data-testid="worklog-timeline"
          className="relative flex flex-col gap-0.5 before:absolute before:bottom-3 before:left-[8.5px] before:top-3 before:w-px before:bg-border"
        >
          {leading ? (
            <li data-row="lead" className="relative min-w-0 rounded-md pl-7">
              <RailNode icon={RAIL_ICON.thought} state="done" tone="thought" />
              {leading}
            </li>
          ) : null}
          {rows.map((row, i) => {
            if (row.type !== "group" && row.thought) {
              return (
                <li
                  key={i}
                  data-row={i}
                  data-testid="worklog-thought"
                  className="worklog-step-in relative min-w-0 rounded-md pl-7"
                >
                  <RailNode
                    icon={RAIL_ICON.thought}
                    state={row.active ? "running" : "done"}
                    tone="thought"
                  />
                  {row.children}
                </li>
              );
            }
            if (row.type !== "group") {
              // What the agent said between steps is a step too: a note on
              // the rail, set smaller and quieter than the final answer.
              return (
                <li
                  key={i}
                  data-row={i}
                  data-testid="worklog-note"
                  data-live={row.live ? "true" : undefined}
                  className="worklog-step-in relative min-w-0 rounded-md py-1 pl-7"
                >
                  <RailNode
                    icon={RAIL_ICON.note}
                    state={row.live ? "running" : "done"}
                    tone="note"
                  />
                  {/* The agent talking to you mid-run: a speech bubble whose
                      tail points at its stop on the rail, set apart from the
                      tool steps so an update is never mistaken for one. */}
                  <div
                    className={cn(
                      "relative rounded-lg rounded-tl-sm border border-primary/15 bg-primary/[0.035] px-3 pb-2 pt-1.5 dark:bg-primary/[0.07]",
                      "before:absolute before:-left-[5px] before:top-2 before:size-2.5 before:rotate-45 before:border-b before:border-l before:border-primary/15 before:bg-card",
                      "after:absolute after:-left-[5px] after:top-2 after:size-2.5 after:rotate-45 after:border-b after:border-l after:border-primary/15 after:bg-primary/[0.035] dark:after:bg-primary/[0.07]",
                      "[&_[data-testid=message-content]]:px-0 [&_[data-testid=message-content]]:gap-1",
                      !row.live &&
                        "[&_p]:text-[13px] [&_p]:leading-relaxed [&_li]:text-[13px]",
                    )}
                  >
                    <span className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-primary/80">
                      <SparklesIcon className="size-2.5" />
                      {row.live ? tStream("writing") : tStream("update")}
                    </span>
                    {row.children}
                  </div>
                </li>
              );
            }
            const running = isRunning && i === rows.length - 1;
            const failed = row.glances.some((g) => g.failed);
            const tone = row.glances[row.glances.length - 1]?.tone ?? row.kind;
            return (
              <li
                key={i}
                data-row={i}
                className="worklog-step-in relative min-w-0 rounded-md pl-7"
                data-state={running ? "running" : failed ? "failed" : "done"}
              >
                <RailNode
                  icon={RAIL_ICON[tone] ?? RAIL_ICON[row.kind] ?? RAIL_ICON.other}
                  state={running ? "running" : failed ? "failed" : "done"}
                  tone={tone}
                />
                <GroupRow row={row} running={running} />
              </li>
            );
          })}
        </ol>
        </InTimelineContext.Provider>
      </PresenterSurface>
    </div>
  );
});
