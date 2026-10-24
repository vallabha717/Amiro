import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

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

let deliveriesData: unknown[] | undefined;
let deliveriesError: Error | undefined;
let deliveriesLoading = false;

vi.mock("swr", () => ({
  default: vi.fn((key: string) => ({
    data:
      typeof key === "string" && key.includes("/deliveries")
        ? deliveriesData
        : undefined,
    error: deliveriesError,
    isLoading: deliveriesLoading,
    mutate: vi.fn(),
  })),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn().mockResolvedValue({}),
}));

import { NotificationDetail } from "./notification-detail";
import type { AmiroNotification } from "@/lib/notifications/notification-types";

const base: AmiroNotification = {
  id: "n1",
  deliveryId: "d1",
  category: "chat_reply",
  urgency: "high",
  status: "new",
  title: "Chat reply",
  body: "The agent has replied.",
  preview: "The agent…",
  threadId: "thread-1",
  scheduleId: null,
  read: false,
  dismissed: false,
  createdAt: new Date("2026-10-21T11:00:00Z").toISOString(),
  deliveryReceipt: "in_app_toast",
};

const props = {
  notification: base,
  onBack: () => {},
  onMutate: () => {},
  onDismissed: () => {},
  onNavigate: () => {},
};

describe("NotificationDetail", () => {
  beforeEach(() => {
    deliveriesData = [
      {
        deliveryId: "d1",
        channel: "local",
        status: "sent",
        error: null,
        recordedAt: "2026-10-21T11:00:01Z",
      },
      {
        deliveryId: "d1",
        channel: "telegram",
        status: "failed",
        error: "401 from provider",
        recordedAt: "2026-10-21T11:00:02Z",
      },
    ];
    deliveriesError = undefined;
    deliveriesLoading = false;
  });

  it("renders the detail shell with heading, body, and actions", () => {
    const html = renderToStaticMarkup(createElement(NotificationDetail, props));
    expect(html).toContain('data-testid="notification-detail"');
    // Vellum's detail: the title is the panel heading, back sits beside it,
    // and the footer carries the time and the way to the chat.
    expect(html).toContain("<h2");
    expect(html).toContain('data-testid="notifications-back"');
    expect(html).toContain('data-testid="notification-detail-footer"');
    expect(html).toContain("goToConversation");
    expect(html).toContain("The agent has replied.");
    expect(html).toContain('data-testid="notification-view-source"');
    expect(html).toContain('data-testid="notification-toggle-read"');
    expect(html).toContain('data-testid="notification-dismiss"');
  });

  it("lists per-channel delivery state with resend only for failed externals", () => {
    const html = renderToStaticMarkup(createElement(NotificationDetail, props));
    expect(html).toContain('data-testid="notification-deliveries"');
    expect(html).toContain('data-testid="notification-delivery-local"');
    expect(html).toContain('data-testid="notification-delivery-telegram"');
    expect(html).toContain('data-testid="notification-resend-telegram"');
    expect(html).not.toContain('data-testid="notification-resend-local"');
  });

  it("shows delivery loading, error, and empty states", () => {
    deliveriesData = undefined;
    deliveriesLoading = true;
    const loading = renderToStaticMarkup(createElement(NotificationDetail, props));
    expect(loading).toContain('data-testid="notification-deliveries-loading"');
    deliveriesLoading = false;
    deliveriesError = new Error("offline");
    const failed = renderToStaticMarkup(createElement(NotificationDetail, props));
    expect(failed).toContain('data-testid="notification-deliveries-error"');

    deliveriesError = undefined;
    deliveriesData = [];
    const empty = renderToStaticMarkup(createElement(NotificationDetail, props));
    expect(empty).toContain('data-testid="notification-deliveries-empty"');
  });

  it("hides the view action when there is no source to open", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationDetail, {
        ...props,
        notification: { ...base, threadId: null, scheduleId: null, read: true },
      }),
    );
    expect(html).not.toContain('data-testid="notification-view-source"');
    expect(html).toContain("markUnread");
  });
});
