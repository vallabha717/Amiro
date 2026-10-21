import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  FEED_FILTERS,
  describeRelativeTime,
  filterNotifications,
  formatRelativeTime,
  type FeedFilter,
} from "./feed-helpers";
import type { AmiroNotification } from "@/lib/notifications/notification-types";

vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, vars?: Record<string, string | number>) => {
      if (!vars) return key;
      return Object.entries(vars).reduce(
        (s, [k, v]) => s.replace(`{${k}}`, String(v)),
        key,
      );
    },
}));

vi.mock("swr", () => ({
  default: vi.fn(() => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  })),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { NotificationsFeed } from "./notifications-feed";

const NOW = new Date("2026-10-21T12:00:00Z").getTime();

function makeNotification(
  overrides: Partial<AmiroNotification> & { id: string },
): AmiroNotification {
  return {
    deliveryId: `d-${overrides.id}`,
    category: "system",
    status: "new",
    title: `Title ${overrides.id}`,
    body: `Body ${overrides.id}`,
    read: false,
    dismissed: false,
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("describeRelativeTime", () => {
  it("buckets seconds, minutes, hours, and days", () => {
    expect(describeRelativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toEqual({
      unit: "now",
      value: 0,
    });
    expect(describeRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toEqual({
      unit: "minute",
      value: 5,
    });
    expect(describeRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toEqual({
      unit: "hour",
      value: 3,
    });
    expect(describeRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toEqual({
      unit: "day",
      value: 2,
    });
  });

  it("returns null for missing or invalid input and clamps the future", () => {
    expect(describeRelativeTime(undefined, NOW)).toBeNull();
    expect(describeRelativeTime("not-a-date", NOW)).toBeNull();
    expect(describeRelativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toEqual({
      unit: "now",
      value: 0,
    });
  });

  it("formatRelativeTime keeps the legacy English short forms", () => {
    expect(formatRelativeTime(new Date(Date.now() - 10_000).toISOString())).toBe("just now");
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatRelativeTime(undefined)).toBe("");
    expect(formatRelativeTime("nope")).toBe("");
  });
});

describe("filterNotifications", () => {
  const items = [
    makeNotification({ id: "read-old", read: true, category: "system" }),
    makeNotification({ id: "unread-chat", read: false, category: "chat_reply" }),
    makeNotification({ id: "unread-schedule", read: false, category: "schedule_result" }),
    makeNotification({ id: "dismissed", read: false, dismissed: true, category: "system" }),
  ];

  it("excludes dismissed items in every filter", () => {
    for (const f of FEED_FILTERS) {
      expect(
        filterNotifications(items, f).map((n) => n.id),
      ).not.toContain("dismissed");
    }
  });

  it("orders unread first, newest first", () => {
    const ids = filterNotifications(items, "all").map((n) => n.id);
    expect(ids).toEqual(["unread-chat", "unread-schedule", "read-old"]);
  });

  it("filters unread-only and per category", () => {
    expect(filterNotifications(items, "unread" as FeedFilter).map((n) => n.id)).toEqual([
      "unread-chat",
      "unread-schedule",
    ]);
    expect(
      filterNotifications(items, "chat_reply").map((n) => n.id),
    ).toEqual(["unread-chat"]);
    expect(filterNotifications(items, "approval")).toEqual([]);
  });
});

describe("NotificationsFeed", () => {
  const items = [
    makeNotification({ id: "n1", read: false, category: "chat_reply", urgency: "high" }),
    makeNotification({ id: "n2", read: true, category: "schedule_result" }),
  ];

  const props = {
    notifications: items,
    isLoading: false,
    error: undefined,
    filter: "all" as FeedFilter,
    onFilterChange: () => {},
    onSelect: () => {},
    onToggleRead: () => {},
    onDismiss: () => {},
    onSendTest: () => {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders filter tabs, list semantics, and one row per item", () => {
    const html = renderToStaticMarkup(createElement(NotificationsFeed, props));
    expect(html).toContain('data-testid="notifications-feed"');
    expect(html).toContain("<ul");
    for (const f of FEED_FILTERS) {
      expect(html).toContain(`data-testid="notifications-filter-${f}"`);
    }
    expect(html).toContain('data-testid="notification-row-n1"');
    expect(html).toContain('data-testid="notification-row-n2"');
    expect(html).toContain('data-testid="notification-quick-read-n1"');
    expect(html).toContain('data-testid="notification-quick-dismiss-n2"');
  });

  it("marks urgent rows with icon plus text, never color alone", () => {
    const html = renderToStaticMarkup(createElement(NotificationsFeed, props));
    expect(html).toContain('aria-label="urgent"');
    expect(html).toContain("urgent");
  });

  it("names the active filter in the empty state with a clear-filter action", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationsFeed, { ...props, filter: "unread", notifications: [] }),
    );
    expect(html).toContain('data-testid="notifications-empty-state"');
    expect(html).toContain("emptyUnread");
    expect(html).toContain('data-testid="notifications-clear-filter"');
    expect(html).toContain('data-testid="notifications-send-test"');
  });

  it("shows loading and error states explicitly", () => {
    const loading = renderToStaticMarkup(
      createElement(NotificationsFeed, { ...props, isLoading: true }),
    );
    expect(loading).toContain('data-testid="notifications-feed-loading"');
    const failed = renderToStaticMarkup(
      createElement(NotificationsFeed, {
        ...props,
        error: new Error("boom"),
      }),
    );
    expect(failed).toContain('data-testid="notifications-feed-error"');
    expect(failed).toContain("boom");
  });
});
