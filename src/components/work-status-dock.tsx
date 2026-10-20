"use client";

import { type UIMessage, getToolName, isToolUIPart } from "ai";
import { editRowSummary, formatDuration } from "lib/ai/tools/step-kind";
import { cn } from "lib/utils";
import {
  CheckCircle2Icon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { TextShimmer } from "ui/text-shimmer";
import {
  getToolPresenter,
  presenterPropsFromToolPart,
} from "./tool-presenters";

export interface WorkStatus {
  steps: number;
  failed: boolean;
  /** One line for the call in flight (or the last one), e.g. "echo hi · exit 0". */
  activeGlance: string | null;
  added: number;
  removed: number;
  durationMs?: number;
}

/**
 * Reads the tool activity of one assistant turn into the numbers the dock
 * shows. Pure, so it can be tested without rendering.
 */
export function summarizeWorkStatus(
  message: UIMessage | undefined,
  running: boolean,
): WorkStatus | null {
  if (!message || message.role !== "assistant") return null;
  let steps = 0;
  let failed = false;
  let activeGlance: string | null = null;
  let added = 0;
  let removed = 0;
  for (const part of message.parts ?? []) {
    if (!isToolUIPart(part)) continue;
    steps++;
    const toolName = getToolName(part);
    const props = presenterPropsFromToolPart(part);
    if (props.status === "error") failed = true;
    const input = (part as any).input;
    const intent =
      typeof input?.intent === "string" && input.intent.trim()
        ? input.intent.trim()
        : "";
    const glance = getToolPresenter(toolName)?.glance(props) ?? toolName;
    activeGlance = intent || glance;
    const file = editRowSummary(toolName, props);
    if (file) {
      if (typeof file.added === "number") added += file.added;
      if (typeof file.removed === "number") removed += file.removed;
    }
  }
  if (steps === 0) return null;
  const durationMs = (message.metadata as { durationMs?: number } | undefined)
    ?.durationMs;
  return {
    steps,
    failed,
    activeGlance: running ? activeGlance : null,
    added,
    removed,
    durationMs,
  };
}

/**
 * A docked status bar that sits directly above the composer, the same place
 * and look as the minimized live-voice dock, instead of a pill at the top of
 * the transcript.
 */
export function WorkStatusDock({
  message,
  running,
}: {
  message: UIMessage | undefined;
  running: boolean;
}) {
  const status = useMemo(
    () => summarizeWorkStatus(message, running),
    [message, running],
  );

  const startedAt = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!running) {
      startedAt.current = null;
      return;
    }
    const started = startedAt.current ?? Date.now();
    startedAt.current = started;
    const tick = () => setElapsedMs(Date.now() - started);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!status) return null;

  const shownMs = running ? elapsedMs : (status.durationMs ?? elapsedMs);
  const stepLabel = `${status.steps} ${status.steps === 1 ? "step" : "steps"}`;
  const label = running
    ? `Working… ${formatDuration(shownMs)}`
    : status.durationMs !== undefined || elapsedMs > 0
      ? `Worked for ${formatDuration(shownMs)} · ${stepLabel}`
      : `Worked · ${stepLabel}`;

  return (
    <motion.div
      data-testid="work-status-dock"
      data-running={running ? "true" : "false"}
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.97 }}
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2.5 rounded-2xl border border-border bg-background/90 px-3 py-2 text-xs shadow-lg backdrop-blur"
    >
      {running ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : status.failed ? (
        <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-500" />
      ) : (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" />
      )}
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      {running && status.activeGlance ? (
        <TextShimmer
          as="span"
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
        >
          {status.activeGlance}
        </TextShimmer>
      ) : (
        <span className="flex-1" />
      )}
      {!running && (status.added > 0 || status.removed > 0) ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{status.added}
          </span>
          <span className="text-destructive">−{status.removed}</span>
        </span>
      ) : null}
      {!running && status.failed ? (
        <span
          className={cn(
            "shrink-0 rounded-full border border-destructive/20 bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive",
          )}
        >
          Failed
        </span>
      ) : null}
    </motion.div>
  );
}
