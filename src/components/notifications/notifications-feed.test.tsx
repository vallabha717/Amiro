import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  describeRelativeTime,
  needsAttention,
  plainPreview,
  visibleFeed,
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
});

describe("visibleFeed", () => {
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const items = [
    makeNotification({ id: "read-new", read: true, createdAt: at(1) }),
    makeNotification({ id: "unread-old", createdAt: at(30) }),
    makeNotification({ id: "approval", category: "approval", createdAt: at(60) }),
    makeNotification({ id: "dismissed", dismissed: true, createdAt: at(0) }),
  ];

  it("puts what waits on the user first, then newest first, never dismissed", () => {
    expect(visibleFeed(items, false).map((n) => n.id)).toEqual([
      "approval",
      "read-new",
      "unread-old",
    ]);
  });

  it("keeps only unread items when asked", () => {
    expect(visibleFeed(items, true).map((n) => n.id)).toEqual(["approval", "unread-old"]);
  });

  it("stops treating an approval as waiting once it is read", () => {
    expect(needsAttention(makeNotification({ id: "a", category: "approval" }))).toBe(true);
    expect(needsAttention(makeNotification({ id: "b", category: "approval", read: true }))).toBe(false);
    expect(needsAttention(makeNotification({ id: "c", category: "chat_reply" }))).toBe(false);
  });
});

describe("plainPreview", () => {
  it("flattens markdown into one plain line", () => {
    expect(
      plainPreview("Checking scores.\n\n**Bangladesh 160** all out\n- [espn](https://espn.com) `live`"),
    ).toBe("Checking scores. Bangladesh 160 all out espn live");
    expect(plainPreview("## Heading\n> quoted")).toBe("Heading quoted");
  });

  it("trims long text and handles empty input", () => {
    expect(plainPreview("word ".repeat(100), 20)).toHaveLength(20);
    expect(plainPreview("word ".repeat(100), 20).endsWith("…")).toBe(true);
    expect(plainPreview(undefined)).toBe("");
  });
});

describe("NotificationsFeed", () => {
  const items = [
    makeNotification({ id: "n1", category: "chat_reply", title: "Hi", threadId: "t1", body: "**Bold** reply" }),
    makeNotification({ id: "n2", read: true, category: "schedule_result" }),
    makeNotification({ id: "n3", category: "approval", body: "May I send the email?" }),
  ];

  const props = {
    items,
    totalCount: items.length,
    isLoading: false,
    error: undefined,
    threadTitles: new Map([["t1", "Cricket scores"]]),
    onSelect: () => {},
    onToggleRead: () => {},
    onDismiss: () => {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders one row per item with its row actions and no filter chips", () => {
    const html = renderToStaticMarkup(createElement(NotificationsFeed, props));
    expect(html).toContain('data-testid="notifications-feed"');
    expect(html).toContain("<ul");
    expect(html).toContain('data-testid="notification-row-n1"');
    expect(html).toContain('data-testid="notification-row-n2"');
    expect(html).toContain('data-testid="notification-quick-read-n1"');
    expect(html).toContain('data-testid="notification-quick-dismiss-n2"');
    expect(html).not.toContain("notifications-filter-");
  });

  it("names the chat a reply came from and quotes it as plain text", () => {
    const html = renderToStaticMarkup(createElement(NotificationsFeed, props));
    expect(html).toContain("Cricket scores · Bold reply");
    expect(html).not.toContain("**Bold**");
    expect(html).toContain('data-read="false"');
    expect(html).toContain('data-read="true"');
    expect(html).toContain(">unread<");
  });

  it("quotes what a waiting approval asks, and names the source otherwise", () => {
    const html = renderToStaticMarkup(createElement(NotificationsFeed, props));
    expect(html).toContain("May I send the email?");
    expect(html).toContain("schedule_result");
  });

  it("says nothing is unread when the toggle hides everything", () => {
    const html = renderToStaticMarkup(createElement(NotificationsFeed, { ...props, items: [] }));
    expect(html).toContain('data-testid="notifications-empty-state"');
    expect(html).toContain("noUnread");
  });

  it("shows the bell empty state when there is nothing at all", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationsFeed, { ...props, items: [], totalCount: 0 }),
    );
    expect(html).toContain("emptyAll");
    expect(html).toContain("emptyHint");
  });

  it("shows loading and error states explicitly", () => {
    const loading = renderToStaticMarkup(
      createElement(NotificationsFeed, { ...props, isLoading: true }),
    );
    expect(loading).toContain('data-testid="notifications-feed-loading"');
    const failed = renderToStaticMarkup(
      createElement(NotificationsFeed, { ...props, items: [], totalCount: 0, error: new Error("boom") }),
    );
    expect(failed).toContain('data-testid="notifications-feed-error"');
    expect(failed).toContain("loadFailed");
  });
});
