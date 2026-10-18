"use client";

import {
  Box,
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Hash,
  KeySquare,
  Link2,
  Loader2,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";

import {
  type CustomSearchConfig,
  DEFAULT_CUSTOM_SEARCH_CONFIG,
  SEARCH_ACTIVE_KEY,
  SEARCH_CATALOG_KEY,
  SEARCH_PROVIDERS_KEY,
  type SearchProviderConfig,
  type SearchProviderSpec,
  saveSearchProvider,
  selectSearchCatalog,
} from "@/lib/backend/search-provider-api";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { handleErrorWithToast } from "ui/shared-toast";
import { Textarea } from "ui/textarea";

export interface SearchProviderEditorProps {
  initialConfig?: SearchProviderConfig;
  templateProvider?: string;
}

/**
 * JSON schema for the custom payload inside POST /api/search/providers
 * when `provider === "custom"`. Mirrors Jcode's CustomWebSearchConfig
 * (jcode-config-types/src/web_search.rs) and docs/custom-web-search.md.
 *
 * Wire keys are snake_case; the frontend's CustomSearchConfig uses camelCase
 * and is converted via toWireCustom() in search-provider-api.ts. The backend
 * re-validates every field with the same rules as `validate_custom` in
 * runtime/crates/amiro-app-core/src/tool/websearch.rs:
 *   - endpoint: absolute http(s) URL, no userinfo or fragment, https preferred
 *   - method: "GET" (default) or "POST"
 *   - query_param: non-empty string, default "q"
 *   - count_param: null/"" (omit) or non-empty string != query_param
 *   - params: { [k: string]: string } static URL query params (both methods)
 *   - body: JSON object (default {}) — query/count injected as top-level keys for POST
 *   - headers: { [k: string]: string } static headers (marked sensitive)
 *   - header_env: { [headerName: string]: envVarName } — env var holds the
 *     complete value including `Bearer `, overrides headers, fails before fetch
 *     if missing/empty, never copied into diagnostics
 *   - results_pointer / title_pointer / url_pointer / snippet_pointer:
 *     RFC 6901 JSON Pointers ("" or "/" + "~0"/"~1" escapes). results_pointer
 *     must resolve to an array ("" = root array); item pointers are relative.
 *
 * ```json
 * {
 *   "id": "optional-uuid",
 *   "name": "Private SearXNG",
 *   "provider": "custom",
 *   "apiKey": "",
 *   "custom": {
 *     "endpoint": "https://search.example.org/api",
 *     "method": "GET",
 *     "query_param": "q",
 *     "count_param": "count",
 *     "params": { "format": "json" },
 *     "body": {},
 *     "headers": { "Accept": "application/json" },
 *     "header_env": { "Authorization": "SEARCH_AUTH" },
 *     "results_pointer": "/data/results",
 *     "title_pointer": "/title",
 *     "url_pointer": "/url",
 *     "snippet_pointer": "/snippet"
 *   }
 * }
 * ```
 *
 * Request mapping:
 *   GET  → params + query_param + count_param become URL query (URL-encoded,
 *          dynamic overrides static and same-named endpoint params)
 *   POST → body merged with query_param/count_param as top-level JSON keys;
 *          params still become URL query. 30s timeout, no redirects.
 *
 * Result mapping defaults: results_pointer "/results", title "/title",
 * url "/url", snippet "/snippet"; missing/blank URL skips the item, missing
 * title falls back to URL, missing snippet becomes "".
 */

/**
 * Create or edit one search provider.
 *
 * Hosted providers (brave / tavily / exa / serper) authenticate with a single
 * API key — one field. The `custom` provider is the search analogue of the
 * OpenAI-compatible custom AI provider in provider-editor.tsx: it exposes an
 * arbitrary HTTP JSON endpoint whose shape the user describes, rather than a
 * vendor SDK. The field layout mirrors that component deliberately:
 *   name → provider type dropdown → credentials / endpoint → provider-specific
 *   options. The custom section's groups (Endpoint & Method, Query Mapping,
 *   Headers & Auth, Body, Result Pointers) correspond 1:1 to
 *   CustomWebSearchConfig fields and to the validation in `validate_custom`.
 *
 * The provider list is fetched, never hardcoded — a second copy in the
 * frontend is a copy that goes stale silently.
 */

type KvRow = { k: string; v: string };

function kvFromRecord(rec: Record<string, string> | undefined): KvRow[] {
  if (!rec || Object.keys(rec).length === 0) return [];
  return Object.entries(rec).map(([k, v]) => ({ k, v }));
}

function kvToRecord(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { k, v } of rows) {
    const key = k.trim();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

function isValidPointer(p: string): boolean {
  if (p === "") return true;
  if (!p.startsWith("/")) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "~" && p[i + 1] !== "0" && p[i + 1] !== "1") return false;
    if (p[i] === "~") i++;
  }
  return true;
}

export default function SearchProviderEditor({
  initialConfig,
  templateProvider,
}: SearchProviderEditorProps) {
  const router = useRouter();
  const isNew = !initialConfig?.id;

  const {
    data: catalog = [],
    error: catalogError,
    isLoading: catalogLoading,
  } = useSWR<SearchProviderSpec[]>(SEARCH_CATALOG_KEY, selectSearchCatalog);

  const [isSaving, setIsSaving] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [name, setName] = useState(initialConfig?.name ?? "");
  const [requestedProviderType, setProviderType] = useState(
    initialConfig?.provider ?? templateProvider ?? "",
  );
  const providerType = requestedProviderType || catalog[0]?.kind || "";
  const selected = catalog.find((p) => p.kind === providerType);
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "");

  const isCustom = providerType === "custom";

  // Hosted key — always starts empty so "leave blank = keep" works.
  const [apiKey, setApiKey] = useState("");

  // Custom fields — seeded from saved config or defaults.
  const seeded: CustomSearchConfig = {
    ...DEFAULT_CUSTOM_SEARCH_CONFIG,
    ...(initialConfig?.custom ?? {}),
  };
  // Also hydrate from wire snake_case if the server returned that shape
  // (defensive: some sidecars serialize snake_case directly).
  const customWire = initialConfig?.custom as unknown as
    | Record<string, unknown>
    | undefined;
  if (customWire && !initialConfig?.custom?.endpoint) {
    const w = customWire as Record<string, string>;
    if (w["endpoint"] || w["query_param"] || w["results_pointer"]) {
      seeded.endpoint = String(
        (customWire as Record<string, unknown>)["endpoint"] ?? seeded.endpoint,
      );
    }
  }

  const [endpoint, setEndpoint] = useState(seeded.endpoint);
  const [method, setMethod] = useState<CustomSearchConfig["method"]>(
    seeded.method,
  );
  const [queryParam, setQueryParam] = useState(seeded.queryParam);
  const [countParam, setCountParam] = useState(seeded.countParam ?? "");
  const [paramsRows, setParamsRows] = useState<KvRow[]>(
    kvFromRecord(seeded.params),
  );
  const [headersRows, setHeadersRows] = useState<KvRow[]>(
    kvFromRecord(seeded.headers),
  );
  const [headerEnvRows, setHeaderEnvRows] = useState<KvRow[]>(
    kvFromRecord(seeded.headerEnv),
  );
  const [bodyText, setBodyText] = useState(() => {
    try {
      const b = seeded.body as Record<string, unknown>;
      if (!b || Object.keys(b).length === 0) return "{}";
      return JSON.stringify(b, null, 2);
    } catch {
      return "{}";
    }
  });
  const [resultsPointer, setResultsPointer] = useState(seeded.resultsPointer);
  const [titlePointer, setTitlePointer] = useState(seeded.titlePointer);
  const [urlPointer, setUrlPointer] = useState(seeded.urlPointer);
  const [snippetPointer, setSnippetPointer] = useState(seeded.snippetPointer);

  const handleSave = async () => {
    if (!selected) return toast.error("Choose a supported search provider");
    if (!name.trim()) return toast.error("Configuration name is required");

    if (!isCustom) {
      if (
        !selected.keyless &&
        !apiKey.trim() &&
        (isNew || !initialConfig?.configured)
      )
        return toast.error("An API key is required");
    } else {
      if (!endpoint.trim())
        return toast.error("Endpoint is required for custom search");
      try {
        const u = new URL(endpoint.trim());
        if (!["http:", "https:"].includes(u.protocol) || !u.hostname) {
          return toast.error("Endpoint must be an absolute HTTP(S) URL");
        }
        if (u.username || u.password) {
          return toast.error(
            "Endpoint must not contain userinfo — use Headers / Header Env for credentials",
          );
        }
        if (u.hash) return toast.error("Endpoint must not contain a fragment");
      } catch {
        return toast.error("Endpoint must be an absolute HTTP(S) URL");
      }
      if (!queryParam.trim())
        return toast.error("Query parameter name is required");
      const cp = countParam.trim();
      if (cp && cp === queryParam.trim()) {
        return toast.error(
          "Count parameter must be different from query parameter",
        );
      }
      for (const [label, ptr] of [
        ["Results pointer", resultsPointer],
        ["Title pointer", titlePointer],
        ["URL pointer", urlPointer],
        ["Snippet pointer", snippetPointer],
      ] as const) {
        if (!isValidPointer(ptr)) {
          return toast.error(
            `${label} must be "" or a valid JSON Pointer (RFC 6901)`,
          );
        }
      }
      let body: Record<string, unknown>;
      try {
        const parsed = bodyText.trim() ? JSON.parse(bodyText) : {};
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          return toast.error("Body must be a JSON object");
        }
        body = parsed as Record<string, unknown>;
      } catch (e) {
        return toast.error(`Body is not valid JSON: ${(e as Error).message}`);
      }
      // Persist the parsed body so the next open re-serializes canonically.
      void body;
    }

    setIsSaving(true);
    try {
      let custom: CustomSearchConfig | undefined;
      if (isCustom) {
        let body: Record<string, unknown> = {};
        try {
          body = bodyText.trim()
            ? (JSON.parse(bodyText) as Record<string, unknown>)
            : {};
        } catch {
          body = {};
        }
        const cp = countParam.trim();
        custom = {
          endpoint: endpoint.trim(),
          method,
          queryParam: queryParam.trim() || "q",
          countParam: cp ? cp : null,
          params: kvToRecord(paramsRows),
          body,
          headers: kvToRecord(headersRows),
          headerEnv: kvToRecord(headerEnvRows),
          resultsPointer: resultsPointer.trim() || "/results",
          titlePointer: titlePointer.trim() || "/title",
          urlPointer: urlPointer.trim() || "/url",
          snippetPointer: snippetPointer.trim() || "/snippet",
        };
      }

      await saveSearchProvider({
        id: initialConfig?.id,
        name: name.trim(),
        provider: providerType,
        apiKey: apiKey.trim(),
        baseUrl: selected.supportsApiBase
          ? baseUrl.trim() || selected.defaultApiBase
          : undefined,
        custom,
      });
      await mutate(SEARCH_PROVIDERS_KEY);
      await mutate(SEARCH_ACTIVE_KEY);
      toast.success("Search provider saved");
      router.push("/admin/search");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setIsSaving(false);
    }
  };

  const KvEditor = ({
    rows,
    setRows,
    keyPlaceholder,
    valuePlaceholder,
    "data-testid": testId,
  }: {
    rows: KvRow[];
    setRows: (r: KvRow[]) => void;
    keyPlaceholder: string;
    valuePlaceholder: string;
    "data-testid"?: string;
  }) => (
    <div className="space-y-2" data-testid={testId}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No entries yet.</p>
      ) : (
        rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={row.k}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], k: e.target.value };
                setRows(next);
              }}
              placeholder={keyPlaceholder}
              className="flex-1 bg-background/50 h-8 text-sm font-mono"
            />
            <Input
              value={row.v}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], v: e.target.value };
                setRows(next);
              }}
              placeholder={valuePlaceholder}
              className="flex-1 bg-background/50 h-8 text-sm font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
              aria-label="Remove entry"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1"
        onClick={() => setRows([...rows, { k: "", v: "" }])}
      >
        <Plus className="size-3" /> Add
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col space-y-8 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">
        Only configured providers are available to the agent. Set the default on
        the provider list. Other configured local providers are tried if the
        default fails. Model-native hosted search requires selection as default
        and a supported model, and is not an automatic HTTP fallback.
      </p>
      {catalogError && (
        <p role="alert">
          Search provider options could not be loaded. Try reloading this page.
        </p>
      )}
      {!catalogLoading && !catalogError && !selected && (
        <p role="alert">
          This search provider is not supported by the current backend. Choose a
          supported provider when creating a new configuration.
        </p>
      )}
      {/* Configuration name — identical to provider-editor.tsx */}
      <div className="space-y-2">
        <Label htmlFor="name" className="text-sm font-semibold">
          Configuration Name
        </Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Primary Search"
          className="max-w-md bg-background/50 shadow-sm"
          data-testid="search-provider-name-input"
        />
        <p className="text-xs text-muted-foreground">
          A human-readable name for this search configuration.
        </p>
      </div>

      {/* Provider type — mirrors provider-editor.tsx dropdown, with custom as the "OpenAI-compatible" analogue */}
      <div className="space-y-2">
        <Label className="text-sm font-semibold">Search Provider Engine</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full max-w-md justify-between bg-background/50 cursor-pointer"
              disabled={!isNew}
              data-testid="search-provider-type-trigger"
            >
              <div className="flex items-center gap-2">
                {isCustom ? (
                  <Globe className="size-4 text-primary" />
                ) : (
                  <Search className="size-4 text-primary" />
                )}
                <span>
                  {selected?.label ?? (providerType || "Loading providers...")}
                </span>
              </div>
              {isNew && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  Change
                  <ChevronDown className="size-3.5" />
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          {isNew && (
            <DropdownMenuContent className="w-[360px]">
              {catalog.map((p) => (
                <DropdownMenuItem
                  key={p.kind}
                  onClick={() => setProviderType(p.kind)}
                  className="cursor-pointer items-start gap-2 py-2"
                >
                  {p.kind === "custom" ? (
                    <Globe className="size-4 mt-0.5 text-primary shrink-0" />
                  ) : (
                    <Search className="size-4 mt-0.5 text-primary shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.freeTier}
                    </p>
                  </div>
                  {providerType === p.kind && (
                    <Check className="ml-auto mt-0.5 size-4 shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          )}
        </DropdownMenu>

        {isCustom ? (
          <p className="text-xs text-muted-foreground max-w-md">
            Any HTTP endpoint returning JSON. Configure how the query is sent
            and how results are extracted with JSON Pointers. See{" "}
            <a
              href="https://github.com/1jehuang/jcode/blob/main/docs/custom-web-search.md"
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline-offset-4 hover:underline"
            >
              docs/custom-web-search.md
            </a>{" "}
            for GET vs POST, header auth, and pointer semantics.
          </p>
        ) : (
          selected && (
            <div className="max-w-md space-y-1 pt-1">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="size-3.5 shrink-0" />
                {selected.extracts
                  ? "Can extract full page content, so the agent can read pages it finds."
                  : "Returns links and snippets only. The agent will fall back to fetching pages directly."}
              </p>
              <a
                href={selected.docs}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
              >
                {selected.keyless ? "Provider documentation" : "Get an API key"}
                <ExternalLink className="size-3" />
              </a>
            </div>
          )
        )}
      </div>

      {/* Hosted: single API key field (exactly like the non-custom path in provider-editor) */}
      {!isCustom && selected?.keyless && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="search-provider-keyless"
        >
          No API key required. {selected.freeTier}
        </p>
      )}
      {!isCustom && selected && !selected.keyless && (
        <div className="space-y-2 max-w-md">
          <Label
            htmlFor="api-key"
            className="flex items-center gap-2 font-medium"
          >
            <KeySquare className="w-4 h-4 text-primary" /> API Key
          </Label>
          <div className="relative">
            <Input
              id="api-key"
              type={revealKey ? "text" : "password"}
              placeholder={
                isNew ? "Enter API key" : "Leave blank to keep the saved key"
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="bg-background/50 shadow-sm pr-10"
              autoComplete="off"
              data-testid="search-provider-key-input"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 size-7 text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => setRevealKey((v) => !v)}
              aria-label={revealKey ? "Hide API key" : "Show API key"}
            >
              {revealKey ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
          </div>
          {!isNew && (
            <p className="text-xs text-muted-foreground">
              Saved keys are never sent back to the browser. Leave this blank to
              keep the current one, or type a new key to replace it.
            </p>
          )}
        </div>
      )}

      {!isCustom && selected?.supportsApiBase && (
        <div className="space-y-2 max-w-md">
          <Label htmlFor="search-base-url">API Base URL</Label>
          <Input
            id="search-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              selected.defaultApiBase ?? "https://search.example.org"
            }
            data-testid="search-provider-base-url-input"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to use the backend default, if available.
          </p>
        </div>
      )}

      {/* Custom: full CustomWebSearchConfig, endpoint required when custom */}
      {isCustom && (
        <div className="space-y-8 max-w-3xl">
          {/* Endpoint & Method — mirrors provider-editor's baseUrl field: required for custom, optional otherwise */}
          <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner">
            <div className="flex items-center gap-2">
              <Link2 className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">Endpoint &amp; Method</h3>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="custom-endpoint"
                className="text-sm font-medium flex items-center gap-2"
              >
                Endpoint{" "}
                <span className="text-muted-foreground font-normal">
                  required
                </span>
              </Label>
              <Input
                id="custom-endpoint"
                type="url"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://search.example.org/api"
                className="bg-background/50 shadow-sm font-mono text-sm"
                data-testid="search-custom-endpoint-input"
              />
              <p className="text-xs text-muted-foreground">
                Absolute HTTP(S) URL without userinfo or fragment. Prefer HTTPS.
                Static query params from the URL are preserved unless overridden
                by Params below.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Method</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between bg-background/50"
                      data-testid="search-custom-method-trigger"
                    >
                      <span className="font-mono text-sm">{method}</span>
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-[160px]">
                    <DropdownMenuItem
                      onClick={() => setMethod("GET")}
                      className="cursor-pointer"
                    >
                      GET
                      {method === "GET" && <Check className="ml-auto size-4" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setMethod("POST")}
                      className="cursor-pointer"
                    >
                      POST
                      {method === "POST" && (
                        <Check className="ml-auto size-4" />
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <p className="text-xs text-muted-foreground">
                  {method === "GET"
                    ? "Query and count become URL query params."
                    : "Query and count become top-level JSON keys in the request body."}
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Timeout &amp; redirects
                </Label>
                <p className="text-xs text-muted-foreground border rounded-md bg-muted/20 p-2.5">
                  30 s timeout. Never follows redirects — prevents credential
                  forwarding. Plain HTTP sends credentials unencrypted.
                </p>
              </div>
            </div>
          </div>

          {/* Query mapping — query_param / count_param / params */}
          <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner">
            <div className="flex items-center gap-2">
              <Hash className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">Query Mapping</h3>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="custom-query-param"
                  className="text-sm font-medium"
                >
                  Query param{" "}
                  <span className="text-muted-foreground font-normal">
                    default q
                  </span>
                </Label>
                <Input
                  id="custom-query-param"
                  value={queryParam}
                  onChange={(e) => setQueryParam(e.target.value)}
                  placeholder="q"
                  className="bg-background/50 font-mono text-sm"
                  data-testid="search-custom-query-param-input"
                />
                <p className="text-xs text-muted-foreground">
                  URL param (GET) or JSON key (POST) for the query.
                </p>
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="custom-count-param"
                  className="text-sm font-medium"
                >
                  Count param{" "}
                  <span className="text-muted-foreground font-normal">
                    optional
                  </span>
                </Label>
                <Input
                  id="custom-count-param"
                  value={countParam}
                  onChange={(e) => setCountParam(e.target.value)}
                  placeholder="count — leave empty to omit"
                  className="bg-background/50 font-mono text-sm"
                  data-testid="search-custom-count-param-input"
                />
                <p className="text-xs text-muted-foreground">
                  When set, must be non-empty and different from query param.
                  Results still capped to 20 locally.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <Settings2 className="size-3.5 text-primary" /> Static query
                params
              </Label>
              <KvEditor
                rows={paramsRows}
                setRows={setParamsRows}
                keyPlaceholder="key (e.g. format)"
                valuePlaceholder="value (e.g. json)"
                data-testid="search-custom-params-editor"
              />
              <p className="text-xs text-muted-foreground">
                Added to the URL for both GET and POST. Replace same-named
                endpoint params. Dynamic query/count override these.
              </p>
            </div>
          </div>

          {/* Headers & Auth — headers vs header_env, the custom analogue of provider-editor's apiKey field */}
          <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner">
            <div className="flex items-center gap-2">
              <KeySquare className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">
                Headers &amp; Authentication
              </h3>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">Static headers</Label>
              <KvEditor
                rows={headersRows}
                setRows={setHeadersRows}
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
                data-testid="search-custom-headers-editor"
              />
              <p className="text-xs text-muted-foreground">
                Sent as-is (values marked sensitive). Prefer Header Env for
                secrets.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Header env — header → environment variable
              </Label>
              <KvEditor
                rows={headerEnvRows}
                setRows={setHeaderEnvRows}
                keyPlaceholder="Authorization"
                valuePlaceholder="SEARCH_AUTH"
                data-testid="search-custom-header-env-editor"
              />
              <p className="text-xs text-muted-foreground">
                Maps header names to env var names holding the{" "}
                <span className="font-medium">complete</span> value (include{" "}
                <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                  Bearer{" "}
                </code>{" "}
                if needed). Overrides static headers. Missing/empty variables
                fail before fetch and are never logged.
              </p>
            </div>
          </div>

          {/* Body — POST only */}
          <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner">
            <div className="flex items-center gap-2">
              <Code2 className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">Body (POST)</h3>
              {method === "GET" && (
                <span className="text-xs text-muted-foreground">
                  (ignored for GET)
                </span>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-body" className="text-sm font-medium">
                Static JSON body
              </Label>
              <Textarea
                id="custom-body"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder={'{\n  "options": { "safe": true }\n}'}
                className="min-h-[96px] bg-background/50 font-mono text-sm"
                data-testid="search-custom-body-input"
              />
              <p className="text-xs text-muted-foreground">
                Must be a JSON object (default{" "}
                <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                  {"{}"}
                </code>
                ). Query and count are injected as top-level keys, overriding
                same-named body keys. Example: query_param{" "}
                <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                  search
                </code>{" "}
                with params{" "}
                <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                  {'{ version: "1" }'}
                </code>{" "}
                and body{" "}
                <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                  {"{ options: { safe: true } }"}
                </code>
                .
              </p>
            </div>
          </div>

          {/* Result mapping — RFC 6901 pointers */}
          <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner">
            <div className="flex items-center gap-2">
              <Box className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">
                Result Mapping — JSON Pointers (RFC 6901)
              </h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Escape{" "}
              <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                /
              </code>{" "}
              as{" "}
              <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                ~1
              </code>{" "}
              and{" "}
              <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                ~
              </code>{" "}
              as{" "}
              <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                ~0
              </code>
              . Blank URL skips the item; blank title falls back to URL; missing
              snippet becomes empty.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="custom-results-pointer"
                  className="text-sm font-medium"
                >
                  Results pointer{" "}
                  <span className="text-muted-foreground font-normal">
                    default /results
                  </span>
                </Label>
                <Input
                  id="custom-results-pointer"
                  value={resultsPointer}
                  onChange={(e) => setResultsPointer(e.target.value)}
                  placeholder="/results — use &quot;&quot; for root array"
                  className="bg-background/50 font-mono text-sm"
                  data-testid="search-custom-results-pointer-input"
                />
                <p className="text-xs text-muted-foreground">
                  Must resolve to an array.{" "}
                  <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                    ""
                  </code>{" "}
                  means the response root is the array.
                </p>
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="custom-url-pointer"
                  className="text-sm font-medium"
                >
                  URL pointer{" "}
                  <span className="text-muted-foreground font-normal">
                    default /url
                  </span>
                </Label>
                <Input
                  id="custom-url-pointer"
                  value={urlPointer}
                  onChange={(e) => setUrlPointer(e.target.value)}
                  placeholder="/url — e.g. /link/href"
                  className="bg-background/50 font-mono text-sm"
                  data-testid="search-custom-url-pointer-input"
                />
                <p className="text-xs text-muted-foreground">
                  Relative to each result item. Missing/blank/non-string skips
                  the item.
                </p>
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="custom-title-pointer"
                  className="text-sm font-medium"
                >
                  Title pointer{" "}
                  <span className="text-muted-foreground font-normal">
                    default /title
                  </span>
                </Label>
                <Input
                  id="custom-title-pointer"
                  value={titlePointer}
                  onChange={(e) => setTitlePointer(e.target.value)}
                  placeholder="/title"
                  className="bg-background/50 font-mono text-sm"
                  data-testid="search-custom-title-pointer-input"
                />
                <p className="text-xs text-muted-foreground">
                  Relative to each item. Falls back to URL when missing/blank.
                </p>
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="custom-snippet-pointer"
                  className="text-sm font-medium"
                >
                  Snippet pointer{" "}
                  <span className="text-muted-foreground font-normal">
                    default /snippet
                  </span>
                </Label>
                <Input
                  id="custom-snippet-pointer"
                  value={snippetPointer}
                  onChange={(e) => setSnippetPointer(e.target.value)}
                  placeholder="/snippet"
                  className="bg-background/50 font-mono text-sm"
                  data-testid="search-custom-snippet-pointer-input"
                />
                <p className="text-xs text-muted-foreground">
                  Relative to each item. Missing/non-string becomes empty.
                </p>
              </div>
            </div>

            <div className="rounded-md bg-muted/20 border p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Example</p>
              <p>
                Response{" "}
                <code className="px-1 py-0.5 bg-background rounded text-[11px]">
                  {
                    '{ "data": { "hits": [{ "link": { "href": "https://…" }, "name": "…" }] } }'
                  }
                </code>
              </p>
              <p>
                → results{" "}
                <code className="px-1 py-0.5 bg-background rounded text-[11px]">
                  /data/hits
                </code>
                , url{" "}
                <code className="px-1 py-0.5 bg-background rounded text-[11px]">
                  /link/href
                </code>
                , title{" "}
                <code className="px-1 py-0.5 bg-background rounded text-[11px]">
                  /name
                </code>
                . Nested paths and escaped tokens like{" "}
                <code className="px-1 py-0.5 bg-background rounded text-[11px]">
                  /a~1b/~0title
                </code>{" "}
                are supported.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3 border-t pt-6">
        <Button
          variant="ghost"
          onClick={() => router.push("/admin/search")}
          className="font-semibold cursor-pointer"
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={isSaving || !name.trim() || catalogLoading || !selected}
          className="min-w-[120px] font-bold shadow-md cursor-pointer"
          data-testid="search-provider-save-button"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
