import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

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
  toast: { success: vi.fn(), error: vi.fn() },
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

// The overflow menu renders open, so its items can be asserted statically.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div data-slot="menu">{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect, variant, ...props }: any) => (
    <div role="menuitem" {...props}>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
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
  it("renders the bell button with unread badge and shell testids", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-bell"');
    expect(html).toContain('data-testid="notifications-unread-badge"');
    expect(html).toContain('data-testid="notifications-bell-popover"');
    expect(html).toContain('data-testid="notifications-bell-count"');
    // Opens on unread only, like Vellum: the read row waits behind the switch.
    expect(html).toContain('data-testid="notification-row-n1"');
    expect(html).not.toContain('data-testid="notification-row-n2"');
  });

  it("renders the unread switch and one overflow menu instead of filter chips", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-feed"');
    expect(html).toContain('data-testid="notifications-filter-unread"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-testid="notifications-actions"');
    expect(html).not.toContain('data-testid="notifications-filter-all"');
    expect(html).not.toContain('data-testid="notifications-filter-chat_reply"');
  });

  it("names the unread count on the bell for screen readers", () => {
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('aria-label="labelUnread"');
  });

  it("shows the empty state and keeps send-test in the menu", () => {
    swrData = [];
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-empty-state"');
    expect(html).toContain('data-testid="notifications-send-test"');
  });

  it("offers browser notifications in the menu when permission is prompt", () => {
    (window.Notification as any).permission = "default";
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).toContain('data-testid="notifications-enable-browser"');
  });

  it("never asks for browser permission inside Amiro Desktop", () => {
    (window as any).__AMIRO_DESKTOP__ = true;
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).not.toContain('data-testid="notifications-enable-browser"');
    delete (window as any).__AMIRO_DESKTOP__;
  });

  it("hides the badge when everything is read", () => {
    swrData = notifications.map((n) => ({ ...n, read: true, status: "seen" }));
    const html = renderToStaticMarkup(createElement(NotificationsBell));
    expect(html).not.toContain('data-testid="notifications-unread-badge"');
  });
});
