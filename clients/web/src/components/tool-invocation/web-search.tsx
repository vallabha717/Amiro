"use client";

import {
  SEARCH_ACTIVE_KEY,
  selectActiveSearchProvider,
} from "@/lib/backend/search-provider-api";
import { ToolUIPart } from "ai";
import { authClient } from "auth/client";
import { motion } from "framer-motion";
import {
  type ExtractedPage,
  type SearchHit,
  type WebContentToolOutput,
  type WebSearchToolOutput,
  isWebToolError,
} from "lib/ai/tools/web/web-search-result";
import equal from "lib/equal";
import { toAny, truncateString } from "lib/utils";
import {
  AlertTriangleIcon,
  FileTextIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { memo, useMemo } from "react";
import useSWR from "swr";
import { Avatar, AvatarFallback, AvatarImage } from "ui/avatar";
import { Skeleton } from "ui/skeleton";
import { TextShimmer } from "ui/text-shimmer";

interface WebSearchToolInvocationProps {
  part: ToolUIPart;
}

/** A Google-hosted favicon for a URL's hostname. Every provider here returns
 * links and never a favicon of its own, so this is the one dependable source
 * of the little icon that makes a list of ten identical-looking result rows
 * scannable. */
function faviconFor(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  } catch {
    return undefined;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The selected default provider, fetched once and shared by every
 * search/content card on screen.
 *
 * Only meaningful before a tool call resolves -- once it has, the output
 * itself names the provider that actually answered (`result.provider`),
 * which is the more trustworthy source: this hook's answer can be stale by
 * the time a slow search finishes if a fallback answers or someone changes the default
 * mid-turn.
 */
function useActiveProviderHint() {
  const { data } = useSWR(SEARCH_ACTIVE_KEY, selectActiveSearchProvider, {
    revalidateOnFocus: false,
    // The chat surface is not the admin page: it should not fail loudly or
    // retry aggressively over a fact that is cosmetic here (the pending
    // label) and authoritative from the tool's own output once it lands.
    shouldRetryOnError: false,
  });
  return data;
}

/** True while an admin is signed in -- gates the "Open Search Providers"
 * link on an error card, since a non-admin cannot act on it anyway. */
function useIsAdmin() {
  const { data: session } = authClient.useSession();
  return session?.user?.role === "admin";
}

function ProviderBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
      <SearchIcon className="size-2.5" />
      {label}
    </span>
  );
}

/** The panel shown when a search/content call comes back as a controlled
 * failure (see webToolError in the Go backend): a message, the model's
 * remedy, and -- for an admin -- a direct link to fix it. */
function ToolErrorPanel({
  message,
  solution,
}: {
  message: string;
  solution: string;
}) {
  const t = useTranslations();
  const isAdmin = useIsAdmin();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 mx-12">
      <p className="flex items-start gap-2 text-sm text-destructive">
        <AlertTriangleIcon className="size-4 shrink-0 mt-0.5" />
        <span>{message}</span>
      </p>
      <p className="text-xs text-muted-foreground pl-6">{solution}</p>
      {isAdmin && (
        <Link
          href="/admin/search"
          className="flex items-center gap-1.5 self-start pl-6 text-xs text-primary underline-offset-4 hover:underline"
        >
          <SettingsIcon className="size-3" />
          {t("Chat.Tool.openSearchProviders")}
        </Link>
      )}
    </div>
  );
}

/** The pending skeleton shared by both tools: a browser-chrome frame with a
 * scrolling placeholder underneath, so a search and a page-read look like
 * two moments of the same action rather than two different features. */
function PendingFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-background/50 mx-12">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="flex gap-1.5">
          <div className="size-2 rounded-full bg-muted-foreground/20" />
          <div className="size-2 rounded-full bg-muted-foreground/20" />
          <div className="size-2 rounded-full bg-muted-foreground/20" />
        </div>
      </div>
      <div className="relative h-[160px] overflow-hidden p-3">
        <div className="absolute inset-x-0 top-0 z-10 h-4 bg-linear-to-b from-background/50 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 z-10 h-12 bg-linear-to-t from-background/50 to-transparent" />
        {children}
      </div>
    </div>
  );
}

function SkeletonRows({ count = 10 }: { count?: number }) {
  return (
    <motion.div
      initial={{ y: 0 }}
      animate={{ y: "-50%" }}
      transition={{
        duration: 5,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
        repeatType: "loop",
      }}
      className="flex flex-col"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3 mb-4">
          <Skeleton className="size-10 rounded-lg shrink-0" />
          <div className="flex flex-col gap-2 flex-1 pt-1">
            <Skeleton className="h-3 w-3/4 rounded-full" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-2 w-5/6 rounded-full" />
          </div>
        </div>
      ))}
    </motion.div>
  );
}

/** One search hit: favicon, title, hostname, and the snippet -- which the
 * previous version of this card never rendered, so a result was a link with
 * no indication of what was on the other end of it. */
function SearchResultRow({ result }: { result: SearchHit }) {
  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors border border-transparent hover:border-border/50"
    >
      <div className="size-9 rounded-md bg-muted/50 border border-border/50 flex items-center justify-center shrink-0">
        <Avatar className="size-5 rounded-sm">
          <AvatarImage src={faviconFor(result.url)} />
          <AvatarFallback className="text-[10px]">
            {result.title?.slice(0, 1).toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
      </div>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {result.title || result.url}
          </span>
          <span className="text-[10px] text-muted-foreground/70 shrink-0">
            {hostnameOf(result.url)}
          </span>
        </div>
        {result.snippet && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {result.snippet}
          </p>
        )}
      </div>
    </a>
  );
}

/** One extracted page, for web_content. Distinct from a search hit because
 * what it carries is different: full text worth previewing several lines
 * of, an author and a publish date when the provider has them, not a
 * one-line snippet. */
function ExtractedPageRow({ page }: { page: ExtractedPage }) {
  return (
    <a
      href={page.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors border border-transparent hover:border-border/50"
    >
      <div className="size-9 rounded-md bg-muted/50 border border-border/50 flex items-center justify-center shrink-0">
        <Avatar className="size-5 rounded-sm">
          <AvatarImage src={faviconFor(page.url)} />
          <AvatarFallback className="text-[10px]">
            <FileTextIcon className="size-3" />
          </AvatarFallback>
        </Avatar>
      </div>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {page.title || hostnameOf(page.url)}
          </span>
          <span className="text-[10px] text-muted-foreground/70 shrink-0">
            {hostnameOf(page.url)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-3">
          {page.text}
        </p>
      </div>
    </a>
  );
}

function PureWebSearchToolInvocation({ part }: WebSearchToolInvocationProps) {
  const t = useTranslations();
  const activeProvider = useActiveProviderHint();

  // `part.type` is `tool-webSearch` or `tool-webContent` -- the two tool
  // names this component is registered for in message-parts.tsx. Branching
  // on it, rather than guessing from the output shape, is what lets a
  // content-extraction call get its own pending state and its own empty-
  // result wording instead of borrowing search's.
  const isContent = part.type === "tool-webContent";

  const query = useMemo(
    () => (part.input as { query?: string })?.query,
    [part.input],
  );
  const urls = useMemo(
    () => (part.input as { urls?: string[] })?.urls ?? [],
    [part.input],
  );

  const isPending = !part.state.startsWith("output");
  const output = isPending ? undefined : (part.output as unknown);
  const toolError = !isPending && isWebToolError(output) ? output : undefined;

  if (isPending) {
    if (isContent) {
      return (
        <div className="flex flex-col gap-3 min-w-[300px] w-full fade-300">
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileTextIcon className="size-3 wiggle" />
              <TextShimmer>
                {t("Chat.Tool.readingPages", { count: urls.length || 1 })}
              </TextShimmer>
            </div>
            {activeProvider?.configured && activeProvider.label && (
              <ProviderBadge label={`Default: ${activeProvider.label}`} />
            )}
          </div>
          <PendingFrame>
            <SkeletonRows count={Math.max(urls.length, 3)} />
          </PendingFrame>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3 min-w-[300px] w-full fade-300">
        <div className="flex items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <SearchIcon className="size-3 wiggle" />
            <TextShimmer>
              {query?.length
                ? `"${truncateString(query, 30)}" ${t("Chat.Tool.webSearching")}`
                : t("Chat.Tool.webSearching")}
            </TextShimmer>
          </div>
          {activeProvider &&
            (activeProvider.configured && activeProvider.label ? (
              <ProviderBadge label={`Default: ${activeProvider.label}`} />
            ) : (
              // Shown before the call even resolves: the tool is certain to
              // fail for lack of a provider, and there is no reason to make
              // the user wait for the round trip to learn that.
              <span className="text-[11px] text-muted-foreground">
                {t("Chat.Tool.searchNotConfigured")}
              </span>
            ))}
        </div>
        <PendingFrame>
          <SkeletonRows />
        </PendingFrame>
      </div>
    );
  }

  if (toolError || part.errorText) {
    return (
      <div className="flex flex-col gap-3 min-w-[300px] w-full fade-300">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {isContent ? (
            <FileTextIcon className="size-3" />
          ) : (
            <SearchIcon className="size-3" />
          )}
          <span>
            {isContent
              ? t("Chat.Tool.webContentFailed")
              : t("Chat.Tool.webSearchFailed")}
          </span>
        </div>
        <ToolErrorPanel
          message={toolError?.error ?? part.errorText ?? ""}
          solution={toolError?.solution ?? ""}
        />
      </div>
    );
  }

  if (isContent) {
    const result = output as WebContentToolOutput;
    const pages = "pages" in result ? result.pages : [];
    return (
      <div className="flex flex-col gap-3 min-w-[300px] w-full fade-300">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <FileTextIcon className="size-3" />
            {t("Chat.Tool.readPages", { count: pages.length })}
          </span>
          {"provider" in result && <ProviderBadge label={result.provider} />}
        </div>
        <div className="relative overflow-hidden rounded-xl border bg-background/50 mx-12">
          <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
            <div className="flex gap-1.5">
              <div className="size-2 rounded-full bg-muted-foreground/20" />
              <div className="size-2 rounded-full bg-muted-foreground/20" />
              <div className="size-2 rounded-full bg-muted-foreground/20" />
            </div>
          </div>
          <div className="p-3 flex flex-col gap-2 max-h-[400px] overflow-y-auto scrollbar-hide">
            {pages.map((page, i) => (
              <ExtractedPageRow key={`${page.url}-${i}`} page={page} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const result = output as WebSearchToolOutput;
  const results = "results" in result ? result.results : [];

  return (
    <div className="flex flex-col gap-3 min-w-[300px] w-full fade-300">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <SearchIcon className="size-3" />
          {query?.length
            ? `"${truncateString(query, 30)}" ${t("Chat.Tool.searchedTheWeb")}`
            : t("Chat.Tool.searchedTheWeb")}
        </span>
        {"provider" in result && <ProviderBadge label={result.provider} />}
      </div>

      <div className="relative overflow-hidden rounded-xl border bg-background/50 mx-12">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
          <div className="flex gap-1.5">
            <div className="size-2 rounded-full bg-muted-foreground/20" />
            <div className="size-2 rounded-full bg-muted-foreground/20" />
            <div className="size-2 rounded-full bg-muted-foreground/20" />
          </div>
        </div>

        <div className="relative">
          <div className="absolute inset-x-0 bottom-0 z-10 h-12 bg-linear-to-t from-background/80 to-transparent pointer-events-none rounded-b-xl" />

          <div className="p-3 flex flex-col gap-2 max-h-[400px] overflow-y-auto scrollbar-hide">
            {results.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">
                {t("Common.noResults")}
              </p>
            ) : (
              results.map((hit, i) => (
                <SearchResultRow key={`${hit.url}-${i}`} result={hit} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function areEqual(
  { part: prevPart }: WebSearchToolInvocationProps,
  { part: nextPart }: WebSearchToolInvocationProps,
) {
  if (prevPart.state != nextPart.state) return false;
  if (!equal(prevPart.input, nextPart.input)) return false;
  if (
    prevPart.state.startsWith("output") &&
    !equal(prevPart.output, toAny(nextPart).output)
  )
    return false;
  return true;
}

export const WebSearchToolInvocation = memo(
  PureWebSearchToolInvocation,
  areEqual,
);
