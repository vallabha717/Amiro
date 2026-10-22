import type { AmiroNotification } from "@/lib/notifications/notification-types";

export interface RelativeTime {
  unit: "now" | "minute" | "hour" | "day";
  value: number;
}

/** Pure relative-time descriptor (rendered through `Notifications.Feed` strings). */
export function describeRelativeTime(
  isoString?: string,
  nowMs: number = Date.now(),
): RelativeTime | null {
  if (!isoString) return null;
  const date = new Date(isoString).getTime();
  if (Number.isNaN(date)) return null;
  const diffSec = Math.max(0, Math.floor((nowMs - date) / 1000));
  if (diffSec < 60) return { unit: "now", value: 0 };
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return { unit: "minute", value: diffMin };
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return { unit: "hour", value: diffHr };
  return { unit: "day", value: Math.floor(diffHr / 24) };
}

/** An unread approval is waiting on the user, so it sorts above everything. */
export function needsAttention(n: AmiroNotification): boolean {
  return n.category === "approval" && !n.read;
}

/**
 * What the inbox lists, in Vellum's order: whatever is waiting on the user
 * first, then newest first. Dismissed items never show; `unreadOnly` keeps
 * just the unread ones.
 */
export function visibleFeed(
  notifications: AmiroNotification[],
  unreadOnly: boolean,
): AmiroNotification[] {
  const shown = notifications.filter((n) => !n.dismissed && (!unreadOnly || !n.read));
  return [...shown].sort((a, b) => {
    const attention = Number(needsAttention(b)) - Number(needsAttention(a));
    if (attention !== 0) return attention;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * One line of plain text from a notification body. Replies are markdown, and
 * a list row must never show `**` or `#`.
 */
export function plainPreview(text: string | undefined, max = 160): string {
  if (!text) return "";
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
