/**
 * Todo lists as the jcode runtime models them, and the "what changed" delta
 * its TUI prints under every `todo` call.
 *
 * Ported from runtime/crates/amiro-tui/src/tui/ui_todo_changes.rs so the web
 * transcript and the terminal tell a user the same thing about the same
 * call. The runtime's item (amiro-task-types TodoItem) carries an id, a
 * status, a priority, an optional group and a blocked_by list; the older
 * built-in todo_write tool only has content + status, so every field but
 * those two is optional here.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface RuntimeTodo {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: string;
  group?: string;
  blockedBy: string[];
}

export function normalizeTodoStatus(raw: unknown): TodoStatus {
  switch (raw) {
    case "completed":
    case "done":
      return "completed";
    case "in_progress":
    case "in-progress":
    case "active":
      return "in_progress";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

/**
 * The list a todo call wrote, or undefined for a read with nothing to show.
 * Prefers the output (what was actually stored) over the input (what was
 * asked for), and falls back to the input while the call is still running.
 */
export function todosFromToolPart(input: any, output: any): RuntimeTodo[] | undefined {
  const raw = Array.isArray(output?.todos)
    ? output.todos
    : Array.isArray(output)
      ? output
      : Array.isArray(input?.todos)
        ? input.todos
        : undefined;
  if (!raw) return undefined;
  return raw.map((item: any, i: number) => ({
    id: String(item?.id ?? `todo-${i}`),
    content: String(item?.content ?? item?.title ?? item?.text ?? ""),
    status: normalizeTodoStatus(item?.status),
    priority: item?.priority,
    group: item?.group || undefined,
    blockedBy: Array.isArray(item?.blocked_by)
      ? item.blocked_by
      : Array.isArray(item?.blockedBy)
        ? item.blockedBy
        : [],
  }));
}

export type TodoChange =
  | { kind: "added"; content: string }
  | { kind: "removed"; content: string }
  | { kind: "status"; to: TodoStatus; blocked: boolean; content: string }
  | { kind: "edited"; status: TodoStatus; blocked: boolean; content: string };

export interface TodoDiff {
  changes: TodoChange[];
  isFirst: boolean;
  added: number;
  removed: number;
  statusChanges: number;
  toCompleted: number;
  toInProgress: number;
  toCancelled: number;
  reopened: number;
  edited: number;
  completed: number;
  total: number;
}

export function diffTodos(
  prev: RuntimeTodo[] | undefined,
  next: RuntimeTodo[],
): TodoDiff {
  const diff: TodoDiff = {
    changes: [],
    isFirst: prev === undefined,
    added: 0,
    removed: 0,
    statusChanges: 0,
    toCompleted: 0,
    toInProgress: 0,
    toCancelled: 0,
    reopened: 0,
    edited: 0,
    completed: next.filter((t) => t.status === "completed").length,
    total: next.length,
  };
  const prevItems = prev ?? [];
  // Older todo tools have no stable ids, so fall back to matching by text.
  const key = (t: RuntimeTodo) => (t.id.startsWith("todo-") ? t.content : t.id);
  const prevByKey = new Map(prevItems.map((p) => [key(p), p]));

  for (const item of next) {
    const before = prevByKey.get(key(item));
    const blocked = item.blockedBy.length > 0;
    if (!before) {
      diff.added++;
      diff.changes.push({ kind: "added", content: item.content });
    } else if (before.status !== item.status) {
      diff.statusChanges++;
      if (item.status === "completed") diff.toCompleted++;
      else if (item.status === "in_progress") diff.toInProgress++;
      else if (item.status === "cancelled") diff.toCancelled++;
      else diff.reopened++;
      diff.changes.push({ kind: "status", to: item.status, blocked, content: item.content });
    } else if (before.content !== item.content) {
      diff.edited++;
      diff.changes.push({ kind: "edited", status: item.status, blocked, content: item.content });
    }
  }
  const nextKeys = new Set(next.map(key));
  for (const p of prevItems) {
    if (!nextKeys.has(key(p))) {
      diff.removed++;
      diff.changes.push({ kind: "removed", content: p.content });
    }
  }
  return diff;
}

/** Whether the delta deserves a block (header + per-item lines) or one line. */
export function isSubstantive(diff: TodoDiff): boolean {
  return diff.isFirst || diff.added > 0 || diff.removed > 0 || diff.statusChanges > 1;
}

export function todoDiffSummary(diff: TodoDiff): string {
  const parts: string[] = [];
  if (diff.toCompleted) parts.push(`${diff.toCompleted} done`);
  if (diff.toInProgress) parts.push(`${diff.toInProgress} started`);
  if (diff.reopened) parts.push(`${diff.reopened} reopened`);
  if (diff.toCancelled) parts.push(`${diff.toCancelled} cancelled`);
  if (diff.added) parts.push(`${diff.added} added`);
  if (diff.removed) parts.push(`${diff.removed} removed`);
  if (diff.edited) parts.push(`${diff.edited} edited`);
  return parts.length ? parts.join(" · ") : "updated";
}

/** Group a list for display, keeping first-seen group order. */
export function groupTodos(
  todos: RuntimeTodo[],
): { group: string | undefined; items: RuntimeTodo[] }[] {
  const out: { group: string | undefined; items: RuntimeTodo[] }[] = [];
  for (const t of todos) {
    let bucket = out.find((b) => b.group === t.group);
    if (!bucket) {
      bucket = { group: t.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(t);
  }
  return out;
}
