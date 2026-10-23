"use client";

import { cn } from "lib/utils";
import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { TodoArtifact } from "./use-artifacts";

const STATUS_ICON = {
  pending: CircleDashedIcon,
  in_progress: CircleDotIcon,
  done: CircleCheckIcon,
} as const;

/**
 * The task list, as a panel that stays put.
 *
 * The checklist itself already existed as a presenter card in the work log
 * (agent-presenters.tsx). What it could not do is stay visible: the work log
 * auto-collapses when a turn ends, so the plan was written and then hidden at
 * exactly the moment the user wanted to check it against the result.
 *
 * The rendering is intentionally near-identical to that card rather than
 * shared with it. The two differ in the one way that matters -- this one is
 * the full list at panel width with a progress bar, the card is a summary
 * inside a message -- and factoring them together would mean a component
 * taking a "which surface" flag that changes half its output, which the
 * presenter registry already learned to avoid.
 */
export function TodoPanel({ todos }: { todos?: TodoArtifact }) {
  const t = useTranslations("Chat.Artifact");

  if (!todos || todos.items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-xs text-center text-xs text-muted-foreground">
          {t("noTasksYet")}
        </p>
      </div>
    );
  }

  const total = todos.items.length;
  const pct = total === 0 ? 0 : Math.round((todos.done / total) * 100);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{t("tasksTitle")}</h2>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {t("tasksProgress", { done: todos.done, total })}
          </span>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-emerald-500/80 transition-[width] duration-300 ease-[var(--ease-out)]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </header>

      <ol className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
        {todos.items.map((item, i) => {
          const Icon = STATUS_ICON[item.status] ?? CircleDashedIcon;
          return (
            <li
              key={`${i}-${item.content}`}
              className="flex items-start gap-2.5 py-1.5"
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  // Colour only, on a 160ms crossfade. This list updates many
                  // times inside one turn: anything that moved layout would
                  // make status data the user is trying to read jump under
                  // their eyes.
                  "transition-colors duration-[160ms] ease-[var(--ease-out)]",
                  item.status === "done" &&
                    "text-emerald-600 dark:text-emerald-400",
                  item.status === "in_progress" &&
                    "text-amber-600 dark:text-amber-400",
                  item.status === "pending" && "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "min-w-0 text-sm leading-snug",
                  // Struck through, not removed: the value of a task panel is
                  // seeing what was done next to what is left.
                  item.status === "done" &&
                    "text-muted-foreground line-through",
                  item.status === "in_progress" && "font-medium",
                )}
              >
                {item.content}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
