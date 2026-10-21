import type {
  AmiroNotification,
  NotificationCategory,
} from "@/lib/notifications/notification-types";

export type FeedFilter = "all" | "unread" | NotificationCategory;

export const FEED_FILTERS: FeedFilter[] = [
  "all",
  "unread",
  "chat_reply",
  "schedule_result",
  "heartbeat",
  "approval",
  "system",
];

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

/** Legacy English formatter (kept for non-translated surfaces). */
export function formatRelativeTime(isoString?: string): string {
  const rel = describeRelativeTime(isoString);
  if (!rel) return "";
  switch (rel.unit) {
    case "now":
      return "just now";
    case "minute":
      return `${rel.value}m ago`;
    case "hour":
      return `${rel.value}h ago`;
    case "day":
      return `${rel.value}d ago`;
  }
}

/** Unread-first, newest-first; dismissed items never reach the feed. */
export function filterNotifications(
  notifications: AmiroNotification[],
  filter: FeedFilter,
): AmiroNotification[] {
  const visible = notifications.filter((n) => !n.dismissed);
  const filtered =
    filter === "all"
      ? visible
      : filter === "unread"
        ? visible.filter((n) => !n.read)
        : visible.filter((n) => n.category === filter);
  return [...filtered].sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export function isFeedCategory(
  filter: FeedFilter,
): filter is NotificationCategory {
  return filter !== "all" && filter !== "unread";
}
