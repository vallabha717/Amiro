import { describe, expect, it, vi } from "vitest";

import {
  fetchNotificationDeliveries,
  resendNotificationDelivery,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
} from "./notifications-api";

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn(),
}));

async function lastCall() {
  const { apiJson } = await import("@/lib/backend/client");
  const calls = (apiJson as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  return calls[calls.length - 1] as [string, ...unknown[]];
}

describe("notifications-api", () => {
  it("re-exports the channel readiness client from a single surface", () => {
    expect(NOTIFY_CHANNELS).toEqual(["telegram", "slack", "discord"]);
    expect(NOTIFICATION_CHANNELS_KEY).toBe("/api/notifications/channels");
  });

  it("fetches per-notification deliveries and normalizes rows", async () => {
    const { apiJson } = await import("@/lib/backend/client");
    vi.mocked(apiJson).mockResolvedValueOnce({
      deliveries: [
        {
          deliveryId: "d1",
          signalId: "s1",
          channel: "local",
          status: "sent",
          error: null,
          recordedAt: "2026-10-21T00:00:00Z",
        },
        {
          deliveryId: "d1",
          signalId: "s1",
          channel: "telegram",
          status: "failed",
          error: "401",
          recordedAt: "2026-10-21T00:01:00Z",
        },
        { nope: true },
      ],
    });
    const rows = await fetchNotificationDeliveries("n1");
    expect(apiJson).toHaveBeenCalledWith("/api/notifications/n1/deliveries");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ channel: "local", status: "sent" });
    expect(rows[1]).toMatchObject({ channel: "telegram", status: "failed", error: "401" });
  });

  it("resends through the channels resend endpoint with delivery + channel", async () => {
    const { apiJson } = await import("@/lib/backend/client");
    vi.mocked(apiJson).mockResolvedValueOnce({
      deliveryId: "d2",
      channel: "telegram",
      status: "sent",
    });
    const result = await resendNotificationDelivery({
      deliveryId: "d1",
      channel: "telegram",
    });
    const [path, init] = await lastCall();
    expect(path).toBe("/api/notifications/channels/resend");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      deliveryId: "d1",
      channel: "telegram",
    });
    expect(result).toMatchObject({ status: "sent" });
  });
});
