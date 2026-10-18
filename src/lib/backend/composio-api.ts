"use client";

// Typed client for the Composio connectors backend contract
// (GET/PUT/DELETE /api/composio/config, GET /api/composio/toolkits,
// GET /api/composio/connections, POST /api/composio/connect,
// GET /api/composio/connections/:id/status,
// DELETE /api/composio/connections/:id, POST /api/composio/sync).
// Mirrors src/lib/backend/mcp-api.ts: thin wrappers over apiJson from
// ./client so the sidecar base URL + auth headers are attached in one place.
import { apiJson } from "./client";

export type ComposioConfigSource = "ui" | "env" | "toml";

export interface ComposioConfig {
  configured: boolean;
  source: ComposioConfigSource | null;
  apiKeyHint: string | null;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  logo: string | null;
  description: string;
  categories: string[];
  authModes: string[];
  connected: boolean;
  connectionId: string | null;
  connectionStatus: string | null;
}

export interface ComposioToolkitsPage {
  items: ComposioToolkit[];
  nextCursor: string | null;
}

export interface ComposioConnection {
  id: string;
  toolkit: string;
  status: string;
  createdAt: string;
}

export type ComposioConnectionStatus =
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED";

export interface ComposioConnectResult {
  redirectUrl: string;
  connectionId: string;
}

export interface ComposioSyncResult {
  synced: boolean;
  toolkits: string[];
  reloaded: boolean;
}

export interface ComposioToolkitsParams {
  search?: string;
  cursor?: string;
  limit?: number;
}

/** Pure path builder (kept separate so it is unit-testable). */
export function buildComposioToolkitsPath(
  params?: ComposioToolkitsParams,
): string {
  const query = new URLSearchParams();
  const search = params?.search?.trim();
  if (search) query.set("search", search);
  if (params?.cursor) query.set("cursor", params.cursor);
  if (typeof params?.limit === "number")
    query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `/api/composio/toolkits?${suffix}` : "/api/composio/toolkits";
}

export async function selectComposioConfig(): Promise<ComposioConfig> {
  return apiJson<ComposioConfig>("/api/composio/config", { method: "GET" });
}

export async function saveComposioApiKey(
  apiKey: string,
): Promise<ComposioConfig> {
  return apiJson<ComposioConfig>("/api/composio/config", {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export async function removeComposioApiKey(): Promise<void> {
  await apiJson("/api/composio/config", { method: "DELETE" });
}

export async function selectComposioToolkits(
  params?: ComposioToolkitsParams,
): Promise<ComposioToolkitsPage> {
  return apiJson<ComposioToolkitsPage>(buildComposioToolkitsPath(params), {
    method: "GET",
  });
}

export async function selectComposioConnections(): Promise<
  ComposioConnection[]
> {
  return apiJson<ComposioConnection[]>("/api/composio/connections", {
    method: "GET",
  });
}

export async function startComposioConnect(
  toolkit: string,
): Promise<ComposioConnectResult> {
  return apiJson<ComposioConnectResult>("/api/composio/connect", {
    method: "POST",
    body: JSON.stringify({ toolkit }),
  });
}

export async function selectComposioConnectionStatus(
  connectionId: string,
): Promise<{ status: ComposioConnectionStatus; synced?: boolean }> {
  return apiJson<{ status: ComposioConnectionStatus; synced?: boolean }>(
    `/api/composio/connections/${encodeURIComponent(connectionId)}/status`,
    { method: "GET" },
  );
}

export async function removeComposioConnection(
  connectionId: string,
): Promise<void> {
  await apiJson(
    `/api/composio/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
}

export async function syncComposioConnections(): Promise<ComposioSyncResult> {
  return apiJson<ComposioSyncResult>("/api/composio/sync", { method: "POST" });
}
