"use client";

import { apiJson } from "@/lib/backend/client";

export type NotifyChannelId = "telegram" | "slack" | "discord";

export const NOTIFY_CHANNELS: NotifyChannelId[] = ["telegram", "slack", "discord"];

export const NOTIFICATION_CHANNELS_PATH = "/api/notifications/channels";
export const NOTIFICATION_CHANNELS_KEY = "/api/notifications/channels";

export interface NotifyChannelBinding {
  channel: NotifyChannelId;
  bound: boolean;
  chatId: string | null;
  chatName: string | null;
  updatedAt: string | null;
  hasToken: boolean;
}

export interface NotifyChannelsResponse {
  channels: NotifyChannelBinding[];
}

export function isNotifyChannelId(value: unknown): value is NotifyChannelId {
  return (
    typeof value === "string" &&
    (NOTIFY_CHANNELS as string[]).includes(value)
  );
}

function normalizeBinding(raw: unknown): NotifyChannelBinding {
  const r = (raw ?? {}) as Record<string, unknown>;
  const channel = isNotifyChannelId(r.channel) ? r.channel : "telegram";
  return {
    channel,
    bound: r.bound === true,
    chatId: typeof r.chatId === "string" ? r.chatId : null,
    chatName: typeof r.chatName === "string" ? r.chatName : null,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
    // Never the secret: the API returns metadata only.
    hasToken: r.hasToken === true,
  };
}

export async function fetchNotifyChannels(): Promise<NotifyChannelBinding[]> {
  const data = await apiJson<NotifyChannelsResponse>(NOTIFICATION_CHANNELS_PATH);
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  return channels.map(normalizeBinding);
}

export async function bindNotifyChannel(input: {
  channel: NotifyChannelId;
  chatId: string;
  /** Optional: when omitted the vault copy is reused (saved via the secret card). */
  token?: string;
}): Promise<NotifyChannelBinding> {
  const data = await apiJson<NotifyChannelBinding>(
    `${NOTIFICATION_CHANNELS_PATH}/bind`,
    {
      method: "POST",
      body: JSON.stringify({
        channel: input.channel,
        chatId: input.chatId,
        ...(input.token ? { token: input.token } : {}),
      }),
    },
  );
  return normalizeBinding(data);
}

export async function unbindNotifyChannel(
  channel: NotifyChannelId,
): Promise<void> {
  await apiJson(`${NOTIFICATION_CHANNELS_PATH}/${encodeURIComponent(channel)}`, {
    method: "DELETE",
  });
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

/** Vault slot the bot token for `channel` is saved under (secret card config). */
export function channelVaultSlot(channel: NotifyChannelId): {
  service: string;
  field: "bot_token";
} {
  return { service: `notify.${channel}`, field: "bot_token" };
}
