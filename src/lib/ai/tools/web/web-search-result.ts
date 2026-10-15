/**
 * The wire shapes web_search and web_content actually return.
 *
 * Deliberately not `ExaSearchResponse`/`ExaSearchResult` from ./web-search --
 * those describe Exa's own raw API response. The chat agent's tools go through
 * the multi-provider abstraction in the Go backend's internal/search package
 * instead (internal/ai/tools/web_search.go), which normalizes every provider --
 * Brave, Tavily, Exa, Serper -- to one shape and reports which one answered.
 * A card rendering agent tool calls has to match that shape, not Exa's.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  provider: string;
  results: SearchHit[];
  guide?: string;
}

export interface ExtractedPage {
  url: string;
  title?: string;
  text: string;
  author?: string;
  publishedDate?: string;
}

export interface WebContentResult {
  provider: string;
  pages: ExtractedPage[];
}

/**
 * A controlled failure, returned as a *successful* tool call so the model
 * can read it and explain it to the user -- see webToolError in the Go
 * backend. This is not `part.errorText`: that field is for a protocol-level
 * failure (the call itself never completed), while this is the tool
 * completing and reporting that nothing came of it.
 */
export interface WebToolError {
  isError: true;
  error: string;
  solution: string;
}

export type WebSearchToolOutput = WebSearchResult | WebToolError;
export type WebContentToolOutput = WebContentResult | WebToolError;

export function isWebToolError(output: unknown): output is WebToolError {
  return Boolean(
    output &&
      typeof output === "object" &&
      (output as { isError?: unknown }).isError === true,
  );
}
