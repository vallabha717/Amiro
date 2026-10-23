"use client";

import { apiJson } from "@/lib/backend/client";

export type NotifyChannelId = "telegram" | "slack" | "discord";

export const NOTIFY_CHANNELS: NotifyChannelId[] = ["telegram", "slack", "discord"];

export const NOTIFICATION_CHANNELS_PATH = "/api/notifications/channels";
export const NOTIFICATION_CHANNELS_KEY = "/api/notifications/channels";

/**
 * What a channel still needs before notifications reach the owner there:
 * its bot connected in Channels, then the owner's own account added and
 * verified on their contact card in Contacts.
 */
export type NotifyChannelStep =
  | "ready"
  | "connect_bot"
  | "add_address"
  | "verify_address"
  | "fix_address"
  | "owner_only";

/** One external channel's readiness, as `GET /api/notifications/channels` reports it. */
export interface NotifyChannelStatus {
  channel: NotifyChannelId;
  botConfigured: boolean;
  botName: string | null;
  /** The owner's account on this channel, from their contact card. */
  address: string | null;
  contactChannelId: string | null;
  verified: boolean;
  ready: boolean;
  nextStep: NotifyChannelStep;
}

const STEPS: NotifyChannelStep[] = [
  "ready",
  "connect_bot",
  "add_address",
  "verify_address",
  "fix_address",
  "owner_only",
];

export function isNotifyChannelId(value: unknown): value is NotifyChannelId {
  return typeof value === "string" && (NOTIFY_CHANNELS as string[]).includes(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeChannelStatus(raw: unknown): NotifyChannelStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nextStep = STEPS.includes(r.nextStep as NotifyChannelStep)
    ? (r.nextStep as NotifyChannelStep)
    : "connect_bot";
  return {
    channel: isNotifyChannelId(r.channel) ? r.channel : "telegram",
    botConfigured: r.botConfigured === true,
    botName: text(r.botName),
    address: text(r.address),
    contactChannelId: text(r.contactChannelId),
    verified: r.verified === true,
    ready: r.ready === true && nextStep === "ready",
    nextStep,
  };
}

export async function fetchNotifyChannels(): Promise<NotifyChannelStatus[]> {
  const data = await apiJson<{ channels?: unknown[] }>(NOTIFICATION_CHANNELS_PATH);
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  return channels.map(normalizeChannelStatus);
}

export async function resendNotifyDelivery(input: {
  deliveryId: string;
  channel: NotifyChannelId;
}): Promise<{ deliveryId: string; channel: string; status: string; error?: string }> {
  return await apiJson(`${NOTIFICATION_CHANNELS_PATH}/resend`, {
    method: "POST",
    body: JSON.stringify({ deliveryId: input.deliveryId, channel: input.channel }),
  });
}
