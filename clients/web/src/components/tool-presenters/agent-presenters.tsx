"use client";

import { cn } from "lib/utils";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  LayersIcon,
  TelescopeIcon,
  UsersIcon,
} from "lucide-react";
import { parseToolTiming } from "lib/ai/tools/timing";
import type { PresenterProps, ToolPresenter } from "./types";
// Used only at render time, so the index <-> presenter cycle is harmless.
import { getToolPresenter } from "./index";

/* ------------------------------------------------------------------ */
/* todo_write / todo_read                                              */
/* ------------------------------------------------------------------ */

type TodoStatus = "pending" | "in_progress" | "done";

const STATUS_ICON = {
  pending: CircleDashedIcon,
  in_progress: CircleDotIcon,
  done: CircleCheckIcon,
} as const;

function getNormalizedTodoItems(
  input: any,
  output: any,
): { content: string; status: TodoStatus; priority?: string }[] {
  const raw =
    output?.items ??
    input?.items ??
    output?.todos ??
    input?.todos ??
    [];
  if (!Array.isArray(raw)) return [];
  return raw.map((item: any) => ({
    content: typeof item?.content === "string" ? item.content : "",
    status:
      item?.status === "completed" || item?.status === "done"
        ? "done"
        : item?.status === "in_progress"
          ? "in_progress"
          : "pending",
    priority: typeof item?.priority === "string" ? item.priority : undefined,
  }));
}

function counts(input: any, output: any) {
  // Prefer the output's counts (the server already did the arithmetic) but
  // fall back to the input, because the plan is worth showing the instant
  // the model writes it rather than a round trip later.
  if (
    output &&
    typeof output.done === "number" &&
    typeof output.in_progress === "number"
  ) {
    return {
      done: output.done ?? 0,
      inProgress: output.in_progress ?? 0,
      pending: output.pending ?? 0,
    };
  }
  const items = getNormalizedTodoItems(input, output);
  return {
    done: items.filter((i) => i.status === "done").length,
    inProgress: items.filter((i) => i.status === "in_progress").length,
    pending: items.filter((i) => i.status === "pending").length,
  };
}

function TodoBody({ input, output }: PresenterProps) {
  const items = getNormalizedTodoItems(input, output);
  const { done, inProgress, pending } = counts(input, output);
  const total = done + inProgress + pending;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (items.length === 0) {
    return <span className="text-muted-foreground text-xs">no plan yet</span>;
  }

  return (
    <div className="space-y-2">
      {input?.intent ? (
        <div className="text-[11px] text-muted-foreground font-medium">
          {input.intent}
        </div>
      ) : null}
      {total > 0 ? (
        <div className="w-full bg-muted/60 rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-emerald-500 h-full transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      ) : null}
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
                  "min-w-0 flex-1",
                  // Struck through, not hidden: the value of a plan panel is
                  // seeing what was done next to what is left.
                  item.status === "done" && "line-through text-muted-foreground",
                  item.status === "in_progress" && "font-medium",
                )}
              >
                {item.content}
              </span>
              {item.priority ? (
                <span className="shrink-0 text-[10px] px-1 rounded bg-muted text-muted-foreground">
                  {item.priority}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
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
    const items = getNormalizedTodoItems(input, output);
    const current = items.find((i) => i.status === "in_progress");
    const tally = `${done}/${total} done`;
    return current ? `${tally} · ${current.content}` : tally;
  },
  Compact: (props: PresenterProps) => (
    <div className="w-full rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
        <span>Plan</span>
        {props.input?.intent ? (
          <span className="text-[11px] font-normal truncate max-w-xs">{props.input.intent}</span>
        ) : null}
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

const swarm: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "coordinate";
    const label =
      input?.label ??
      input?.to_session ??
      input?.target_session ??
      (input?.prompt ? input.prompt.split("\n")[0].slice(0, 32) : "agent");
    if (status === "pending") return `swarm (${action}) · ${label}…`;
    if (status === "error") return `⚠ swarm failed · ${label}`;
    return `swarm (${action}) · ${label}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">
            swarm {input?.action ? `· ${input.action}` : ""}
          </span>
          {input?.label ? (
            <span className="rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[11px] font-mono">
              {input.label}
            </span>
          ) : null}
          {input?.model ? (
            <span className="rounded bg-muted text-muted-foreground px-1.5 py-0.5 text-[10px] font-mono">
              {input.model}
            </span>
          ) : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? (
            <div className="text-muted-foreground text-[11px]">{input.intent}</div>
          ) : null}
          {input?.prompt || input?.message ? (
            <div className="text-muted-foreground line-clamp-2 font-mono text-[11px]">
              {input.prompt || input.message}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">
            swarm {input?.action ? `· ${input.action}` : ""}
          </span>
          {input?.label ? (
            <span className="rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[11px] font-mono">
              {input.label}
            </span>
          ) : null}
          {input?.model ? (
            <span className="rounded bg-muted text-muted-foreground px-1.5 py-0.5 text-[10px] font-mono">
              {input.model}
            </span>
          ) : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? (
            <div className="text-muted-foreground text-[11px]">{input.intent}</div>
          ) : null}
          {input?.prompt || input?.message ? (
            <div className="rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
              {input.prompt || input.message}
            </div>
          ) : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">
              {errorText || "failed"}
            </pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const batch: ToolPresenter = {
  glance: ({ input, status }) => {
    const calls = Array.isArray(input?.tool_calls) ? input.tool_calls : [];
    const names = Array.from(
      new Set(calls.map((c: any) => c?.tool).filter(Boolean)),
    ).slice(0, 3);
    const what = names.length ? ` · ${names.join(", ")}` : "";
    const n = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
    if (status === "pending") return `running ${n} in parallel${what}…`;
    if (status === "error") return `⚠ batch failed (${n})`;
    return `batch · ${n}${what}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const calls: { tool?: string; intent?: string }[] =
      Array.isArray(input?.tool_calls) ? input.tool_calls : [];
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Batch</span>
          <span className="text-muted-foreground">
            ({calls.length} {calls.length === 1 ? "call" : "calls"})
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? (
            <div className="text-muted-foreground text-[11px]">{input.intent}</div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {calls.map((c, i) => (
              <span
                key={i}
                className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
              >
                {c.tool || `tool-${i + 1}`}
                {c.intent ? ` · ${c.intent}` : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const calls: any[] = Array.isArray(input?.tool_calls) ? input.tool_calls : [];
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Batch</span>
          <span className="text-muted-foreground">
            ({calls.length} {calls.length === 1 ? "call" : "calls"})
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? (
            <div className="text-muted-foreground text-[11px]">{input.intent}</div>
          ) : null}
          <ol className="space-y-1" data-testid="batch-calls">
            {calls.map((c, i) => {
              const { tool, intent, ...params } = c ?? {};
              const sub = tool ? getToolPresenter(tool) : undefined;
              let line = "";
              try {
                line = sub?.glance({ input: { intent, ...params }, output: undefined, status }) ?? "";
              } catch {
                line = "";
              }
              return (
                <li
                  key={i}
                  data-testid="batch-call"
                  className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5"
                >
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                    {tool || "call"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {intent || line}
                  </span>
                </li>
              );
            })}
          </ol>
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">
              {errorText || "failed"}
            </pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

export const agentPresenters = {
  todo_write: todo,
  todo_read: todo,
  todo,
  task,
  swarm,
  subagent: swarm,
  communicate: swarm,
  batch,
};
