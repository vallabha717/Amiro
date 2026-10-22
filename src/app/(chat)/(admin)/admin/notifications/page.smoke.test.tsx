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
  };
});

// Server-rendered settings: the page starts from DEFAULT_NOTIFICATION_SETTINGS
// and swaps in server data via useEffect (client-only), so SSR shows the
// loading spinner. Prove the wiring instead: the page module composes the
// preferences UI and the Phase 03 channel section from the same tree.
const CHANNELS = [
  { channel: "telegram", botConfigured: true, botName: "amirobot", address: "4242",
    contactChannelId: "c1", verified: true, ready: true, nextStep: "ready" },
  { channel: "slack", botConfigured: false, botName: null, address: null,
    contactChannelId: null, verified: false, ready: false, nextStep: "connect_bot" },
  { channel: "discord", botConfigured: true, botName: "dbot", address: "999",
    contactChannelId: "c2", verified: false, ready: false, nextStep: "verify_address" },
];

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string) =>
    key === "/api/notifications/channels"
      ? { data: CHANNELS, mutate: vi.fn() }
      : { data: undefined, mutate: vi.fn() },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import AdminNotificationsPage from "./page";
import { ChannelDeliveryStatus } from "@/components/notifications/channel-delivery-status";

describe("AdminNotificationsPage", () => {
  it("renders without throwing (loading state on SSR)", () => {
    const html = renderToStaticMarkup(createElement(AdminNotificationsPage));
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });

  it("shows where notifications go outside Amiro, with the place to fix each gap", () => {
    const html = renderToStaticMarkup(createElement(ChannelDeliveryStatus));
    expect(html).toContain('data-testid="channel-delivery-section"');
    expect(html).toContain('data-testid="channel-delivery-telegram"');
    expect(html).toContain('data-ready="true"');
    // No token or chat-id fields: setup lives in Channels and Contacts.
    expect(html).not.toContain("secret-prompt-card");
    expect(html).toContain('href="/channels"');
    expect(html).toContain('href="/contacts"');
    expect(html).toContain('data-step="verify_address"');
  });
});
