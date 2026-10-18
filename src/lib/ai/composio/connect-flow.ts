"use client";

// Composio OAuth-style connect flow. Mirrors the Tauri-safe approach in
// src/lib/ai/mcp/oauth-redirect.ts: open the provider URL with
// window.open (works in the browser and inside the Tauri webview, where
// there is no shell-open plugin wired up), then poll the connection status
// endpoint until it leaves INITIATED instead of relying on postMessage
// across the third-party provider origin.
import {
  ComposioConnectionStatus,
  selectComposioConnectionStatus,
} from "@/lib/backend/composio-api";
import { wait } from "lib/utils";

export const COMPOSIO_CONNECT_POLL_INTERVAL_MS = 2000;
export const COMPOSIO_CONNECT_POLL_ATTEMPTS = 60;

export type ComposioTerminalStatus = Extract<
  ComposioConnectionStatus,
  "ACTIVE" | "FAILED" | "EXPIRED"
>;

export function isComposioTerminalStatus(
  status: ComposioConnectionStatus,
): status is ComposioTerminalStatus {
  return status === "ACTIVE" || status === "FAILED" || status === "EXPIRED";
}

/**
 * Poll GET /api/composio/connections/:id/status until the connection
 * leaves INITIATED. Resolves with the terminal status; throws when the
 * status never settles within `maxAttempts` polls.
 */
export async function pollComposioConnectionStatus(
  connectionId: string,
  options?: {
    maxAttempts?: number;
    intervalMs?: number;
    getStatus?: (id: string) => Promise<{ status: ComposioConnectionStatus }>;
  },
): Promise<ComposioTerminalStatus> {
  const maxAttempts = options?.maxAttempts ?? COMPOSIO_CONNECT_POLL_ATTEMPTS;
  const intervalMs = options?.intervalMs ?? COMPOSIO_CONNECT_POLL_INTERVAL_MS;
  const getStatus = options?.getStatus ?? selectComposioConnectionStatus;
  let lastStatus: ComposioConnectionStatus = "INITIATED";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await getStatus(connectionId);
    lastStatus = result.status;
    if (isComposioTerminalStatus(result.status)) return result.status;
    await wait(intervalMs);
  }
  throw new Error(
    `Connection ${connectionId} is still ${lastStatus} after ${maxAttempts} checks`,
  );
}

/**
 * Open a URL the same way the MCP OAuth flow does: a named window.open
 * popup that also works inside the Tauri webview. Returns the window (or
 * null when the popup was blocked) so callers can close it once polling
 * settles.
 */
export function openComposioRedirect(redirectUrl: string): Window | null {
  return window.open(
    redirectUrl,
    "composio-connect",
    "width=600,height=800,scrollbars=yes,resizable=yes",
  );
}
