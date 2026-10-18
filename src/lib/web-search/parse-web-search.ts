/**
 * Parsing for the runtime's `websearch` and `webfetch` tool outputs.
 *
 * The two tools answer in deliberately different shapes and neither is
 * structured JSON in the common case:
 *
 *   websearch  -- the Rust runtime formats search hits as markdown prose
 *                 (a provider header, a query header, then numbered
 *                 `**Title**` / URL / snippet blocks). The Go webSearch
 *                 toolkit, by contrast, returns `{ provider, results }`.
 *   webfetch   -- a `Fetched <url> (<N> bytes)` header followed by the
 *                 extracted page body.
 *
 * A chat card that renders either as a `<pre>` dump forces the reader to
 * decode a page of text to find the one link they wanted. This module turns
 * both shapes -- plus the JSON one -- into the small set of fields a card
 * actually draws: title, link, host, favicon and snippet.
 *
 * Deliberately zero-dependency (no URL/markdown library) so it can run in a
 * presenter without pulling anything into the chat bundle.
 */

import { parseToolTiming } from "lib/ai/tools/timing";

export interface ParsedWebSearchHit {
  /** 1-based, reassigned after de-duplication so ranks are always dense. */
  rank: number;
  title: string;
  url: string;
  domain: string;
  faviconUrl: string;
  snippet?: string;
}

export interface ParsedWebSearchOutput {
  query?: string;
  provider?: string;
  providerId?: string;
  fallbackAfter?: string;
  hits: ParsedWebSearchHit[];
  noResults: boolean;
  errorText?: string;
  rawText: string;
}

export interface ParsedWebFetchOutput {
  url: string;
  domain: string;
  faviconUrl: string;
  title?: string;
  byteCount?: number;
  status?: string;
  content: string;
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

const URL_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTTP_URL = /^https?:\/\/[^\s<>"']+$/i;
/** A bare host (+ optional path/query), e.g. `example.com/a?b=1`. */
const BARE_HOST = /^[\w-]+(?:\.[\w-]+)+(?:[/?#][^\s]*)?$/;

/**
 * The only URLs a card may turn into an `<a href>`. Tool output is
 * untrusted page content, so a `javascript:` or `data:` URL must never
 * become a clickable link.
 */
export function isSafeHttpUrl(url: unknown): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

/** Hostname of a URL with a leading `www.` stripped, or `""` when invalid. */
export function extractDomain(url: string): string {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  // `new URL` needs a scheme; the runtime always emits one, but a hit copied
  // out of prose may not, so retry with https:// before giving up.
  const candidates = URL_WITH_SCHEME.test(trimmed)
    ? [trimmed]
    : [trimmed, `https://${trimmed}`];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname;
      // A single label ("nonsense", a stray word) is not a site; only a
      // dotted host or localhost is worth a favicon request or a domain pill.
      if (host && (host.includes(".") || host === "localhost")) {
        return host.replace(/^www\./i, "");
      }
      return "";
    } catch {
      // try the next candidate
    }
  }
  return "";
}

function faviconUrlForDomain(domain: string): string {
  if (!domain) return "";
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

/** A Google-hosted favicon for a URL, or `""` when the URL has no host. */
export function faviconUrlFor(url: string): string {
  return faviconUrlForDomain(extractDomain(url));
}

function normalizeUrl(raw: string): string {
  let value = raw.trim().replace(/^<|>$/g, "");
  // Trailing punctuation picked up from prose ("see https://x.com.").
  value = value.replace(/[),.;:]+$/g, "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  if (BARE_HOST.test(value)) return `https://${value}`;
  return "";
}

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  return HTTP_URL.test(trimmed) || BARE_HOST.test(trimmed);
}

/* ------------------------------------------------------------------ */
/* Small text helpers                                                  */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function cleanTitle(raw: string | undefined): string {
  if (!raw) return "";
  let value = raw.trim();
  value = value.replace(/^\*\*([\s\S]+?)\*\*\s*$/, "$1").trim();
  value = value
    .replace(/^["'“”]+/, "")
    .replace(/["'“”]+$/, "")
    .trim();
  return value.replace(/\s+/g, " ");
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/* ------------------------------------------------------------------ */
/* websearch                                                           */
/* ------------------------------------------------------------------ */

interface RawHitRecord {
  rank?: number;
  title?: string;
  url?: string;
  snippetLines: string[];
}

function finalizeHits(records: RawHitRecord[]): ParsedWebSearchHit[] {
  const hits: ParsedWebSearchHit[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.url) continue;
    const url = normalizeUrl(record.url);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const domain = extractDomain(url);
    const title = cleanTitle(record.title);
    const snippet = record.snippetLines.join(" ").replace(/\s+/g, " ").trim();
    hits.push({
      rank: hits.length + 1,
      title: title || domain || url,
      url,
      domain,
      faviconUrl: faviconUrlFor(url),
      snippet: snippet || undefined,
    });
  }
  return hits;
}

function toRawHitRecord(item: unknown): RawHitRecord {
  if (typeof item === "string") return { url: item, snippetLines: [] };
  const record = asRecord(item);
  if (!record) return { snippetLines: [] };
  const url = firstString(record.url, record.link, record.href, record.source);
  const title = firstString(record.title, record.name, record.heading);
  const snippet = firstString(
    record.snippet,
    record.text,
    record.description,
    record.content,
  );
  return { url, title, snippetLines: snippet ? [snippet] : [] };
}

function errorTextFromRecord(
  record: Record<string, unknown>,
): string | undefined {
  const error = firstString(record.error, record.message);
  if (!error && record.isError !== true) return undefined;
  const solution = firstString(record.solution, record.hint);
  return [error ?? "Web search failed", solution].filter(Boolean).join("\n");
}

/** Parse a line that follows a `1. ` / `[1] ` marker. */
function applyHitLine(record: RawHitRecord, rest: string): void {
  const value = rest.trim();
  if (!value) return;
  const bold = value.match(/^\*\*([\s\S]+?)\*\*\s*$/);
  if (bold) {
    record.title = cleanTitle(bold[1]);
    return;
  }
  const labeled = value.match(/^URL:\s*(.+)$/i);
  if (labeled) {
    record.url = labeled[1].trim();
    return;
  }
  if (looksLikeUrl(value)) {
    record.url = value;
    return;
  }
  record.title = cleanTitle(value);
}

function parseWebSearchText(
  text: string,
  inputQuery?: string,
): Partial<ParsedWebSearchOutput> {
  const records: RawHitRecord[] = [];
  let current: RawHitRecord | null = null;
  let sawNumbered = false;
  let provider: string | undefined;
  let providerId: string | undefined;
  let fallbackAfter: string | undefined;
  let query = inputQuery;
  let noResults = false;

  const pushCurrent = () => {
    if (current) {
      records.push(current);
      current = null;
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      // A blank line closes a record once it has a link and a snippet; in the
      // numbered format it just separates entries, which the next marker
      // re-opens anyway.
      if (current && current.url && current.snippetLines.length) pushCurrent();
      continue;
    }

    const providerMatch = trimmed.match(
      /^Search provider:\s*(.+?)\s*(?:\(([^)]+)\))?\s*$/i,
    );
    if (providerMatch) {
      provider = providerMatch[1].trim();
      if (providerMatch[2]) providerId = providerMatch[2].trim();
      continue;
    }

    const queryMatch = trimmed.match(/^Search results for:\s*(.+)$/i);
    if (queryMatch) {
      query = cleanTitle(queryMatch[1]);
      continue;
    }

    const fallbackMatch = trimmed.match(/^Fallback after:\s*(.+)$/i);
    if (fallbackMatch) {
      fallbackAfter = fallbackMatch[1].trim();
      continue;
    }

    const noResultsMatch = trimmed.match(
      /^No results found(?:\s+for)?:?\s*(.*)$/i,
    );
    if (noResultsMatch) {
      noResults = true;
      const q = cleanTitle(noResultsMatch[1])
        .replace(/[.:;]+$/, "")
        .trim();
      if (q) query = q;
      continue;
    }

    const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    const citationMatch = trimmed.match(/^\[(\d+)\]\s*(.*)$/);
    if (numberedMatch || citationMatch) {
      sawNumbered = true;
      const match = (numberedMatch ?? citationMatch)!;
      const rank = Number.parseInt(match[1], 10);
      pushCurrent();
      current = {
        rank: Number.isFinite(rank) ? rank : undefined,
        snippetLines: [],
      };
      applyHitLine(current, match[2]);
      continue;
    }

    const labeledUrl = trimmed.match(/^URL:\s*(\S.*)$/i);
    if (labeledUrl) {
      if (!current) current = { snippetLines: [] };
      current.url = labeledUrl[1].trim();
      continue;
    }

    if (looksLikeUrl(trimmed)) {
      if (!current) current = { snippetLines: [] };
      if (!current.url) {
        current.url = trimmed;
      } else if (!sawNumbered) {
        // Bare URL without a preceding marker: it belongs to the next
        // title/link pair, so close the record it cannot belong to.
        pushCurrent();
        current = { snippetLines: [], url: trimmed };
      } else {
        current.snippetLines.push(trimmed);
      }
      continue;
    }

    const value = cleanTitle(trimmed);
    if (!value) continue;
    if (!current) {
      current = { snippetLines: [], title: value };
      continue;
    }
    if (!current.title && !current.url) {
      current.title = value;
      continue;
    }
    if (!sawNumbered && current.url) {
      // `Title\nhttps://...` pairs: a text line after a link is a new title.
      pushCurrent();
      current = { snippetLines: [], title: value };
      continue;
    }
    if (!current.title) {
      current.title = value;
      continue;
    }
    current.snippetLines.push(value);
  }
  pushCurrent();

  return {
    query,
    provider,
    providerId,
    fallbackAfter,
    noResults,
    hits: noResults ? [] : finalizeHits(records),
  };
}

export function parseWebSearchOutput(
  output: unknown,
  inputQuery?: string,
): ParsedWebSearchOutput {
  const timing = parseToolTiming(output);
  const rawText = timing.cleanText ?? "";
  const query = inputQuery?.trim() || undefined;

  const record = asRecord(output);
  if (record) {
    const results = Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.pages)
        ? record.pages
        : null;
    if (results) {
      const parsedQuery = firstString(record.query);
      return {
        query: parsedQuery ?? query,
        provider: firstString(record.provider),
        hits: finalizeHits(results.map(toRawHitRecord)),
        noResults: results.length === 0,
        rawText,
      };
    }
    const errorText = errorTextFromRecord(record);
    if (errorText) {
      return {
        query: query ?? firstString(record.query),
        hits: [],
        noResults: false,
        errorText,
        rawText,
      };
    }
  }

  const text = parseWebSearchText(rawText, query);
  return {
    rawText,
    query: text.query,
    provider: text.provider,
    providerId: text.providerId,
    fallbackAfter: text.fallbackAfter,
    hits: text.hits ?? [],
    noResults: text.noResults ?? false,
    errorText: text.errorText,
  };
}

/* ------------------------------------------------------------------ */
/* webfetch                                                            */
/* ------------------------------------------------------------------ */

function cleanContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromContent(content: string): string | undefined {
  if (!content) return undefined;
  const heading = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (heading) return cleanTitle(heading[1]);
  const htmlTitle = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (htmlTitle) return cleanTitle(decodeBasicEntities(htmlTitle[1]));
  return undefined;
}

function parseWebFetchText(text: string): {
  url?: string;
  title?: string;
  byteCount?: number;
  status?: string;
  content: string;
} {
  let rest = text;
  let url: string | undefined;
  let byteCount: number | undefined;
  let status: string | undefined;
  let title: string | undefined;

  const fetched = rest.match(/^Fetched\s+(\S+)\s+\((\d+)\s+bytes?\)\s*/i);
  if (fetched) {
    url = fetched[1];
    byteCount = Number.parseInt(fetched[2], 10);
    rest = rest.slice(fetched[0].length);
  }

  const contentLines: string[] = [];
  let inContent = false;
  for (const line of rest.split(/\r?\n/)) {
    if (!inContent) {
      const finalUrl = line.match(/^Final URL:\s*(\S+)\s*$/i);
      if (finalUrl) {
        url = finalUrl[1];
        continue;
      }
      const statusMatch = line.match(/^Status:\s*(.+)$/i);
      if (statusMatch) {
        status = statusMatch[1].trim();
        continue;
      }
      const titleMatch = line.match(/^Title:\s*(.+)$/i);
      if (titleMatch) {
        title = cleanTitle(titleMatch[1]);
        continue;
      }
      const bytesMatch = line.match(/^Bytes:\s*(\d+)\s*$/i);
      if (bytesMatch) {
        byteCount = Number.parseInt(bytesMatch[1], 10);
        continue;
      }
      const contentMatch = line.match(/^Content:\s*(.*)$/i);
      if (contentMatch) {
        inContent = true;
        if (contentMatch[1]) contentLines.push(contentMatch[1]);
        continue;
      }
    }
    contentLines.push(line);
  }

  return { url, title, byteCount, status, content: contentLines.join("\n") };
}

export function parseWebFetchOutput(
  output: unknown,
  inputUrl?: string,
): ParsedWebFetchOutput {
  const timing = parseToolTiming(output);
  const rawText = timing.cleanText ?? "";
  let url = inputUrl?.trim() ?? "";
  let title: string | undefined;
  let byteCount: number | undefined;
  let status: string | undefined;
  let content = "";

  const record = asRecord(output);
  if (record) {
    const page = Array.isArray(record.pages)
      ? asRecord(record.pages[0])
      : undefined;
    const target = page ?? record;
    url = firstString(target.url, record.url, url) ?? url;
    title = firstString(target.title, record.title);
    content =
      firstString(target.text, target.content, target.markdown, target.body) ??
      "";
  } else {
    const parsed = parseWebFetchText(rawText);
    if (parsed.url) url = parsed.url;
    title = parsed.title;
    byteCount = parsed.byteCount;
    status = parsed.status;
    content = parsed.content;
  }

  if (!title) title = titleFromContent(content);

  const domain = extractDomain(url) || extractDomain(inputUrl ?? "");

  return {
    url,
    domain,
    faviconUrl: faviconUrlForDomain(domain),
    title,
    byteCount,
    status,
    content: cleanContent(content),
  };
}
