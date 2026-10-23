"use client";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  Trash2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { safe } from "ts-safe";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "lib/utils";
import { Alert, AlertDescription } from "ui/alert";
import { handleErrorWithToast } from "ui/shared-toast";
import { Skeleton } from "ui/skeleton";

import {
  COMPOSIO_TOOLKITS_PAGE_SIZE,
  useComposioConfig,
  useComposioToolkits,
} from "@/hooks/queries/use-composio";
import {
  openComposioRedirect,
  pollComposioConnectionStatus,
} from "@/lib/ai/composio/connect-flow";
import {
  ComposioToolkit,
  removeComposioApiKey,
  removeComposioConnection,
  saveComposioApiKey,
  startComposioConnect,
  syncComposioConnections,
} from "@/lib/backend/composio-api";

type Filter = "all" | "connected";

function SourceLabel({ source }: { source: string | null }) {
  const t = useTranslations("Composio");
  if (source === "ui") return <>{t("sourceUi")}</>;
  if (source === "env") return <>{t("sourceEnv")}</>;
  if (source === "toml") return <>{t("sourceToml")}</>;
  return <>{t("sourceNone")}</>;
}

/** Composio key status and replacement. Lives on Admin → Integrations. */
export function ApiKeyPanel({ onChanged = () => {} }: { onChanged?: () => void }) {
  const t = useTranslations("Composio");
  const {
    data: config,
    isLoading,
    mutate,
  } = useComposioConfig({ refreshInterval: 30000 });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleSave = () =>
    safe(() => setSaving(true))
      .map(() => saveComposioApiKey(apiKey.trim()))
      .ifOk((next) => {
        setApiKey("");
        mutate(next, false);
        onChanged();
        toast.success(t("apiKeySaved"));
      })
      .ifFail(handleErrorWithToast)
      .watch(() => setSaving(false));

  const handleRemove = () =>
    safe(() => setRemoving(true))
      .map(() => removeComposioApiKey())
      .ifOk(() => {
        mutate();
        onChanged();
        toast.success(t("apiKeyRemoved"));
      })
      .ifFail(handleErrorWithToast)
      .watch(() => setRemoving(false));

  return (
    <Card className="bg-secondary/40" data-testid="composio-api-key-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          {t("apiKeyTitle")}
          {config?.configured && (
            <Badge variant="secondary" className="ml-1 gap-1">
              <CheckCircle2 className="size-3" />
              <SourceLabel source={config.source} />
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t("apiKeyDescription")}
          {config?.apiKeyHint && (
            <span className="ml-1 font-mono text-xs">{config.apiKeyHint}</span>
          )}
        </p>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={t("apiKeyPlaceholder")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKey.trim() && !saving) handleSave();
              }}
              data-testid="composio-api-key-input"
              className="flex-1"
            />
            <div className="flex gap-2">
              <Button
                onClick={handleSave}
                disabled={!apiKey.trim() || saving}
                data-testid="composio-api-key-save"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t("save")}
              </Button>
              {config?.configured && config.source === "ui" && (
                <Button
                  variant="outline"
                  onClick={handleRemove}
                  disabled={removing}
                  data-testid="composio-api-key-remove"
                >
                  {removing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {t("remove")}
                </Button>
              )}
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t("apiKeyAlternatives")}
        </p>
      </CardContent>
    </Card>
  );
}

/** An app logo, falling back to its initials. */
export function AppLogo({ name, logo, className }: { name: string; logo?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-background p-1.5 shadow-sm",
        className,
      )}
    >
      {logo && !failed ? (
        <img
          src={logo}
          alt=""
          className="size-full object-contain"
          onError={() => setFailed(true)}
          loading="lazy"
        />
      ) : (
        <span className="text-sm font-semibold uppercase text-muted-foreground">{name.slice(0, 2)}</span>
      )}
    </div>
  );
}

function ToolkitCard({
  toolkit,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
}: {
  toolkit: ComposioToolkit;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: (toolkit: ComposioToolkit) => void;
  onDisconnect: (toolkit: ComposioToolkit) => void;
}) {
  const t = useTranslations("Composio");
  const busy = connecting || disconnecting;
  return (
    <div
      className={cn(
        "relative flex flex-col items-center gap-2.5 rounded-2xl border bg-card p-4 text-center transition-all hover:shadow-sm",
        toolkit.connected
          ? "border-emerald-500/40 bg-emerald-500/[0.04]"
          : "border-border/60 hover:border-foreground/20",
      )}
      title={toolkit.description || undefined}
      data-testid={`composio-toolkit-card-${toolkit.slug}`}
      data-connected={toolkit.connected}
    >
      {toolkit.connected && (
        <span className="absolute right-3 top-3 size-2 rounded-full bg-emerald-500" aria-label={t("connected")} />
      )}
      <AppLogo name={toolkit.name} logo={toolkit.logo} />
      <div className="w-full min-w-0">
        <p className="truncate text-sm font-semibold">{toolkit.name}</p>
        <p className="mt-0.5 line-clamp-2 min-h-8 text-[11px] leading-4 text-muted-foreground">
          {toolkit.description || toolkit.categories[0] || t("noDescription")}
        </p>
      </div>
      {toolkit.connected ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() => onDisconnect(toolkit)}
          data-testid={`composio-disconnect-${toolkit.slug}`}
        >
          {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
          {t("disconnect")}
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-8 w-full text-xs font-semibold"
          disabled={busy}
          onClick={() => onConnect(toolkit)}
          data-testid={`composio-connect-${toolkit.slug}`}
        >
          {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          {t("connect")}
        </Button>
      )}
    </div>
  );
}

/** The Composio app catalog, embedded as a section of the Connectors page. */
export function ComposioAppsSection() {
  const t = useTranslations("Composio");
  const { mutate } = useSWRConfig();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(
    null,
  );
  const [syncing, setSyncing] = useState(false);

  // Debounce the server-side search so typing does not fire a request per
  // keystroke; the input stays immediate while the SWR key lags by 300ms.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const {
    data: pages,
    error,
    isLoading,
    isValidating,
    size,
    setSize,
    mutate: mutateToolkits,
  } = useComposioToolkits(search);

  const toolkits = useMemo(
    () => (pages ?? []).flatMap((page) => page.items),
    [pages],
  );
  const visibleToolkits = useMemo(
    () =>
      filter === "connected"
        ? toolkits.filter((toolkit) => toolkit.connected)
        : toolkits,
    [toolkits, filter],
  );
  const hasMore = useMemo(
    () => (pages?.length ? pages[pages.length - 1]?.nextCursor != null : false),
    [pages],
  );
  const connectedCount = useMemo(
    () => toolkits.filter((toolkit) => toolkit.connected).length,
    [toolkits],
  );

  const refreshAll = () => {
    mutateToolkits();
    mutate("/api/composio/connections");
    mutate("/api/composio/config");
  };

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
  };

  const handleConnect = async (toolkit: ComposioToolkit) => {
    setConnectingSlug(toolkit.slug);
    let popup: Window | null = null;
    try {
      const { redirectUrl, connectionId } = await startComposioConnect(
        toolkit.slug,
      );
      popup = openComposioRedirect(redirectUrl);
      if (!popup) {
        toast.error(t("popupBlocked"));
        return;
      }
      const status = await pollComposioConnectionStatus(connectionId);
      if (popup && !popup.closed) popup.close();
      if (status === "ACTIVE") {
        toast.success(t("connectSuccess", { name: toolkit.name }));
      } else {
        toast.error(t("connectFailed", { name: toolkit.name, status }));
      }
    } catch (e) {
      if (popup && !popup.closed) popup.close();
      handleErrorWithToast(e as Error);
    } finally {
      setConnectingSlug(null);
      refreshAll();
    }
  };

  const handleDisconnect = async (toolkit: ComposioToolkit) => {
    if (!toolkit.connectionId) return;
    setDisconnectingSlug(toolkit.slug);
    try {
      await removeComposioConnection(toolkit.connectionId);
      toast.success(t("disconnectSuccess", { name: toolkit.name }));
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setDisconnectingSlug(null);
      refreshAll();
    }
  };

  const handleSync = () =>
    safe(() => setSyncing(true))
      .map(() => syncComposioConnections())
      .ifOk((result) => {
        toast.success(t("syncSuccess", { count: result.toolkits.length }));
        refreshAll();
      })
      .ifFail(handleErrorWithToast)
      .watch(() => setSyncing(false));

  return (
      <section
        className="relative flex flex-col gap-4"
        data-testid="composio-dashboard"
      >
        <div className="flex items-center gap-2">
          <h2
            className="text-base font-semibold flex items-center gap-2"
            data-testid="composio-title"
          >
            Apps
            <span className="text-xs font-normal text-muted-foreground">
              via Composio
            </span>
            {isValidating && !isLoading && (
              <Loader2 className="size-4 animate-spin" />
            )}
          </h2>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
            data-testid="composio-sync-button"
            className="font-semibold"
          >
            <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
            {t("sync")}
          </Button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              data-testid="composio-search-input"
              className="pl-9"
            />
          </div>
          <div className="flex gap-1 p-1 rounded-lg border bg-secondary/40 w-fit">
            {(["all", "connected"] as Filter[]).map((option) => (
              <Button
                key={option}
                variant={filter === option ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFilter(option)}
                data-testid={`composio-filter-${option}`}
              >
                {option === "all"
                  ? t("filterAll")
                  : t("filterConnected", { count: connectedCount })}
              </Button>
            ))}
          </div>
        </div>

        <p
          className="text-xs text-muted-foreground"
          data-testid="composio-surface-note"
        >
          {t("surfaceNote")}
        </p>

        {isLoading ? (
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="composio-loading"
          >
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-52 w-full" />
            ))}
          </div>
        ) : error ? (
          <Alert
            variant="destructive"
            className="border-destructive"
            data-testid="composio-error"
          >
            <AlertDescription className="flex flex-col gap-3">
              <span>{t("loadError")}</span>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => mutateToolkits()}
              >
                <RefreshCw className="size-4" />
                {t("retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : visibleToolkits.length > 0 ? (
          <div className="flex flex-col gap-4">
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
              data-testid="composio-toolkit-grid"
            >
              {visibleToolkits.map((toolkit) => (
                <ToolkitCard
                  key={toolkit.slug}
                  toolkit={toolkit}
                  connecting={connectingSlug === toolkit.slug}
                  disconnecting={disconnectingSlug === toolkit.slug}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                />
              ))}
            </div>
            {filter === "all" && hasMore && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  onClick={() => setSize(size + 1)}
                  disabled={isValidating}
                  data-testid="composio-load-more"
                >
                  {isValidating && <Loader2 className="size-4 animate-spin" />}
                  {t("loadMore")}
                </Button>
              </div>
            )}
            {filter === "all" && (
              <p className="text-xs text-muted-foreground text-center">
                {t("showingCount", { count: toolkits.length })}
                {COMPOSIO_TOOLKITS_PAGE_SIZE
                  ? ` (${t("pageSize", { size: COMPOSIO_TOOLKITS_PAGE_SIZE })})`
                  : ""}
              </p>
            )}
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center space-y-4 my-20 text-center"
            data-testid="composio-empty"
          >
            <h3 className="text-2xl md:text-4xl font-semibold">
              {filter === "connected"
                ? t("noConnectedTitle")
                : t("noResultsTitle")}
            </h3>
            <p className="text-muted-foreground max-w-md">
              {filter === "connected"
                ? t("noConnectedDescription")
                : search.trim()
                  ? t("noResultsDescription", { query: search.trim() })
                  : t("noToolkitsDescription")}
            </p>
            {filter === "connected" && (
              <Button variant="outline" onClick={() => setFilter("all")}>
                {t("filterAll")}
              </Button>
            )}
          </div>
        )}
      </section>
  );
}

const COMPOSIO_API_KEY_URL = "https://platform.composio.dev/settings";
const COMPOSIO_SIGNUP_URL = "https://platform.composio.dev";

/** Compact Composio key setup, shown in place of the app catalog. */
export function ComposioSetupCard() {
  const t = useTranslations("Composio");
  const { mutate } = useSWRConfig();
  const { mutate: mutateConfig } = useComposioConfig();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = () =>
    safe(() => setSaving(true))
      .map(() => saveComposioApiKey(apiKey.trim()))
      .ifOk((next) => {
        setApiKey("");
        mutateConfig(next, false);
        mutate("/api/composio/config");
        toast.success(t("apiKeySaved"));
      })
      .ifFail(handleErrorWithToast)
      .watch(() => setSaving(false));

  const steps = [t("setupStep1"), t("setupStep2"), t("setupStep3")];

  return (
        <Card className="bg-secondary/40" data-testid="composio-setup">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
              {t("setupTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="text-sm text-muted-foreground">
              {t("setupDescription")}
            </p>
            <ol className="flex flex-col gap-2 text-sm list-decimal pl-5">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a
                  href={COMPOSIO_API_KEY_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="composio-get-key-link"
                >
                  <ExternalLink className="size-4" />
                  {t("getApiKey")}
                </a>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <a
                  href={COMPOSIO_SIGNUP_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("createAccount")}
                </a>
              </Button>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="password"
                autoComplete="off"
                placeholder={t("apiKeyPlaceholder")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && apiKey.trim() && !saving)
                    handleSave();
                }}
                data-testid="composio-api-key-input"
                className="flex-1"
              />
              <Button
                onClick={handleSave}
                disabled={!apiKey.trim() || saving}
                data-testid="composio-api-key-save"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t("save")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("apiKeyAlternatives")}
            </p>
          </CardContent>
        </Card>
  );
}
