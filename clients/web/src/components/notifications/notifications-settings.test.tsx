import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
  default: vi.fn((key: string) => ({
    data:
      typeof key === "string" && key.includes("channels")
        ? []
        : {
            enabled: true,
            allAlertsEnabled: true,
            chatReplyAlerts: true,
            scheduleAlerts: true,
            heartbeatAlerts: true,
            soundEnabled: true,
            desktopBannerEnabled: true,
            webPushEnabled: true,
            quietHoursEnabled: false,
            quietStart: "22:00",
            quietEnd: "08:00",
          },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  })),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/components/credentials/secret-prompt-card", () => ({
  SecretPromptCard: () => createElement("div", { "data-testid": "secret-prompt-card" }),
}));

import { NotificationsSettings } from "./notifications-settings";

describe("NotificationsSettings", () => {
  it("renders toggles, quiet-hours switch, and where notifications go outside Amiro", () => {
    const html = renderToStaticMarkup(createElement(NotificationsSettings));
    expect(html).toContain('data-testid="notifications-settings"');
    for (const key of [
      "enabled",
      "chatReplyAlerts",
      "scheduleAlerts",
      "heartbeatAlerts",
      "soundEnabled",
      "desktopBannerEnabled",
      "webPushEnabled",
      "quietHoursEnabled",
    ]) {
      expect(html).toContain(`data-testid="notifications-settings-${key}"`);
    }
    // Phase 03 connect cards are reused, not rebuilt: one card per channel.
    expect(html).toContain('data-testid="channel-delivery-section"');
    expect(html).toContain('data-testid="channel-delivery-telegram"');
    expect(html).toContain('data-testid="channel-delivery-slack"');
    expect(html).toContain('data-testid="channel-delivery-discord"');
  });
});
