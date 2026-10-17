"use client";

// Client-side calls against the native backend's /api/ai/providers/** routes
// (backend/src/models.rs: connected providers only, with the runtime's full
// model catalog per provider), mirroring mcp-api.ts for MCP servers. For the
// full provider *catalog* -- every provider the runtime supports, connected or
// not -- use GET /api/providers/catalog (backend/src/routes/providers_catalog.rs).
import { apiJson } from "./client";

export interface ProviderConfig {
  id: string;
  name: string;
  /** Provider *type* ("openai", "anthropic", ...), not the connection id. */
  provider: string;
  /** True when a key is stored. */
  configured: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

/** Payload for creating or updating a connection. */
export interface ProviderConfigInput {
  id?: string;
  name: string;
  provider: string;
  /** Empty on an update means "keep the stored key". */
  apiKey: string;
  baseUrl: string;
  models: string[];
}

/**
 * Token counts come back with Go's exported field names because
 * bifrostai.Usage carries no json tags -- matched here rather than renamed,
 * so the type tells the truth about the wire format.
 */
export interface ProviderTestUsage {
  PromptTokens: number;
  CompletionTokens: number;
  TotalTokens: number;
}

export interface ProviderTestResult {
  ok: boolean;
  model: string;
  provider: string;
  latencyMs: number;
  text: string;
  usage?: ProviderTestUsage;
  toolCall?: {
    supported: boolean;
    name?: string;
    arguments?: string;
    error?: string;
  };
  note?: string;
  error?: string;
}

export const PROVIDERS_KEY = "/api/ai/providers";

export async function selectProviders() {
  return apiJson<ProviderConfig[]>(PROVIDERS_KEY);
}

export async function saveProvider(config: ProviderConfigInput) {
  return apiJson<{ id: string }>(PROVIDERS_KEY, {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function removeProvider(id: string) {
  await apiJson(`${PROVIDERS_KEY}/${id}`, { method: "DELETE" });
}

/**
 * Lists a provider's models without saving them -- for the editor, where the
 * connection may not exist yet. Pass `id` to reuse a saved connection's
 * stored credentials for any field left blank.
 */
export async function fetchProviderModels(input: {
  id?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  return apiJson<{ models: string[] }>(`${PROVIDERS_KEY}/models`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Re-lists a saved connection's models and persists the result. */
export async function syncProviderModels(id: string) {
  return apiJson<{ models: string[] }>(`${PROVIDERS_KEY}/${id}/sync-models`, {
    method: "POST",
  });
}

/** Runs one real round trip against a model, including a tool-call probe. */
export async function testProviderModel(id: string, model: string) {
  return apiJson<ProviderTestResult>(`${PROVIDERS_KEY}/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}
