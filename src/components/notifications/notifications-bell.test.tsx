import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Minimal browser environment polyfill for Node-based Vitest runs.
const mockStorage: Record<string, string> = {};
(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
    clear: () => {
      Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    },
    key: (index: number) => Object.keys(mockStorage)[index] ?? null,
    get length() {
      return Object.keys(mockStorage).length;
    },
  },
  Notification: {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  },
  document: { visibilityState: "visible", hasFocus: () => true },
  location: { href: "" },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

import { NotificationsBell } from "./notifications-bell";

const notifications = [
  {
    id: "n1",
    deliveryId: "d1",
    category: "chat_reply" as const,
    title: "Chat reply",
    body: "The agent has replied.",
    preview: "The agent...",
    threadId: "thread-1",
    read: false,
    dismissed: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: "n2",
    deliveryId: "d2",
    category: "schedule_result" as const,
    title: "Schedule finished",
    body: "A scheduled run completed.",
    scheduleId: "schedule-1",
    read: true,
    dismissed: false,
    createdAt: new Date().toISOString(),
  },
];

let swrData: unknown[] | undefined = [];
let swrLoading = false;

vi.mock("swr", () => ({
  default: vi.fn(() => ({
    data: swrData,
    error: undefined,
    isLoading: swrLoading,
    mutate: vi.fn(),
  })),
  SWRConfig: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("sonner", () => ({
  toast: vi.fn().mockReturnValue("toast-1"),
  Toaster: () => null,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <div data-slot="popover">{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children, sideOffset, ...props }: any) => <div {...props}>{children}</div>,
  PopoverAnchor: ({ children }: any) => <>{children}</>,
}));

vi.mock("ui/popover", () => ({
  Popover: ({ children }: any) => <div data-slot="popover">{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children, sideOffset, ...props }: any) => <div {...props}>{children}</div>,
  PopoverAnchor: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn().mockResolvedValue({}),
  apiFetch: vi.fn().mockResolvedValue(new Response()),
}));

vi.mock("@/lib/backend/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend/config")>(
    "@/lib/backend/config",
  );
  return {
    ...actual,
    getSessionToken: vi.fn().mockReturnValue("test-token"),
    backendUrl: (path: string) => `http://localhost:8787${path}`,
  };
});

beforeEach(() => {
  swrData = notifications;
  swrLoading = false;
  window.localStorage.clear();
  window.Notification = {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  } as unknown as typeof window.Notification;
});

describe("NotificationsBell", () => {
  it("renders the bell button with unread badge", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-bell-button"');
    expect(html).toContain('data-testid="notifications-unread-badge"');
    expect(html).toContain("1");
  });

  it("renders the popover panel with controls", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-bell-popover"');
    expect(html).toContain('data-testid="notifications-bell-count"');
    expect(html).toContain('data-testid="notifications-unread-toggle"');
    expect(html).toContain('data-testid="notifications-mark-all-read"');
    expect(html).toContain('data-testid="notifications-clear-all"');
    expect(html).toContain('data-testid="notifications-settings-link"');
  });

  it("renders notification rows for each item", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-bell-list"');
    expect(html).toContain('data-testid="notification-row"');
    expect(html).toContain('data-notification-id="n1"');
    expect(html).toContain('data-notification-id="n2"');
  });

  it("shows category badges for chat and schedule", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notification-category-chat_reply"');
    expect(html).toContain('data-testid="notification-category-schedule_result"');
  });

  it("renders empty state when there are no notifications", () => {
    swrData = [];
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-empty-state"');
    expect(html).toContain('data-testid="notifications-send-test"');
  });

  it("shows a browser permission banner when permission is prompt", () => {
    (window.Notification as any).permission = "default";
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-enable-browser"');
  });

  it("shows Desktop Native Active pill when in Amiro Desktop", () => {
    (window as any).__AMIRO_DESKTOP__ = true;
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain("Desktop Native Active");
    delete (window as any).__AMIRO_DESKTOP__;
  });
});
