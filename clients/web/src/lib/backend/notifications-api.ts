"use client";

import { apiJson } from "@/lib/backend/client";
import {
  fetchNotifyChannels,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
  type NotifyChannelId,
  type NotifyChannelStatus,
} from "@/lib/notifications/notification-channels-api";

export {
  fetchNotifyChannels,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
  type NotifyChannelId,
  type NotifyChannelStatus,
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

/** What this tab shows, for `POST /api/notifications/presence`. */
export interface PresenceReport {
  clientId: string;
  /** On screen, focused, and touched recently. */
  visible: boolean;
  /** The chat open in this tab, or null. */
  threadId: string | null;
}

/**
 * Tell the backend which chat this tab has on screen. A reply to that chat is
 * then not notified, and its reply notifications and unseen mark clear.
 */
export async function reportPresence(
  report: PresenceReport,
): Promise<{ ok: boolean; markedRead: number }> {
  return await apiJson("/api/notifications/presence", {
    method: "POST",
    body: JSON.stringify(report),
  });
}

export const THREAD_ACTIVITY_KEY = "/api/thread-activity";

/** Chats with a status mark: working, an unseen reply, or an unseen failure. */
export interface ThreadActivity {
  running: string[];
  unseen: string[];
  failed: string[];
}

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export async function fetchThreadActivity(): Promise<ThreadActivity> {
  const data = await apiJson<Record<string, unknown>>(THREAD_ACTIVITY_KEY);
  return {
    running: ids(data?.running),
    unseen: ids(data?.unseen),
    failed: ids(data?.failed),
  };
}
