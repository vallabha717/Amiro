"use client";

import useSWR from "swr";
import { apiJson, fetcher } from "./client";

export interface ContactChannelPayload {
  id: string;
  contactId: string;
  type: string;
  address: string;
  isPrimary: boolean;
  externalChatId?: string | null;
  externalUserId?: string | null;
  status: "active" | "unverified" | "revoked" | "blocked" | string;
  policy: "allow" | "deny" | string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
  lastSeenAt?: number | null;
  interactionCount: number;
  lastInteraction?: number | null;
  revokedReason?: string | null;
  blockedReason?: string | null;
}

export interface ContactPayload {
  id: string;
  displayName: string;
  role: "guardian" | "contact" | string;
  notes?: string | null;
  contactType?: "human" | "assistant" | string;
  principalId?: string | null;
  interactionCount: number;
  lastInteraction?: number | null;
  autoApproveThreshold?: "none" | "low" | "medium" | "high" | null;
  createdAt: number;
  updatedAt: number;
  channels: ContactChannelPayload[];
}

export interface ContactSummary {
  id: string;
  displayName: string;
  role: string;
  contactType?: string | null;
  channelTypes?: string[];
  verified?: boolean;
}

export const CONTACTS_KEY = "/api/contacts";

export function useContacts(role?: string) {
  const url = role ? `${CONTACTS_KEY}?role=${encodeURIComponent(role)}` : CONTACTS_KEY;
  return useSWR<{ ok: boolean; contacts: ContactPayload[] }>(url, fetcher, {
    revalidateOnFocus: true,
  });
}

export function useContact(id: string | null) {
  const url = id ? `${CONTACTS_KEY}/${encodeURIComponent(id)}` : null;
  return useSWR<{ ok: boolean; contact: ContactPayload }>(url, fetcher);
}

export async function upsertContact(params: {
  id?: string;
  displayName: string;
  notes?: string | null;
  autoApproveThreshold?: string | null;
  channels?: Array<{ type: string; address: string; isPrimary?: boolean }>;
}) {
  return apiJson<{ ok: boolean; contact: ContactPayload }>(CONTACTS_KEY, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function deleteContact(id: string) {
  return apiJson<void>(`${CONTACTS_KEY}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function mergeContacts(keepId: string, mergeId: string) {
  return apiJson<{ ok: boolean; contact: ContactPayload }>("/api/contacts/merge", {
    method: "POST",
    body: JSON.stringify({ keepId, mergeId }),
  });
}

export async function verifyContactChannel(channelId: string) {
  return apiJson<{ ok: boolean }>(`/api/contact-channels/${encodeURIComponent(channelId)}/verify`, {
    method: "POST",
  });
}

export async function updateContactChannelStatus(
  channelId: string,
  params: { status?: string; policy?: string; reason?: string },
) {
  return apiJson<{ ok: boolean; contact: ContactPayload }>(
    `/api/contact-channels/${encodeURIComponent(channelId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(params),
    },
  );
}

export async function createContactInvite(params: {
  contactId: string;
  sourceChannel?: string;
  note?: string;
}) {
  return apiJson<{ ok: boolean; invite: unknown; token: string }>("/api/contacts/invites", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function redeemInvite(token: string) {
  return apiJson<{ ok: boolean; success: boolean; contactId: string }>("/api/contacts/invites/redeem", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
