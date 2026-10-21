import { describe, expect, it, vi } from "vitest";

import {
  channelVaultSlot,
  isNotifyChannelId,
  NOTIFY_CHANNELS,
} from "./notification-channels-api";

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn(),
}));

describe("notification-channels-api", () => {
  it("accepts only the three external channels", () => {
    expect(NOTIFY_CHANNELS).toEqual(["telegram", "slack", "discord"]);
    expect(isNotifyChannelId("telegram")).toBe(true);
    expect(isNotifyChannelId("slack")).toBe(true);
    expect(isNotifyChannelId("discord")).toBe(true);
    expect(isNotifyChannelId("local")).toBe(false);
    expect(isNotifyChannelId("pigeon")).toBe(false);
    expect(isNotifyChannelId(null)).toBe(false);
  });

  it("maps each channel to its vault slot (never a secret value)", async () => {
    const { apiJson } = await import("@/lib/backend/client");
    expect(channelVaultSlot("telegram")).toEqual({
      service: "notify.telegram",
      field: "bot_token",
    });
    expect(channelVaultSlot("slack")).toEqual({
      service: "notify.slack",
      field: "bot_token",
    });
    expect(channelVaultSlot("discord")).toEqual({
      service: "notify.discord",
      field: "bot_token",
    });
    // The client layer is never handed a token by these helpers.
    expect(vi.mocked(apiJson)).not.toHaveBeenCalled();
  });
});
