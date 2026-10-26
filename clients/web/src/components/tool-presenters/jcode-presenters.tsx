"use client";

import { cn } from "lib/utils";
import {
  CalendarIcon,
  ChevronDownIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  InboxIcon,
  LayoutIcon,
  Link2Icon,
  MonitorIcon,
  SearchIcon,
  ServerIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { parseToolTiming } from "lib/ai/tools/timing";
import {
  type ParsedWebSearchHit,
  extractDomain,
  faviconUrlFor,
  isSafeHttpUrl,
  parseWebFetchOutput,
  parseWebSearchOutput,
} from "lib/web-search/parse-web-search";
import { VisualPlaceholder, VisualSurface } from "../visual/visual-surface";
import type { PresenterProps, ToolPresenter, ToolRunStatus } from "./types";

/* ------------------------------------------------------------------ */
/* Web: websearch, webfetch, browser                                  */
/* ------------------------------------------------------------------ */

/**
 * Pretty names for the provider ids the runtime reports.
 *
 * The header prints the id verbatim for a configured provider ("bing") and a
 * label for the local engines, so a card that showed the raw id would read
 * "bing" next to "DuckDuckGo". Unknown ids pass through unchanged rather
 * than being hidden.
 */
const PROVIDER_LABELS: Record<string, string> = {
  bing: "Bing Search",
  bing_search: "Bing Search",
  duckduckgo: "DuckDuckGo",
  ddg: "DuckDuckGo",
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave Search",
  serper: "Serper",
  searxng: "SearXNG",
  native: "Provider Native",
  provider_native: "Provider Native",
  providernative: "Provider Native",
  vellum: "Vellum",
};

function providerLabelFor(provider?: string): string | undefined {
  const value = provider?.trim();
  if (!value) return undefined;
  return PROVIDER_LABELS[value.toLowerCase()] ?? value;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A favicon that degrades to the site's initial.
 *
 * Google's favicon service 404s or is blocked often enough that an `<img>`
 * with no fallback leaves a row of broken-image glyphs; the monogram keeps
 * every row scannable either way.
 */
export function SiteFavicon({ url, className }: { url?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const favicon = url ? faviconUrlFor(url) : "";
  const domain = url ? extractDomain(url) : "";
  if (!favicon || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-sm bg-muted text-[9px] font-semibold uppercase text-muted-foreground",
          className,
        )}
      >
        {(domain || "?").charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={favicon}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn("shrink-0 rounded-sm object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * One source, as the small pill that sits in the chips strip.
 *
 * Only an http(s) URL becomes a link -- the href comes from fetched page
 * content, not from the agent, so a `javascript:` URL must stay inert.
 */
export function WebSearchSourceChip({
  hit,
  testId = "websearch-source-chip",
}: {
  hit: ParsedWebSearchHit;
  testId?: string;
}) {
  const className =
    "inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-[11px] transition-colors hover:border-primary/40 hover:bg-muted";
  const body = (
    <>
      <SiteFavicon url={hit.url} className="size-3.5" />
      <span className="max-w-[9rem] truncate font-medium">
        {hit.domain || hit.title}
      </span>
      {hit.domain && hit.title && hit.title !== hit.domain ? (
        <span className="hidden max-w-[12rem] truncate text-muted-foreground sm:inline">
          {hit.title}
        </span>
      ) : null}
    </>
  );
  if (!isSafeHttpUrl(hit.url)) {
    return (
      <span data-testid={testId} className={className}>
        {body}
      </span>
    );
  }
  return (
    <a
      data-testid={testId}
      href={hit.url}
      target="_blank"
      rel="noopener noreferrer"
      title={hit.title}
      className={className}
    >
      {body}
    </a>
  );
}

/** One result: favicon and title, then host and snippet, rank on the left. */
function WebSearchResultRow({ hit }: { hit: ParsedWebSearchHit }) {
  const className =
    "group/wsrow flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50";
  const body = (
    <>
      <span className="w-4 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
        {hit.rank}
      </span>
      <SiteFavicon url={hit.url} className="mt-0.5 size-4" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-foreground group-hover/wsrow:underline group-hover/wsrow:underline-offset-2">
            {hit.title}
          </span>
          <ExternalLinkIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/wsrow:opacity-60" />
        </span>
        {hit.domain ? (
          <span className="truncate text-[11px] text-muted-foreground">{hit.domain}</span>
        ) : null}
        {hit.snippet ? (
          <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {hit.snippet}
          </span>
        ) : null}
      </span>
    </>
  );
  if (!isSafeHttpUrl(hit.url)) {
    return (
      <div data-testid="websearch-result-row" className={className}>
        {body}
      </div>
    );
  }
  return (
    <a
      data-testid="websearch-result-row"
      href={hit.url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {body}
    </a>
  );
}

/** Placeholder rows while a search runs: the card's shape, not a spinner. */
function ResultSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded-sm bg-muted" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span
              className="h-3 animate-pulse rounded bg-muted"
              style={{ width: `${70 - i * 12}%`, animationDelay: `${i * 120}ms` }}
            />
            <span
              className="h-2.5 w-11/12 animate-pulse rounded bg-muted/70"
              style={{ animationDelay: `${i * 120 + 60}ms` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

export interface WebSearchResultCardProps {
  query?: string;
  provider?: string;
  hits: ParsedWebSearchHit[];
  duration?: string;
  runStatus?: ToolRunStatus;
  errorText?: string;
  pending?: boolean;
  noResults?: boolean;
  rawText?: string;
  intent?: string;
  className?: string;
}

/**
 * The full web-search card: the query as its title, a quiet meta line
 * (provider, count, time), then the results as a ranked list with the raw
 * output kept behind an escape hatch.
 */
export function WebSearchResultCard({
  query,
  provider,
  hits,
  duration,
  runStatus = "success",
  errorText,
  pending = false,
  noResults = false,
  rawText,
  intent,
  className,
}: WebSearchResultCardProps) {
  const [showAll, setShowAll] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const providerLabel = providerLabelFor(provider);
  const isError = runStatus === "error" || Boolean(errorText);
  const clean = (rawText ?? "").trim();
  const visibleHits = showAll ? hits : hits.slice(0, 4);
  const hiddenCount = Math.max(0, hits.length - 4);

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-card text-xs",
        isError && "border-destructive/50",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium" title={query}>
          {query ? `“${query}”` : "Web search"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pb-2 pl-[2.1rem] text-[11px] text-muted-foreground">
        <span>Web search</span>
        {providerLabel ? <span>{providerLabel}</span> : null}
        {!pending && !isError ? (
          <span>
            {hits.length} {hits.length === 1 ? "source" : "sources"}
          </span>
        ) : null}
        {duration ? <span className="ml-auto font-mono tabular-nums">{duration}</span> : null}
      </div>

      {intent ? (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">{intent}</div>
      ) : null}

      {pending ? (
        <div className="border-t py-1.5" data-testid="websearch-pending">
          <div className="flex items-center gap-2 px-3 pb-1 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50" />
              <span className="relative inline-flex size-2 rounded-full bg-primary/70" />
            </span>
            <span className="animate-pulse">
              Searching the web{query ? ` for “${query}”` : ""}…
            </span>
          </div>
          <ResultSkeleton />
        </div>
      ) : isError ? (
        <div className="border-t px-3 py-3">
          <div
            data-testid="websearch-error"
            className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
          >
            {errorText || "Web search failed"}
          </div>
        </div>
      ) : hits.length > 0 ? (
        <div className="border-t px-1 py-1">
          <div className="flex flex-col">
            {visibleHits.map((hit) => (
              <WebSearchResultRow key={hit.url} hit={hit} />
            ))}
          </div>
          {hiddenCount > 0 ? (
            <button
              type="button"
              data-testid="websearch-toggle-all"
              onClick={() => setShowAll((value) => !value)}
              className="ml-8 mt-0.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              {showAll ? "Show fewer" : `Show all ${hits.length} results`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 border-t px-3 py-3">
          <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
            {noResults
              ? `No results found${query ? ` for "${query}"` : ""}.`
              : clean
                ? "No structured sources in this result."
                : "No results."}
          </div>
          {/* Nothing parsed into a card, so the formatted text is the whole
              result -- show it rather than hiding it behind a toggle. */}
          {clean ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 font-mono text-[11px]">
              {clean}
            </pre>
          ) : null}
        </div>
      )}

      {!pending && clean && hits.length > 0 ? (
        <div className="border-t px-3 py-1.5">
          <button
            type="button"
            data-testid="websearch-toggle-raw"
            onClick={() => setShowRaw((value) => !value)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform",
                showRaw && "rotate-180",
              )}
            />
            {showRaw ? "Hide raw output" : "Raw output"}
          </button>
          {showRaw ? (
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 font-mono text-[11px]">
              {clean}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface FetchedPageCardProps {
  input?: { url?: string; intent?: string };
  output?: unknown;
  runStatus?: ToolRunStatus;
  errorText?: string;
  duration?: string;
  className?: string;
}

/** The fetched page: host, title, link, size and a collapsible preview. */
export function FetchedPageCard({
  input,
  output,
  runStatus = "success",
  errorText,
  duration,
  className,
}: FetchedPageCardProps) {
  const [showContent, setShowContent] = useState(false);
  const parsed = parseWebFetchOutput(output, input?.url);
  const url = parsed.url || input?.url || "";
  const isPending = runStatus === "pending";
  const isError = runStatus === "error";

  return (
    <div
      data-testid="webfetch-source-card"
      className={cn(
        "w-full rounded-lg border bg-card overflow-hidden text-xs",
        isError && "border-destructive/50",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Fetch URL</span>
        <span className="flex min-w-0 items-center gap-1.5 rounded-full border bg-background px-2 py-0.5">
          <SiteFavicon url={url} className="size-3.5" />
          {isSafeHttpUrl(url) ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-[11px] text-primary hover:underline"
              title={url}
            >
              {url}
            </a>
          ) : (
            <span className="truncate font-mono text-[11px]">
              {url || "unknown url"}
            </span>
          )}
        </span>
        {typeof parsed.byteCount === "number" ? (
          <span
            data-testid="webfetch-byte-count"
            className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {formatBytes(parsed.byteCount)}
          </span>
        ) : null}
        {parsed.status ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {parsed.status}
          </span>
        ) : null}
        {duration ? (
          <span className="ml-auto shrink-0 rounded-full border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {duration}
          </span>
        ) : null}
      </div>

      <div className="space-y-2 px-3 py-2">
        {input?.intent ? (
          <div className="text-[11px] text-muted-foreground">
            {input.intent}
          </div>
        ) : null}

        {parsed.title || parsed.domain ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {parsed.title ? (
              <span className="truncate font-medium text-foreground">
                {parsed.title}
              </span>
            ) : null}
            {parsed.domain ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {parsed.domain}
              </span>
            ) : null}
          </div>
        ) : null}

        {isPending ? (
          <div className="space-y-1.5" data-testid="webfetch-pending">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileTextIcon className="size-3 animate-pulse" />
              <span className="animate-pulse">Fetching page…</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-linear-to-r from-transparent via-primary/50 to-transparent" />
            </div>
          </div>
        ) : isError ? (
          <div className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            {errorText || "Fetch failed"}
          </div>
        ) : parsed.content ? (
          <>
            <div
              data-testid="webfetch-content"
              className={cn(
                "whitespace-pre-wrap rounded-md border bg-muted/20 p-2 text-[11px] leading-relaxed text-muted-foreground",
                !showContent && "line-clamp-6",
              )}
            >
              {parsed.content}
            </div>
            <button
              type="button"
              data-testid="webfetch-toggle-content"
              onClick={() => setShowContent((value) => !value)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDownIcon
                className={cn(
                  "size-3 transition-transform",
                  showContent && "rotate-180",
                )}
              />
              {showContent ? "Show less" : "Show full content"}
            </button>
          </>
        ) : (
          <div className="rounded-md border border-dashed bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">
            No page content returned.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The line under a web call on the timeline: the sources it found as
 * stacked favicons with their hosts, so the folded log still shows where an
 * answer came from. The step's own pill above already says what was asked.
 */
export function WebSearchGlanceRow({
  toolName,
  input,
  output,
  status,
}: {
  toolName: string;
  input?: any;
  output?: any;
  status: ToolRunStatus;
}) {
  if (toolName === "webfetch" || toolName === "webContent") {
    const parsed = parseWebFetchOutput(output, input?.url);
    const url = parsed.url || input?.url || "";
    if (!url) return null;
    return (
      <div
        data-testid="worklog-webfetch-row"
        className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      >
        <WebSearchSourceChip
          testId="worklog-webfetch-chip"
          hit={{
            rank: 1,
            title: parsed.title || parsed.domain || url,
            url,
            domain: parsed.domain,
            faviconUrl: parsed.faviconUrl,
          }}
        />
        {status === "pending" ? <span className="animate-pulse">Reading…</span> : null}
      </div>
    );
  }

  const parsed = parseWebSearchOutput(output, input?.query);
  if (status === "pending") {
    return (
      <div
        data-testid="worklog-websearch-row"
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      >
        <span className="flex items-center">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-3.5 animate-pulse rounded-full border bg-muted"
              style={{ marginLeft: i === 0 ? 0 : -4, animationDelay: `${i * 150}ms` }}
            />
          ))}
        </span>
        <span className="animate-pulse">Looking for sources…</span>
      </div>
    );
  }
  if (!parsed.hits.length) return null;
  const chips = parsed.hits.slice(0, 4);
  const more = parsed.hits.length - chips.length;
  return (
    <div
      data-testid="worklog-websearch-row"
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {chips.map((hit) => (
        <WebSearchSourceChip
          key={hit.url}
          testId="worklog-websearch-chip"
          hit={hit}
        />
      ))}
      {more > 0 ? (
        <span className="shrink-0 px-1 text-[10px] text-muted-foreground">
          +{more} more
        </span>
      ) : null}
    </div>
  );
}

export interface WebSearchSourceEntry {
  id: string;
  query?: string;
  hits: ParsedWebSearchHit[];
  provider?: string;
  duration?: string;
  pending?: boolean;
  noResults?: boolean;
  errorText?: string;
  rawText?: string;
}

const websearch: ToolPresenter = {
  glance: ({ input, status }) => {
    const q = input?.query ?? "";
    if (status === "pending") return `Searching “${q}”…`;
    if (status === "error") return `Web search failed · “${q}”`;
    return `Searched “${q}”`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const parsed = parseWebSearchOutput(output, input?.query);
    const providerLabel = providerLabelFor(parsed.provider ?? parsed.providerId);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Web search</span>
          {providerLabel ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {providerLabel}
            </span>
          ) : null}
          {status !== "pending" ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {parsed.hits.length} sources
            </span>
          ) : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? (
            <div className="text-[11px] text-muted-foreground">
              {input.intent}
            </div>
          ) : null}
          <div className="font-mono text-primary font-medium">
            "{input?.query ?? ""}"
          </div>
          {parsed.hits.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {parsed.hits.slice(0, 4).map((hit) => (
                <WebSearchSourceChip key={hit.url} hit={hit} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const parsed = parseWebSearchOutput(output, input?.query);
    return (
      <WebSearchResultCard
        query={input?.query ?? parsed.query}
        provider={parsed.provider ?? parsed.providerId}
        hits={parsed.hits}
        duration={timing.duration}
        runStatus={status}
        pending={status === "pending"}
        errorText={errorText || parsed.errorText}
        noResults={parsed.noResults}
        rawText={parsed.rawText}
        intent={input?.intent}
      />
    );
  },
};

const webfetch: ToolPresenter = {
  glance: ({ input, status }) => {
    const url = input?.url ?? "";
    const host = extractDomain(url) || url;
    if (status === "pending") return `Reading ${host}…`;
    if (status === "error") return `Couldn't read ${host}`;
    return `Read ${host}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Fetch URL</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? (
            <div className="text-[11px] text-muted-foreground">
              {input.intent}
            </div>
          ) : null}
          <div className="font-mono text-primary truncate">
            {input?.url ?? ""}
          </div>
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <FetchedPageCard
        input={input}
        output={output}
        runStatus={status}
        errorText={errorText}
        duration={timing.duration}
      />
    );
  },
};

const browser: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "act";
    const desc = input?.goal ?? input?.url ?? "browser task";
    if (status === "pending") return `browser (${action}) · ${desc}…`;
    if (status === "error") return `⚠ browser (${action}) failed`;
    return `browser (${action}) · ${desc}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Browser · {input?.action ?? "session"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.goal ? <div className="text-primary">{input.goal}</div> : null}
          {input?.url ? <div className="font-mono text-[11px] text-muted-foreground">{input.url}</div> : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Browser · {input?.action ?? "session"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.goal ? <div className="text-primary font-medium">{input.goal}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "browser failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

/* ------------------------------------------------------------------ */
/* MCP: mcp, mcp_search, mcp_call                                     */
/* ------------------------------------------------------------------ */

const mcp: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "manage";
    const server = input?.server ? ` · ${input.server}` : "";
    if (status === "pending") return `mcp (${action})${server}…`;
    if (status === "error") return `mcp (${action}) failed`;
    return `mcp (${action})${server}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP {input?.action ? `· ${input.action}` : ""}</span>
          {input?.server ? <span className="font-mono text-primary">{input.server}</span> : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP {input?.action ? `· ${input.action}` : ""}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const mcpCall: ToolPresenter = {
  glance: ({ input, status }) => {
    const s = input?.server ?? "mcp";
    const t = input?.tool ?? "tool";
    if (status === "pending") return `calling ${s}/${t}…`;
    if (status === "error") return `⚠ ${s}/${t} failed`;
    return `${s}/${t}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium font-mono text-primary">
            {input?.server ?? "mcp"}/{input?.tool ?? "tool"}
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium font-mono text-primary">
            {input?.server ?? "mcp"}/{input?.tool ?? "tool"}
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {input?.arguments ? (
            <pre className="max-h-40 overflow-auto font-mono text-[11px] bg-muted/30 p-2 rounded">
              {JSON.stringify(input.arguments, null, 2)}
            </pre>
          ) : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const mcpSearch: ToolPresenter = {
  glance: ({ input, status }) => {
    const q = input?.query ?? "";
    if (status === "pending") return `searching mcp tools for "${q}"…`;
    if (status === "error") return `mcp tool search failed`;
    return `mcp_search · "${q}"`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP search · "{input?.query ?? ""}"</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP search · "{input?.query ?? ""}"</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

/* ------------------------------------------------------------------ */
/* Native UI & Apps: applet, panel, side_panel, schedule, gmail, cal  */
/* ------------------------------------------------------------------ */

const applet: ToolPresenter = {
  glance: ({ input, status }) => {
    const title = input?.title ?? input?.action ?? "native ui";
    const isHtmlVisual =
      input?.view?.type === "html" && typeof input?.view?.source === "string";
    if (isHtmlVisual) {
      if (status === "pending") return `visualizing (${title})…`;
      if (status === "error") return `visual failed`;
      return `visual · ${title}`;
    }
    if (status === "pending") return `applet (${title})…`;
    if (status === "error") return `applet failed`;
    return `applet · ${title}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const htmlSource =
      input?.view?.type === "html" && typeof input?.view?.source === "string"
        ? input.view.source
        : typeof input?.html === "string"
          ? input.html
          : null;
    if (htmlSource) {
      const height =
        typeof input?.view?.height === "number"
          ? input.view.height
          : typeof input?.height === "number"
            ? input.height
            : 320;
      if (status === "pending") {
        return <VisualPlaceholder title={input?.title} height={height} />;
      }
      return (
        <VisualSurface
          html={htmlSource}
          height={height}
          title={input?.title}
          surfaceId={input?.instance}
        />
      );
    }
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <LayoutIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Applet · {input?.title ?? input?.action ?? "ui"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    const htmlSource =
      input?.view?.type === "html" && typeof input?.view?.source === "string"
        ? input.view.source
        : typeof input?.html === "string"
          ? input.html
          : null;
    if (htmlSource && status !== "error") {
      const height =
        typeof input?.view?.height === "number"
          ? input.view.height
          : typeof input?.height === "number"
            ? input.height
            : 320;
      if (status === "pending") {
        return <VisualPlaceholder title={input?.title} height={height} />;
      }
      return (
        <VisualSurface
          html={htmlSource}
          height={height}
          title={input?.title}
          surfaceId={input?.instance}
        />
      );
    }
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <LayoutIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Applet · {input?.title ?? input?.action ?? "ui"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const schedule: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "create";
    const task = input?.task ? `: ${input.task.slice(0, 32)}` : "";
    if (status === "pending") return `schedule (${action})${task}…`;
    if (status === "error") return `schedule failed`;
    return `schedule (${action})${task}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Schedule · {input?.action ?? "task"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.task ? <div className="text-primary font-medium">{input.task}</div> : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Schedule · {input?.action ?? "task"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.task ? <div className="text-primary font-medium">{input.task}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const gmail: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "mail";
    if (status === "pending") return `gmail (${action})…`;
    if (status === "error") return `gmail failed`;
    return `gmail (${action})${input?.query ? ` · "${input.query}"` : ""}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Gmail · {input?.action ?? "mail"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Gmail · {input?.action ?? "mail"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const calendar: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "calendar";
    if (status === "pending") return `calendar (${action})…`;
    if (status === "error") return `calendar failed`;
    return `calendar (${action})${input?.query ? ` · "${input.query}"` : ""}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Calendar · {input?.action ?? "event"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Calendar · {input?.action ?? "event"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

export const jcodePresenters = {
  websearch,
  webfetch,
  browser,
  mcp,
  mcp_call: mcpCall,
  mcp_search: mcpSearch,
  applet,
  panel: applet,
  side_panel: applet,
  schedule,
  gmail,
  calendar,
};
