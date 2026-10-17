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
 *
 * For `provider === "custom"` the same round-trip rule applies to headers:
 * `headerEnv` values are env-var names, not secrets, so they are stored in
 * clear and may be returned; actual header values resolved from
 * `headerEnv` / `headers` are never returned — only masked hints where
 * applicable.
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
  baseUrl?: string;
  /** Present only when provider === "custom". Mirrors Jcode's CustomWebSearchConfig. */
  custom?: CustomSearchConfig;
}

/**
 * A provider this build supports, served from the search catalog.
 *
 * Fetched rather than hardcoded here so that adding a provider is one change
 * in one place -- `search_catalog()` in `backend/src/routes/search_providers.rs`
 * (mirrored by `CATALOG` in `adapter/src/routes/search-providers.mjs`).
 */
export interface SearchProviderSpec {
  kind: string;
  label: string;
  extracts: boolean;
  freeTier: string;
  docs: string;
  supportsApiBase?: boolean;
  defaultApiBase?: string;
  keyless?: boolean;
  supportsCustomConfig?: boolean;
}

// ---------------------------------------------------------------------------
// Custom HTTP JSON search — mirrors Jcode docs/custom-web-search.md and
// jcode-config-types/src/web_search.rs CustomWebSearchConfig /
// CustomWebSearchMethod. Wire keys are camelCase in this frontend API and
// mapped to snake_case (endpoint, query_param, header_env, results_pointer,
// ...) when persisted to the sidecar / Rust config layer. See
// runtime/crates/amiro-app-core/src/tool/websearch.rs `validate_custom` /
// `custom_request` / `parse_custom_results` for the exact validation that the
// backend will re-apply on save and at search time.
// ---------------------------------------------------------------------------

/** HTTP method for a custom endpoint. Only GET and POST are supported. */
export type CustomSearchMethod = "GET" | "POST";

/**
 * Configurable HTTP JSON search. Pointers use RFC 6901 JSON Pointer syntax:
 * escape `/` as `~1` and `~` as `~0`. `resultsPointer` must resolve to an
 * array (use `""` for a root array); item pointers are relative to each
 * array entry. See docs/custom-web-search.md for GET vs POST, auth, and
 * pointer semantics.
 */
export interface CustomSearchConfig {
  /** Absolute HTTP(S) URL without userinfo or fragment. Prefer HTTPS. */
  endpoint: string;
  /** GET (default) or POST. */
  method: CustomSearchMethod;
  /** URL param name (GET) or top-level JSON key (POST) for the query. Default "q". */
  queryParam: string;
  /**
   * Optional count key. Omit / null / "" = do not send count. When present
   * must be nonempty and different from queryParam. Results are still capped
   * locally by num_results (tool default 8, max 20).
   */
  countParam?: string | null;
  /** Static URL query parameters for either method. Replace same-named endpoint params. */
  params: Record<string, string>;
  /** Static JSON object merged with query/count for POST. Default {}. Must be an object. */
  body: Record<string, unknown>;
  /** Static header values. Prefer headerEnv for secrets. Values are marked sensitive. */
  headers: Record<string, string>;
  /**
   * Header name -> environment variable name containing the complete header
   * value (including `Bearer ` if required). Overrides `headers`
   * case-insensitively. Missing/empty/invalid variables fail before network
   * access. Never copy secrets into diagnostics.
   */
  headerEnv: Record<string, string>;
  /** JSON Pointer to the results array. Default "/results". "" = root is the array. */
  resultsPointer: string;
  /** Pointer relative to each result item for the title. Default "/title". */
  titlePointer: string;
  /** Pointer relative to each result item for the URL. Default "/url". */
  urlPointer: string;
  /** Pointer relative to each result item for the snippet. Default "/snippet". */
  snippetPointer: string;
}

/** Defaults aligned with jcode-config-types CustomWebSearchConfig::default(). */
export const DEFAULT_CUSTOM_SEARCH_CONFIG: CustomSearchConfig = {
  endpoint: "",
  method: "GET",
  queryParam: "q",
  countParam: null,
  params: {},
  body: {},
  headers: {},
  headerEnv: {},
  resultsPointer: "/results",
  titlePointer: "/title",
  urlPointer: "/url",
  snippetPointer: "/snippet",
};

/**
 * JSON Schema (informal) for the custom payload inside POST /api/search/providers
 * when provider === "custom". The backend validates the same rules as
 * `validate_custom` in Rust: endpoint absolute http(s) no userinfo/fragment,
 * queryParam non-empty, countParam if set != queryParam, body is object,
 * pointers are "" or "/"-prefixed valid RFC 6901.
 *
 * Example:
 * {
 *   "id": "optional-uuid",
 *   "name": "Private SearXNG",
 *   "provider": "custom",
 *   "apiKey": "",            // ignored for custom
 *   "custom": {
 *     "endpoint": "https://search.example.org/api",
 *     "method": "GET",
 *     "queryParam": "q",
 *     "countParam": "count",
 *     "params": { "format": "json" },
 *     "body": {},
 *     "headers": { "Accept": "application/json" },
 *     "headerEnv": { "Authorization": "SEARCH_AUTH" },
 *     "resultsPointer": "/data/results",
 *     "titlePointer": "/title",
 *     "urlPointer": "/url",
 *     "snippetPointer": "/snippet"
 *   }
 * }
 */
export type CustomSearchConfigWire = {
  endpoint: string;
  method: CustomSearchMethod;
  query_param: string;
  count_param?: string | null;
  params: Record<string, string>;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  header_env: Record<string, string>;
  results_pointer: string;
  title_pointer: string;
  url_pointer: string;
  snippet_pointer: string;
};

export function toWireCustom(c: CustomSearchConfig): CustomSearchConfigWire {
  return {
    endpoint: c.endpoint,
    method: c.method,
    query_param: c.queryParam,
    count_param: c.countParam ?? null,
    params: c.params,
    body: c.body,
    headers: c.headers,
    header_env: c.headerEnv,
    results_pointer: c.resultsPointer,
    title_pointer: c.titlePointer,
    url_pointer: c.urlPointer,
    snippet_pointer: c.snippetPointer,
  };
}

export function fromWireCustom(w: Partial<CustomSearchConfigWire>): CustomSearchConfig {
  return {
    endpoint: String(w.endpoint ?? ""),
    method: (String(w.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET"),
    queryParam: String(w.query_param ?? "q"),
    countParam: w.count_param === undefined ? null : (w.count_param as string | null),
    params: (w.params as Record<string, string>) ?? {},
    body: (w.body as Record<string, unknown>) ?? {},
    headers: (w.headers as Record<string, string>) ?? {},
    headerEnv: (w.header_env as Record<string, string>) ?? {},
    resultsPointer: String(w.results_pointer ?? "/results"),
    titlePointer: String(w.title_pointer ?? "/title"),
    urlPointer: String(w.url_pointer ?? "/url"),
    snippetPointer: String(w.snippet_pointer ?? "/snippet"),
  };
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

export interface SearchProviderSaveInput {
  id?: string;
  name: string;
  provider: string;
  /** Empty means "keep the stored key" on an update. Ignored when provider === "custom". */
  apiKey: string;
  baseUrl?: string;
  /** Required when provider === "custom"; ignored otherwise. */
  custom?: CustomSearchConfig;
}

export async function saveSearchProvider(config: SearchProviderSaveInput): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    id: config.id,
    name: config.name,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  // Keep wire compatible with existing hosted providers (no custom key) while
  // carrying the full Jcode custom payload when needed — both adapter and
  // Rust backend treat `custom` as optional and ignore it for non-custom kinds.
  if (config.provider === "custom" && config.custom) {
    body.custom = toWireCustom(config.custom);
  }
  return apiJson<{ id: string }>(SEARCH_PROVIDERS_KEY, {
    method: "POST",
    body: JSON.stringify(body),
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
