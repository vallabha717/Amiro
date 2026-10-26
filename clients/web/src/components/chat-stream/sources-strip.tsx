"use client";

import {
  type ParsedWebSearchHit,
  isSafeHttpUrl,
} from "lib/web-search/parse-web-search";
import { cn } from "lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Collapse } from "../fold-card";
import {
  SiteFavicon,
  type WebSearchSourceEntry,
} from "../tool-presenters/jcode-presenters";

/** Every distinct source the turn's searches and fetches returned, in order. */
export function dedupeSources(searches: WebSearchSourceEntry[]): ParsedWebSearchHit[] {
  const seen = new Set<string>();
  const hits: ParsedWebSearchHit[] = [];
  for (const search of searches) {
    for (const hit of search.hits) {
      const key = hit.url.toLowerCase().replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  return hits;
}

const VISIBLE = 4;

function SourceLink({
  hit,
  index,
  className,
  children,
}: {
  hit: ParsedWebSearchHit;
  index: number;
  className: string;
  children: React.ReactNode;
}) {
  if (!isSafeHttpUrl(hit.url)) {
    return (
      <div data-testid="source-card" data-index={index} className={className}>
        {children}
      </div>
    );
  }
  return (
    <a
      data-testid="source-card"
      data-index={index}
      href={hit.url}
      target="_blank"
      rel="noopener noreferrer"
      title={hit.title}
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * The sources an answer stands on, as a row of numbered cards above it --
 * domain and title at a glance, every link one click away. The work
 * timeline already shows each search as it runs; this is the evidence that
 * stays once the timeline folds away, so it only appears when there is some.
 */
export function SourcesStrip({
  searches,
  className,
}: {
  searches: WebSearchSourceEntry[];
  className?: string;
}) {
  const t = useTranslations("ChatStream.Sources");
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => dedupeSources(searches), [searches]);
  if (!hits.length) return null;

  const visible = hits.slice(0, VISIBLE);
  const more = hits.length - visible.length;

  return (
    <section
      data-testid="message-web-sources-bar"
      aria-label={t("label", { count: hits.length })}
      className={cn("flex flex-col gap-1.5", className)}
    >
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {visible.map((hit, i) => (
          <SourceLink
            key={hit.url}
            hit={hit}
            index={i + 1}
            className="group/src flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-2.5 py-2 text-xs transition-colors hover:border-foreground/20 hover:bg-muted/40"
          >
            <span className="line-clamp-2 min-h-[2lh] font-medium leading-snug text-foreground">
              {hit.title || hit.domain}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <SiteFavicon url={hit.url} className="size-3.5" />
              <span className="truncate">{hit.domain}</span>
              <span className="ml-auto shrink-0 tabular-nums">{i + 1}</span>
            </span>
          </SourceLink>
        ))}
      </div>
      {more > 0 ? (
        <>
          <button
            type="button"
            data-testid="sources-toggle-all"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <span className="flex items-center">
              {hits.slice(VISIBLE, VISIBLE + 3).map((hit, i) => (
                <span
                  key={hit.url}
                  className="flex size-4 items-center justify-center overflow-hidden rounded-full border bg-background"
                  style={{ marginLeft: i === 0 ? 0 : -5 }}
                >
                  <SiteFavicon url={hit.url} className="size-3 rounded-full" />
                </span>
              ))}
            </span>
            {open ? t("showFewer") : t("showMore", { count: more })}
            <ChevronDownIcon
              className={cn("size-3 transition-transform", open && "rotate-180")}
            />
          </button>
          <Collapse open={open}>
            <ol className="flex flex-col divide-y rounded-lg border bg-card">
              {hits.slice(VISIBLE).map((hit, i) => (
                <li key={hit.url}>
                  <SourceLink
                    hit={hit}
                    index={VISIBLE + i + 1}
                    className="flex min-w-0 items-start gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-muted/40"
                  >
                    <span className="w-4 shrink-0 pt-px text-right tabular-nums text-muted-foreground">
                      {VISIBLE + i + 1}
                    </span>
                    <SiteFavicon url={hit.url} className="mt-0.5 size-3.5" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{hit.title || hit.domain}</span>
                      {hit.snippet ? (
                        <span className="line-clamp-1 text-muted-foreground">{hit.snippet}</span>
                      ) : (
                        <span className="truncate text-muted-foreground">{hit.domain}</span>
                      )}
                    </span>
                  </SourceLink>
                </li>
              ))}
            </ol>
          </Collapse>
        </>
      ) : null}
    </section>
  );
}
