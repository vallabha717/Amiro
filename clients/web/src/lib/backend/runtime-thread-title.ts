import { appStore } from "@/app/store";

/** Apply transient runtime title updates without adding duplicate sidebar rows. */
export function applyRuntimeThreadTitle(
  data: unknown,
  expectedThreadId: string,
) {
  if (!data || typeof data !== "object") return false;
  const value = data as { threadId?: unknown; title?: unknown };
  if (value.threadId !== expectedThreadId || typeof value.title !== "string")
    return false;
  const title = value.title.trim();
  if (!title) return false;
  appStore.setState((prev) => ({
    threadList: prev.threadList.map((thread) =>
      thread.id === expectedThreadId ? { ...thread, title } : thread,
    ),
  }));
  return true;
}
