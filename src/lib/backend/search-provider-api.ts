import { apiJson } from "./client";

export const SEARCH_PROVIDERS_KEY = "/api/search/providers";
export const SEARCH_CATALOG_KEY = "/api/search/catalog";
export const SEARCH_ACTIVE_KEY = "/api/search/active";

/**
 * One saved provider, as the server reports it.
 *
 * Note what is absent: the API key. The server sends a masked `apiKeyHint`
 * (`brv…cdef`) and never the value, so the browser cannot leak what it was
 * never given. The editor round-trips a config by submitting an empty
 * `apiKey`, which the server reads as "keep the stored one".
 */
export interface SearchProviderConfig {
  id: string;
  name: string;
  provider: string;
  configured: boolean;
  apiKeyHint?: string;
  isActive: boolean;
  /** Whether this provider can extract page content (the web_content tool). */
  extracts: boolean;
}

/**
 * A provider this build supports, served from the Go registry.
 *
 * Fetched rather than hardcoded here so that adding a provider is one change
 * in one place -- `internal/search.Specs`, next to the adapter itself. A
 * duplicate list in the frontend is a list that goes stale silently, which is
 * exactly how the picker kept offering DuckDuckGo and SearxNG after both
 * adapters were deleted.
 */
export interface SearchProviderSpec {
  kind: string;
  label: string;
  extracts: boolean;
  freeTier: string;
  docs: string;
}

export async function selectSearchProviders(): Promise<SearchProviderConfig[]> {
  return apiJson<SearchProviderConfig[]>(SEARCH_PROVIDERS_KEY, {
    method: "GET",
  });
}

export async function selectSearchCatalog(): Promise<SearchProviderSpec[]> {
  return apiJson<SearchProviderSpec[]>(SEARCH_CATALOG_KEY, { method: "GET" });
}

/**
 * Which provider currently answers web_search / web_content, and nothing
 * that identifies or authenticates it beyond that.
 *
 * Unlike every other function here, this one works for any signed-in user --
 * the server enforces that, not this client -- because "which engine
 * answered this search" is a fact about a message on screen, not a secret.
 * Used both by the composer's tools menu (so it can be checked before
 * sending) and by the web-search tool card (so a completed search can say
 * where its results came from).
 */
export interface ActiveSearchProvider {
  configured: boolean;
  provider?: string;
  label?: string;
  extracts?: boolean;
}

export async function selectActiveSearchProvider(): Promise<ActiveSearchProvider> {
  return apiJson<ActiveSearchProvider>(SEARCH_ACTIVE_KEY, { method: "GET" });
}

export async function saveSearchProvider(config: {
  id?: string;
  name: string;
  provider: string;
  /** Empty means "keep the stored key" on an update. */
  apiKey: string;
}): Promise<{ id: string }> {
  return apiJson<{ id: string }>(SEARCH_PROVIDERS_KEY, {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function deleteSearchProvider(id: string): Promise<void> {
  await apiJson(`${SEARCH_PROVIDERS_KEY}/${id}`, { method: "DELETE" });
}

export async function activateSearchProvider(id: string): Promise<void> {
  await apiJson(`${SEARCH_PROVIDERS_KEY}/${id}/activate`, { method: "POST" });
}

export interface SearchProviderTestResult {
  ok: boolean;
  provider: string;
  latencyMs: number;
  count: number;
  error?: string;
}

export async function testSearchProvider(
  id: string,
): Promise<SearchProviderTestResult> {
  return apiJson<SearchProviderTestResult>(
    `${SEARCH_PROVIDERS_KEY}/${id}/test`,
    { method: "POST" },
  );
}
