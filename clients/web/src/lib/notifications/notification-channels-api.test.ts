import { describe, expect, it, vi } from "vitest";

import {
  fetchNotifyChannels,
  isNotifyChannelId,
  normalizeChannelStatus,
  NOTIFY_CHANNELS,
} from "./notification-channels-api";

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn(),
}));

describe("notification-channels-api", () => {
  it("accepts only the three external channels", () => {
    expect(NOTIFY_CHANNELS).toEqual(["telegram", "slack", "discord"]);
    expect(isNotifyChannelId("telegram")).toBe(true);
    expect(isNotifyChannelId("local")).toBe(false);
    expect(isNotifyChannelId(null)).toBe(false);
  });

  it("reads readiness rows and never trusts ready without the ready step", async () => {
    const { apiJson } = await import("@/lib/backend/client");
    vi.mocked(apiJson).mockResolvedValueOnce({
      channels: [
        { channel: "telegram", botConfigured: true, botName: "amirobot", address: "42",
          contactChannelId: "c1", verified: true, ready: true, nextStep: "ready" },
        { channel: "slack", botConfigured: false, ready: true, nextStep: "connect_bot" },
      ],
    });
    const rows = await fetchNotifyChannels();
    expect(rows[0]).toMatchObject({ channel: "telegram", ready: true, address: "42", botName: "amirobot" });
    expect(rows[1]).toMatchObject({ channel: "slack", ready: false, nextStep: "connect_bot", address: null });
  });

  it("falls back safely on an unknown step", () => {
    expect(normalizeChannelStatus({ channel: "discord", nextStep: "bogus" }).nextStep).toBe("connect_bot");
  });
});
