"use client";

import { cn } from "lib/utils";
import { CircleDashedIcon, CircleDotIcon, CircleCheckIcon, TelescopeIcon } from "lucide-react";
import type { PresenterProps, ToolPresenter } from "./types";

/* ------------------------------------------------------------------ */
/* todo_write / todo_read                                              */
/* ------------------------------------------------------------------ */

type TodoStatus = "pending" | "in_progress" | "done";

const STATUS_ICON = {
  pending: CircleDashedIcon,
  in_progress: CircleDotIcon,
  done: CircleCheckIcon,
} as const;

function counts(input: any, output: any) {
  // Prefer the output's counts (the server already did the arithmetic) but
  // fall back to the input, because the plan is worth showing the instant
  // the model writes it rather than a round trip later.
  if (output) {
    return {
      done: output.done ?? 0,
      inProgress: output.in_progress ?? 0,
      pending: output.pending ?? 0,
    };
  }
  const items: { status?: TodoStatus }[] = input?.items ?? [];
  return {
    done: items.filter((i) => i.status === "done").length,
    inProgress: items.filter((i) => i.status === "in_progress").length,
    pending: items.filter((i) => i.status === "pending").length,
  };
}

function TodoBody({ input, output }: PresenterProps) {
  const items: { content: string; status: TodoStatus }[] =
    output?.items ?? input?.items ?? [];

  if (items.length === 0) {
    return <span className="text-muted-foreground text-xs">no plan yet</span>;
  }

  return (
    <div className="space-y-1">
      {items.map((item, i) => {
        const Icon = STATUS_ICON[item.status] ?? CircleDashedIcon;
        return (
          <div key={i} className="flex items-start gap-2 text-xs">
            <Icon
              className={cn(
                "size-3.5 shrink-0 mt-0.5",
                item.status === "done" && "text-emerald-600 dark:text-emerald-400",
                item.status === "in_progress" && "text-amber-600 dark:text-amber-400",
                item.status === "pending" && "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "min-w-0",
                // Struck through, not hidden: the value of a plan panel is
                // seeing what was done next to what is left.
                item.status === "done" && "line-through text-muted-foreground",
                item.status === "in_progress" && "font-medium",
              )}
            >
              {item.content}
            </span>
          </div>
        );
      })}
      {output?.notice ? (
        <div className="pt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {output.notice}
        </div>
      ) : null}
    </div>
  );
}

const todo: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "plan update failed";
    const { done, inProgress, pending } = counts(input, output);
    const total = done + inProgress + pending;
    if (total === 0) return "no plan yet";
    // The in-progress item's text, when there is one -- "3 done · 2 pending"
    // says how much is left, but not what the agent is doing right now,
    // which is the more useful of the two while a turn is running.
    const items: { content: string; status: TodoStatus }[] =
      output?.items ?? input?.items ?? [];
    const current = items.find((i) => i.status === "in_progress");
    const tally = `${done}/${total} done`;
    return current ? `${tally} · ${current.content}` : tally;
  },
  Compact: (props: PresenterProps) => (
    <div className="w-full rounded-lg border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
        Plan
      </div>
      <div className="px-3 py-2">
        <TodoBody {...props} />
      </div>
    </div>
  ),
};
todo.Expanded = todo.Compact;

/* ------------------------------------------------------------------ */
/* task (subagent)                                                     */
/* ------------------------------------------------------------------ */

function duration(ms?: number) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const task: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const what = output?.description ?? input?.description ?? "investigating";
    if (status === "pending") return `${what}…`;
    if (status === "error") return `⚠ ${what} failed`;
    const steps = output?.steps ?? 0;
    return `${what} · ${steps} ${steps === 1 ? "step" : "steps"}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => (
    <div
      className={cn(
        "w-full rounded-lg border bg-card overflow-hidden",
        status === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <TelescopeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium truncate">
          {output?.description ?? input?.description ?? "subagent"}
        </span>
        {output?.steps ? (
          <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
            {output.steps} steps · {duration(output.duration_ms)}
          </span>
        ) : null}
      </div>
      {status === "pending" ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          exploring in its own context…
        </div>
      ) : null}
    </div>
  ),
  // The child's steps are genuinely unavailable -- they never left the
  // server, which is the whole point of a subagent. So "expanded" is the
  // summary it returned, rendered as the prose it is, plus the prompt it
  // was given: without that, a reader cannot judge whether the answer
  // addresses the right question.
  Expanded: ({ input, output, status, errorText }: PresenterProps) => (
    <div
      className={cn(
        "w-full rounded-lg border bg-card overflow-hidden",
        status === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <TelescopeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium truncate">
          {output?.description ?? input?.description ?? "subagent"}
        </span>
        {output?.steps ? (
          <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
            {output.steps} steps · {duration(output.duration_ms)}
          </span>
        ) : null}
      </div>
      <div className="px-3 py-2 text-xs space-y-2">
        {input?.prompt ? (
          <div className="rounded bg-muted px-2 py-1.5 text-muted-foreground">
            {input.prompt}
          </div>
        ) : null}
        {status === "error" ? (
          <pre className="whitespace-pre-wrap break-words text-destructive font-mono">
            {errorText || "failed"}
          </pre>
        ) : status === "pending" ? (
          <span className="text-muted-foreground">exploring…</span>
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed">
            {output?.result || "(no summary returned)"}
          </p>
        )}
        {output?.notice ? (
          <div className="text-amber-600 dark:text-amber-400">{output.notice}</div>
        ) : null}
      </div>
    </div>
  ),
};

export const agentPresenters = {
  todo_write: todo,
  todo_read: todo,
  task,
};
