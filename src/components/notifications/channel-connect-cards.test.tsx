import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.channel ? `${key}:${vars.channel}` : key,
}));

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({ data: undefined, mutate: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/components/credentials/secret-prompt-card", () => ({
  SecretPromptCard: ({ prompt }: any) =>
    createElement("div", {
      "data-testid": "secret-prompt-card",
      "data-service": prompt.service,
      "data-field": prompt.field,
    }),
}));

vi.mock("@/lib/notifications/notification-channels-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/notification-channels-api")>();
  return {
    ...actual,
    fetchNotifyChannels: vi.fn().mockResolvedValue([]),
    bindNotifyChannel: vi.fn(),
    unbindNotifyChannel: vi.fn(),
  };
});

import {
  ChannelCard,
  ChannelConnectCards,
} from "./channel-connect-cards";

describe("ChannelCard", () => {
  it("renders an unbound channel with chat input and bind button", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelCard, {
        binding: {
          channel: "telegram",
          bound: false,
          chatId: null,
          chatName: null,
          updatedAt: null,
          hasToken: false,
        },
        onChanged: () => {},
      }),
    );
    expect(html).toContain('data-testid="channel-connect-telegram"');
    expect(html).toContain('data-testid="channel-chat-id-telegram"');
    expect(html).toContain('data-testid="channel-bind-telegram"');
    expect(html).not.toContain('data-testid="channel-unbind-telegram"');
    // Token entry goes through the secure secret card, never a plain input.
    expect(html).toContain('data-testid="secret-prompt-card"');
    expect(html).toContain('data-service="notify.telegram"');
    expect(html).toContain('data-field="bot_token"');
  });

  it("renders a bound channel with its display name and unbind button", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelCard, {
        binding: {
          channel: "slack",
          bound: true,
          chatId: "U42",
          chatName: "T/U",
          updatedAt: "2026-10-21T00:00:00Z",
          hasToken: true,
        },
        onChanged: () => {},
      }),
    );
    expect(html).toContain('data-testid="channel-status-slack"');
    expect(html).toContain('data-testid="channel-name-slack"');
    expect(html).toContain('data-testid="channel-unbind-slack"');
    // Metadata only: no token value is rendered.
    expect(html).not.toContain("bot_token_value");
  });
});

describe("ChannelConnectCards", () => {
  it("renders one card per external channel", () => {
    const html = renderToStaticMarkup(createElement(ChannelConnectCards));
    for (const channel of ["telegram", "slack", "discord"]) {
      expect(html).toContain(`data-testid="channel-connect-${channel}"`);
    }
    expect(html).toContain('data-testid="channel-connect-section"');
  });
});
