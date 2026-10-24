"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  RotateCw,
} from "lucide-react";
import { apiJson } from "@/lib/backend/client";
import { cn } from "lib/utils";
import { Button } from "ui/button";
import { Input } from "ui/input";

export interface BrowserLinkItem {
  label: string;
  href: string;
}

export interface AgentBrowserPageData {
  url: string;
  title: string;
  status: number;
  text: string;
  links?: BrowserLinkItem[];
  screenshot: string;
  capturedAt: string;
  isolation: "host" | "container";
}

export interface AgentBrowserStateResponse {
  agentId: string;
  isolation: "host" | "container";
  state: "idle" | "ready";
  page: AgentBrowserPageData | null;
}

export function AgentBrowserPanel({
  agentId,
  agentLabel,
  className,
}: {
  agentId: string;
  agentLabel?: string;
  className?: string;
}) {
  const t = useTranslations("Admin.debug.browser");
  const [urlInput, setUrlInput] = useState("https://example.com");
  const [pageData, setPageData] = useState<AgentBrowserPageData | null>(null);
  const [isolation, setIsolation] = useState<"host" | "container">("host");
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const loadState = useCallback(async () => {
    setInitialLoading(true);
    setError(null);
    try {
      const res = await apiJson<AgentBrowserStateResponse>(
        "/api/debug/browser",
        {
          headers: { "X-Amiro-Agent": agentId },
        },
      );
      setIsolation(res.isolation);
      setPageData(res.page);
      if (res.page?.url) {
        setUrlInput(res.page.url);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("loadError"),
      );
    } finally {
      setInitialLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const navigateTo = useCallback(
    async (targetUrl: string) => {
      const trimmed = targetUrl.trim();
      if (!trimmed) return;
      setLoading(true);
      setError(null);
      try {
        const res = await apiJson<AgentBrowserStateResponse>(
          "/api/debug/browser/navigate",
          {
            method: "POST",
            headers: { "X-Amiro-Agent": agentId },
            body: JSON.stringify({
              agentId,
              url: trimmed,
            }),
          },
        );
        setIsolation(res.isolation);
        setPageData(res.page);
        if (res.page?.url) {
          setUrlInput(res.page.url);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("navigateError"),
        );
      } finally {
        setLoading(false);
      }
    },
    [agentId, t],
  );

  const resolveHref = (href: string) => {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href;
    }
    if (pageData?.url) {
      try {
        return new URL(href, pageData.url).toString();
      } catch {
        return href;
      }
    }
    return href;
  };

  return (
    <div
      data-testid="agent-browser-panel"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-[#0f1117]",
        fullscreen && "fixed inset-4 z-50 shadow-2xl",
        className,
      )}
    >
      {/* Top Browser Toolbar (Vellum / OpenDots style) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {agentLabel ? `${t("heading")} · ${agentLabel}` : t("heading")}
          </span>
          <span
            data-testid="browser-isolation-badge"
            className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {isolation === "container"
              ? t("isolationContainer")
              : t("isolationHost")}
          </span>
        </div>

        <form
          className="flex min-w-[260px] flex-1 max-w-2xl items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void navigateTo(urlInput);
          }}
        >
          <div className="relative flex-1">
            <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com"
              aria-label={t("urlAria")}
              data-testid="agent-browser-url-input"
              className="h-8 bg-background/90 pl-8 font-mono text-xs"
              disabled={loading}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={loading || !urlInput.trim()}
            data-testid="agent-browser-go-button"
            className="h-8 gap-1 px-3 text-xs"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowRight className="size-3.5" />
            )}
            <span>{t("go")}</span>
          </Button>
          {pageData?.url && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              title={t("refresh")}
              disabled={loading}
              data-testid="agent-browser-refresh-button"
              onClick={() => void navigateTo(pageData.url)}
            >
              <RotateCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            title={fullscreen ? t("exitFullscreen") : t("fullscreen")}
            data-testid="agent-browser-fullscreen-button"
            onClick={() => setFullscreen((v) => !v)}
          >
            {fullscreen ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </Button>
        </form>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="agent-browser-error"
          className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      {/* Main Split View: Visual Screen Viewport + Extracted DOM / Links */}
      <div className="grid min-h-[380px] flex-1 grid-cols-1 lg:grid-cols-[1.35fr_1fr] overflow-hidden">
        {/* Left: Live Visual Screen Viewport */}
        <div className="relative flex flex-col items-center justify-center border-b border-border/40 bg-[#0b0d12] p-4 lg:border-b-0 lg:border-r">
          {initialLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("loading")}</span>
            </div>
          ) : pageData?.screenshot ? (
            <div className="flex h-full w-full flex-col gap-2">
              <div className="relative flex-1 overflow-hidden rounded-lg border border-border/50 bg-black shadow-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pageData.screenshot}
                  alt={pageData.title || pageData.url}
                  data-testid="agent-browser-screen-image"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="truncate font-mono" data-testid="agent-browser-current-url">
                  {pageData.url}
                </span>
                <span>
                  HTTP {pageData.status} ·{" "}
                  {new Date(pageData.capturedAt).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ) : (
            <div
              data-testid="agent-browser-empty"
              className="flex max-w-sm flex-col items-center gap-2.5 text-center text-muted-foreground"
            >
              <div className="flex size-11 items-center justify-center rounded-full border border-border/50 bg-muted/20">
                <Monitor className="size-5" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {t("emptyTitle")}
              </p>
              <p className="text-xs">{t("emptyDescription")}</p>
              <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                {["about:blank", "https://example.com"].map((sample) => (
                  <Button
                    key={sample}
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`agent-browser-preset-${sample.replace(/[^a-z0-9]/gi, "-")}`}
                    className="h-7 font-mono text-xs"
                    onClick={() => {
                      setUrlInput(sample);
                      void navigateTo(sample);
                    }}
                  >
                    {sample}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Extracted Page Content & Interactive Links */}
        <div className="flex min-h-0 flex-col bg-card/90 text-foreground overflow-y-auto p-4 space-y-4">
          {pageData ? (
            <>
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3
                    data-testid="agent-browser-page-title"
                    className="text-sm font-semibold leading-snug"
                  >
                    {pageData.title}
                  </h3>
                  {/^https?:\/\//i.test(pageData.url) && (
                    <a
                      href={pageData.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="size-3" />
                      <span>{t("openExternal")}</span>
                    </a>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {pageData.url}
                </p>
              </div>

              {pageData.links && pageData.links.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {t("interactiveLinks")}
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {pageData.links.map((link, idx) => {
                      const target = resolveHref(link.href);
                      return (
                        <button
                          key={`${link.href}-${idx}`}
                          type="button"
                          onClick={() => {
                            setUrlInput(target);
                            void navigateTo(target);
                          }}
                          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 text-xs transition-colors hover:bg-accent"
                          title={target}
                        >
                          <Globe className="size-3 shrink-0 text-muted-foreground" />
                          <span className="truncate max-w-[180px]">
                            {link.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {t("pageTextHeading")}
                </h4>
                <pre
                  data-testid="agent-browser-page-text"
                  className="max-h-[320px] overflow-auto rounded-lg border border-border/60 bg-background/80 p-3 font-mono text-xs whitespace-pre-wrap leading-relaxed text-foreground/90"
                >
                  {pageData.text || t("noTextContent")}
                </pre>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
              {t("inspectorEmpty")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
