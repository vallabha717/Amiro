"use client";

import {
  type RuntimeTodo,
  type TodoChange,
  type TodoStatus,
  diffTodos,
  groupTodos,
  isSubstantive,
  todoDiffSummary,
} from "lib/chat-ux/todos";
import { cn } from "lib/utils";
import { memo, useMemo } from "react";

const MAX_CHANGE_LINES = 6;

/** The jcode TUI's glyphs, so both surfaces read the same. */
function statusGlyph(status: TodoStatus, blocked: boolean) {
  if (blocked && status !== "completed")
    return { glyph: "⊳", className: "text-amber-700/80 dark:text-amber-400/80" };
  switch (status) {
    case "completed":
      return { glyph: "✓", className: "text-emerald-600 dark:text-emerald-400" };
    case "in_progress":
      return { glyph: "▶", className: "text-amber-500" };
    case "cancelled":
      return { glyph: "✗", className: "text-destructive/70" };
    default:
      return { glyph: "○", className: "text-muted-foreground" };
  }
}

function changeGlyph(c: TodoChange) {
  switch (c.kind) {
    case "added":
      return { glyph: "+", className: "text-emerald-600 dark:text-emerald-400", text: "" };
    case "removed":
      return { glyph: "−", className: "text-destructive", text: "line-through text-muted-foreground" };
    case "status": {
      const g = statusGlyph(c.to, c.blocked);
      const faded = c.to === "completed" || c.to === "cancelled";
      return { ...g, text: faded ? "text-muted-foreground" : "" };
    }
    case "edited":
      return { ...statusGlyph(c.status, c.blocked), text: "" };
  }
}

/**
 * The "what changed" delta under a todo call, as the TUI prints it
 * (ui_todo_changes.rs): one line for a trivial change, a header plus one
 * line per item for a substantive one.
 */
export const TodoDelta = memo(function TodoDelta({
  prev,
  next,
}: {
  prev: RuntimeTodo[] | undefined;
  next: RuntimeTodo[];
}) {
  const diff = useMemo(() => diffTodos(prev, next), [prev, next]);
  if (!diff.changes.length) return null;
  const progress = (
    <span className="text-muted-foreground/70 tabular-nums ml-1.5">
      ({diff.completed}/{diff.total})
    </span>
  );

  if (!isSubstantive(diff) && diff.changes.length === 1) {
    const c = diff.changes[0];
    const g = changeGlyph(c);
    return (
      <div className="flex items-center gap-1.5 text-[11px] leading-5 font-mono truncate">
        <span className="text-muted-foreground/60">↳</span>
        <span className={g.className}>{g.glyph}</span>
        <span className={cn("truncate", g.text)}>{c.content}</span>
        {progress}
      </div>
    );
  }

  const shown = diff.changes.slice(0, MAX_CHANGE_LINES);
  return (
    <div className="flex flex-col text-[11px] leading-5 font-mono">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground/60">↳</span>
        <span className="text-muted-foreground">{todoDiffSummary(diff)}</span>
        {progress}
      </div>
      {isSubstantive(diff) &&
        shown.map((c, i) => {
          const g = changeGlyph(c);
          return (
            <div key={i} className="flex items-center gap-1.5 pl-4 min-w-0">
              <span className={cn("shrink-0", g.className)}>{g.glyph}</span>
              <span className={cn("truncate", g.text)}>{c.content}</span>
            </div>
          );
        })}
      {isSubstantive(diff) && diff.changes.length > shown.length && (
        <div className="pl-4 text-muted-foreground/60">
          +{diff.changes.length - shown.length} more
        </div>
      )}
    </div>
  );
});

/** The full list, grouped, for the session panel. */
export const TodoList = memo(function TodoList({
  todos,
  live,
  limit,
}: {
  todos: RuntimeTodo[];
  live?: boolean;
  limit?: number;
}) {
  const groups = useMemo(() => groupTodos(todos), [todos]);
  let budget = limit ?? Number.POSITIVE_INFINITY;
  const hidden = Math.max(0, todos.length - budget);
  return (
    <div className="flex flex-col gap-2">
      {groups.map((g, gi) => {
        if (budget <= 0) return null;
        const items = g.items.slice(0, budget);
        budget -= items.length;
        return (
          <div key={gi} className="flex flex-col">
            {g.group && (
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-0.5">
                {g.group}
              </div>
            )}
            {items.map((t) => {
              const s = statusGlyph(t.status, t.blockedBy.length > 0);
              const active = t.status === "in_progress";
              return (
                <div key={t.id} className="flex items-start gap-2 py-0.5 text-[13px] leading-5">
                  <span
                    className={cn(
                      "w-3 shrink-0 text-center font-mono",
                      s.className,
                      active && live && "animate-pulse",
                    )}
                  >
                    {s.glyph}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 break-words",
                      t.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40",
                      t.status === "cancelled" && "text-muted-foreground/60 line-through",
                      active && "font-medium text-foreground",
                    )}
                  >
                    {t.content}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {hidden > 0 && <div className="text-xs text-muted-foreground">+{hidden} more</div>}
    </div>
  );
});
