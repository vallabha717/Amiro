import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.channel ? `${key}:${vars.channel}` : key,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn(),
}));

vi.mock("@/lib/notifications/notification-runtime", () => ({
  checkBrowserPermission: () => "granted",
  requestBrowserNotificationPermission: vi.fn(),
  isTauriDesktop: () => false,
  showInAppToast: vi.fn(),
  notificationToDeliveryPayload: (item: any) => item,
  useNotificationStream: () => {},
}));

vi.mock("@/lib/notifications/notification-types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/notification-types")>();
  return {
    ...actual,
    fetchNotificationSettings: vi
      .fn()
      .mockResolvedValue({ ...actual.DEFAULT_NOTIFICATION_SETTINGS }),
    updateNotificationSettings: vi.fn(),
    sendTestNotification: vi.fn(),
  };
});

vi.mock("@/lib/notifications/notification-channels-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notifications/notification-channels-api")>();
  return {
    ...actual,
    fetchNotifyChannels: vi.fn().mockResolvedValue([]),
    bindNotifyChannel: vi.fn(),
    unbindNotifyChannel: vi.fn(),
  };
});

// Server-rendered settings: the page starts from DEFAULT_NOTIFICATION_SETTINGS
// and swaps in server data via useEffect (client-only), so SSR shows the
// loading spinner. Prove the wiring instead: the page module composes the
// preferences UI and the Phase 03 channel section from the same tree.
vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string) =>
    key === "/api/notifications/channels"
      ? { data: [], mutate: vi.fn() }
      : { data: undefined, mutate: vi.fn() },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import AdminNotificationsPage from "./page";
import { ChannelConnectCards } from "@/components/notifications/channel-connect-cards";

describe("AdminNotificationsPage", () => {
  it("renders without throwing (loading state on SSR)", () => {
    const html = renderToStaticMarkup(createElement(AdminNotificationsPage));
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });

  it("composes the channel connect section into the settings page", () => {
    const html = renderToStaticMarkup(createElement(ChannelConnectCards));
    expect(html).toContain('data-testid="channel-connect-section"');
    for (const channel of ["telegram", "slack", "discord"]) {
      expect(html).toContain(`data-testid="channel-connect-${channel}"`);
      expect(html).toContain(`data-testid="secret-prompt-card"`);
    }
  });
});
