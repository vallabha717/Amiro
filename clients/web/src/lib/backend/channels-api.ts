"use client";

import useSWR from "swr";
import { apiJson, fetcher } from "./client";

export type SetupChannelId = "slack" | "telegram" | "discord" | "phone" | "email";
export type ChannelStatus = "ready" | "incomplete" | "not_configured";

export interface ChannelReadinessSnapshot {
  channel: SetupChannelId;
  ready: boolean;
  setupStatus: ChannelStatus;
  health?: "ok" | "failing" | "unknown";
  channelHandle?: string | null;
  localChecks?: Array<{
    name: string;
    passed: boolean;
    message?: string | null;
  }>;
}

export interface ChannelInfo {
  id: SetupChannelId | string;
  source: string;
  label: string;
  subtitle: string;
  icon: string;
  supportsVerification: boolean;
  setupMessages: {
    guardian: string;
    contact: string;
  };
}

export type AdmissionPolicy =
  | "no_one"
  | "guardian_only"
  | "trusted_contacts"
  | "any_contact"
  | "strangers";

export interface ChannelPolicyView {
  channelType: string;
  policy: AdmissionPolicy;
  note?: string | null;
  updatedAt?: number | null;
}

export interface SlackConfigSnapshot {
  success: boolean;
  hasBotToken: boolean;
  hasAppToken: boolean;
  hasUserToken: boolean;
  connected: boolean;
  botUserId?: string;
  botUsername?: string;
  teamId?: string;
  teamName?: string;
  teamUrl?: string;
  threadMode?: "mention_only" | "mention_then_thread";
}

export interface TelegramConfigSnapshot {
  success: boolean;
  hasBotToken: boolean;
  connected: boolean;
  botUsername?: string;
  webhookUrl?: string;
}

export interface DiscordConfigSnapshot {
  success: boolean;
  hasBotToken: boolean;
  connected: boolean;
  botUsername?: string;
  applicationId?: string;
  inviteUrl?: string;
}

export interface TwilioConfigSnapshot {
  success: boolean;
  hasCredentials: boolean;
  phoneNumber?: string;
}

export const CHANNELS_AVAILABLE_KEY = "/api/channels/available";
export const CHANNELS_READINESS_KEY = "/api/channels/readiness";
export const CHANNELS_POLICY_KEY = "/api/channels/policy";
export const SLACK_CONFIG_KEY = "/api/integrations/slack/channel/config";
export const TELEGRAM_CONFIG_KEY = "/api/integrations/telegram/config";
export const DISCORD_CONFIG_KEY = "/api/integrations/discord/config";
export const TWILIO_CONFIG_KEY = "/api/integrations/twilio/credentials";

export function useAvailableChannels() {
  return useSWR<{ channels: ChannelInfo[] }>(CHANNELS_AVAILABLE_KEY, fetcher, {
    revalidateOnFocus: true,
  });
}

export function useChannelReadiness() {
  return useSWR<{ success: boolean; snapshots: ChannelReadinessSnapshot[] }>(
    CHANNELS_READINESS_KEY,
    fetcher,
    {
      refreshInterval: 15000,
      revalidateOnFocus: true,
    },
  );
}

export function useChannelPolicies() {
  return useSWR<{ policies: ChannelPolicyView[] }>(CHANNELS_POLICY_KEY, fetcher, {
    revalidateOnFocus: true,
  });
}

export async function setChannelPolicy(channelType: string, policy: AdmissionPolicy, note?: string) {
  return apiJson<{ policy: ChannelPolicyView }>("/api/channels/policy", {
    method: "PUT",
    body: JSON.stringify({ channelType, policy, note }),
  });
}

export function useSlackConfig() {
  return useSWR<SlackConfigSnapshot>(SLACK_CONFIG_KEY, fetcher);
}

export async function saveSlackConfig(params: { botToken: string; appToken: string; userToken?: string }) {
  return apiJson<SlackConfigSnapshot>(SLACK_CONFIG_KEY, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function patchSlackThreadMode(threadMode: "mention_only" | "mention_then_thread") {
  return apiJson<SlackConfigSnapshot>(SLACK_CONFIG_KEY, {
    method: "PATCH",
    body: JSON.stringify({ threadMode }),
  });
}

export async function deleteSlackConfig() {
  return apiJson<SlackConfigSnapshot>(SLACK_CONFIG_KEY, {
    method: "DELETE",
  });
}

export function useTelegramConfig() {
  return useSWR<TelegramConfigSnapshot>(TELEGRAM_CONFIG_KEY, fetcher);
}

export async function saveTelegramConfig(botToken: string) {
  return apiJson<TelegramConfigSnapshot>(TELEGRAM_CONFIG_KEY, {
    method: "POST",
    body: JSON.stringify({ botToken }),
  });
}

export async function deleteTelegramConfig() {
  return apiJson<TelegramConfigSnapshot>(TELEGRAM_CONFIG_KEY, {
    method: "DELETE",
  });
}

export function useDiscordConfig() {
  return useSWR<DiscordConfigSnapshot>(DISCORD_CONFIG_KEY, fetcher);
}

export async function saveDiscordConfig(botToken: string) {
  return apiJson<DiscordConfigSnapshot>(DISCORD_CONFIG_KEY, {
    method: "POST",
    body: JSON.stringify({ botToken }),
  });
}

export async function deleteDiscordConfig() {
  return apiJson<DiscordConfigSnapshot>(DISCORD_CONFIG_KEY, {
    method: "DELETE",
  });
}

export function useTwilioConfig() {
  return useSWR<TwilioConfigSnapshot>(TWILIO_CONFIG_KEY, fetcher);
}

export async function saveTwilioCredentials(accountSid: string, authToken: string, phoneNumber?: string) {
  return apiJson<TwilioConfigSnapshot>(TWILIO_CONFIG_KEY, {
    method: "POST",
    body: JSON.stringify({ accountSid, authToken, phoneNumber }),
  });
}

export async function deleteTwilioCredentials() {
  return apiJson<TwilioConfigSnapshot>(TWILIO_CONFIG_KEY, {
    method: "DELETE",
  });
}
