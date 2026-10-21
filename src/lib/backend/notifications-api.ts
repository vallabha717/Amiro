"use client";

import { apiJson } from "@/lib/backend/client";
import {
  bindNotifyChannel,
  fetchNotifyChannels,
  unbindNotifyChannel,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
  channelVaultSlot,
  type NotifyChannelBinding,
  type NotifyChannelId,
} from "@/lib/notifications/notification-channels-api";

export {
  bindNotifyChannel,
  fetchNotifyChannels,
  unbindNotifyChannel,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
  channelVaultSlot,
  type NotifyChannelBinding,
  type NotifyChannelId,
};

export type DeliveryAttemptStatus = "sent" | "failed" | "skipped";

export interface NotificationDeliveryAttempt {
  deliveryId: string;
  signalId: string | null;
  userId?: string;
  channel: string;
  status: DeliveryAttemptStatus | string;
  error: string | null;
  recordedAt: string | null;
}

function normalizeAttempt(raw: unknown): NotificationDeliveryAttempt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const channel = typeof r.channel === "string" ? r.channel : "";
  if (!channel) return null;
  return {
    deliveryId: typeof r.deliveryId === "string" ? r.deliveryId : "",
    signalId: typeof r.signalId === "string" ? r.signalId : null,
    userId: typeof r.userId === "string" ? r.userId : undefined,
    channel,
    status: typeof r.status === "string" ? r.status : "failed",
    error: typeof r.error === "string" ? r.error : null,
    recordedAt: typeof r.recordedAt === "string" ? r.recordedAt : null,
  };
}

/** Per-channel delivery rows for one feed item (local + externals + resends). */
export async function fetchNotificationDeliveries(
  notificationId: string,
): Promise<NotificationDeliveryAttempt[]> {
  const data = await apiJson<{ deliveries?: unknown[] }>(
    `/api/notifications/${encodeURIComponent(notificationId)}/deliveries`,
  );
  const rows = Array.isArray(data?.deliveries) ? data.deliveries : [];
  return rows
    .map(normalizeAttempt)
    .filter((d): d is NotificationDeliveryAttempt => d !== null);
}

/** Re-send one notification through an external channel. */
export async function resendNotificationDelivery(input: {
  deliveryId: string;
  channel: NotifyChannelId;
}): Promise<{ deliveryId: string; channel: string; status: string; error?: string }> {
  return await apiJson("/api/notifications/channels/resend", {
    method: "POST",
    body: JSON.stringify({ deliveryId: input.deliveryId, channel: input.channel }),
  });
}
