import { appStore } from "@/app/store";

/** Apply transient runtime title updates without adding duplicate sidebar rows. */
export function applyRuntimeThreadTitle(
  data: unknown,
  expectedThreadId: string,
) {
  if (!data || typeof data !== "object") return false;
  const value = data as {
    threadId?: unknown;
    title?: unknown;
    sessionId?: unknown;
    shortName?: unknown;
    icon?: unknown;
  };
  if (value.threadId !== expectedThreadId || typeof value.title !== "string")
    return false;
  const title = value.title.trim();
  if (!title) return false;
  const sessionId =
    typeof value.sessionId === "string" ? value.sessionId : undefined;
  const shortName =
    typeof value.shortName === "string" ? value.shortName : undefined;
  const icon = typeof value.icon === "string" ? value.icon : undefined;
  appStore.setState((prev) => {
    const exists = prev.threadList.some((t) => t.id === expectedThreadId);
    if (exists) {
      return {
        threadList: prev.threadList.map((thread) =>
          thread.id === expectedThreadId
            ? {
                ...thread,
                title,
                ...(sessionId ? { sessionId } : {}),
                ...(shortName ? { shortName } : {}),
                ...(icon ? { icon } : {}),
              }
            : thread,
        ),
      };
    }
    // If this is the currently active brand-new thread and /api/thread hasn't
    // been fetched yet (e.g. sidebar is in Admin mode), seed its entry so the
    // header and sidebar immediately show the animal emoji + title.
    if (prev.currentThreadId === expectedThreadId) {
      return {
        threadList: [
          {
            id: expectedThreadId,
            title,
            userId: "",
            createdAt: new Date(),
            ...(sessionId ? { sessionId } : {}),
            ...(shortName ? { shortName } : {}),
            ...(icon ? { icon } : {}),
          },
          ...prev.threadList,
        ],
      };
    }
    return prev;
  });
  return true;
}
