"use client";

import { apiJson, fetcher } from "@/lib/backend/client";
import useSWR, { mutate } from "swr";

export const ONBOARDING_KEY = "/api/onboarding";

export type OnboardingStepId = "account" | "agent" | "provider";

/** Where a step's settings came from when not the wizard. */
export type ConfigSource = ".env" | "amiro.toml" | null;

export interface OnboardingState {
  completed: boolean;
  completedAt: string | null;
  skipped: OnboardingStepId[];
  isOwner: boolean;
  deployment: {
    mode: "desktop" | "local-server" | "vm-remote";
    bindHost: string;
    port: number;
    accessUrls?: string[];
  };
  steps: {
    account: {
      done: boolean;
      name?: string;
      email?: string;
      timezone?: string | null;
      source: ConfigSource;
    };
    agent: {
      done: boolean;
      name?: string;
      traits?: { bodyShape?: string; eyeStyle?: string; color?: string };
      accentHex?: string;
      source: ConfigSource;
    };
    provider: { done: boolean; connected: string[]; source: ConfigSource };
  };
  config: { envFiles: string[]; tomlFile: string | null; errors: string[] };
}

export function useOnboarding(enabled = true) {
  return useSWR<OnboardingState>(enabled ? ONBOARDING_KEY : null, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

export async function saveProfile(input: { name?: string; timezone?: string }) {
  return apiJson<{ ok: boolean; name: string; timezone: string }>(
    "/api/onboarding/profile",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function completeOnboarding(skipped: OnboardingStepId[]) {
  const doc = await apiJson("/api/onboarding/complete", {
    method: "POST",
    body: JSON.stringify({ skipped }),
  });
  await mutate(ONBOARDING_KEY);
  return doc;
}

export async function reopenOnboarding() {
  await apiJson("/api/onboarding/reset", { method: "POST" });
  await mutate(ONBOARDING_KEY);
}

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function listTimezones(): string[] {
  try {
    const values = (Intl as any).supportedValuesOf?.("timeZone") as
      | string[]
      | undefined;
    if (values?.length) return values;
  } catch {}
  return [detectTimezone(), "UTC"];
}

/** Where each skipped step can be finished later. */
export const LATER: Record<
  OnboardingStepId,
  { href: string; place: string; title: string }
> = {
  account: {
    href: "/",
    place: "Your profile menu → Settings",
    title: "Your account",
  },
  agent: {
    href: "/agent",
    place: "Agent → Customize",
    title: "Name and look",
  },
  provider: {
    href: "/admin/providers",
    place: "Admin → Providers",
    title: "AI provider",
  },
};
