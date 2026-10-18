"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Search,
  RefreshCw,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Separator } from "ui/separator";
import { Skeleton } from "ui/skeleton";
import { ScrollArea } from "ui/scroll-area";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { handleErrorWithToast } from "ui/shared-toast";
import JsonView from "ui/json-view";
import { cn } from "lib/utils";

import {
  PROVIDERS_KEY,
  selectProviders,
  testProviderModel,
  syncProviderModels,
  type ProviderConfig,
  type ProviderTestResult,
} from "@/lib/backend/provider-api";

export default function ProviderTestPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProviderTest />
    </Suspense>
  );
}

function PageSkeleton() {
  return (
    <div className="p-8 max-w-4xl mx-auto w-full space-y-4">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-60 w-full" />
    </div>
  );
}

function ProviderTest() {
  const t = useTranslations("Providers");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const modelParam = searchParams.get("model");

  const {
    data: providers,
    isLoading,
    error: loadError,
    mutate,
  } = useSWR<ProviderConfig[]>(PROVIDERS_KEY, selectProviders);

  const provider = useMemo(
    () => providers?.find((p) => p.id === id),
    [providers, id],
  );

  const [selectedModel, setSelectedModel] = useState<string | null>(modelParam);
  const [filter, setFilter] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Land on a usable model instead of an empty right pane when the card
  // linked here without naming one.
  useEffect(() => {
    if (
      provider &&
      (!selectedModel || !provider.models?.includes(selectedModel))
    ) {
      setSelectedModel(provider.models?.[0] ?? null);
    }
  }, [provider, selectedModel]);

  const models = provider?.models ?? [];
  const visibleModels = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((m) => m.toLowerCase().includes(needle));
  }, [models, filter]);

  const runTest = async () => {
    if (!id || !selectedModel) return;
    setIsRunning(true);
    setResult(null);
    setActionError(null);
    try {
      setResult(await testProviderModel(id, selectedModel));
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : "The model test could not be completed. Try again.",
      );
      handleErrorWithToast(e as Error);
    } finally {
      setIsRunning(false);
    }
  };

  const refreshModels = async () => {
    if (!id) return;
    setIsRefreshing(true);
    setActionError(null);
    try {
      await syncProviderModels(id);
      await mutate();
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : "Could not refresh models. Check the provider connection and try again.",
      );
    } finally {
      setIsRefreshing(false);
    }
  };

  if (isLoading) return <PageSkeleton />;

  if (loadError)
    return (
      <div className="p-8 max-w-4xl mx-auto w-full space-y-4">
        <BackLink label={t("backToProviders")} />
        <Alert variant="destructive">
          <AlertTitle>Could not load provider models</AlertTitle>
          <AlertDescription>
            Check your connection and try again.
          </AlertDescription>
        </Alert>
        <Button onClick={() => mutate()}>Try again</Button>
      </div>
    );

  if (!provider) {
    return (
      <div className="p-8 max-w-4xl mx-auto w-full">
        <BackLink label={t("backToProviders")} />
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>{t("providerNotFoundTitle")}</AlertTitle>
          <AlertDescription>{t("providerNotFoundBody")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="pt-8 px-4 sm:px-8 max-w-6xl mx-auto w-full pb-16 flex flex-col gap-6">
        <div>
          <BackLink label={t("backToProviders")} />
          <div className="flex items-center gap-3 mt-4">
            <div className="p-2.5 bg-background border rounded-xl text-primary shadow-sm">
              <ModelProviderIcon
                provider={provider.provider}
                className="size-5"
              />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                {provider.name} models
                <Badge variant="secondary" className="text-[10px]">
                  {provider.provider}
                </Badge>
              </h1>
              <p className="text-sm text-muted-foreground">
                Browse every model reported for this connection, select one,
                then run a test.
              </p>
            </div>
          </div>
        </div>

        <Separator />

        {actionError && (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Action could not be completed</AlertTitle>
            <AlertDescription className="break-words">
              {actionError}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {/* Model picker */}
          <div className="flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {t("availableModels")}{" "}
                <Badge variant="secondary">{models.length}</Badge>
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshModels}
                disabled={isRefreshing || isRunning}
                data-testid="refresh-models"
              >
                <RefreshCw
                  className={cn("size-4 mr-2", isRefreshing && "animate-spin")}
                />
                {isRefreshing ? "Refreshing..." : "Refresh models"}
              </Button>
            </div>

            {
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("filterModels")}
                  aria-label="Search available models"
                  data-testid="filter-models"
                  className="h-10 pl-8 text-sm"
                />
              </div>
            }

            <p
              className="text-xs text-muted-foreground"
              aria-live="polite"
              data-testid="model-list-count"
            >
              {filter
                ? `${visibleModels.length} of ${models.length} models match your search`
                : `${models.length} models listed. Select a model to test its response.`}
            </p>
            <div
              className="flex flex-col divide-y border rounded-lg max-h-[560px] overflow-y-auto"
              aria-label="Available models"
              aria-busy={isRefreshing}
            >
              {visibleModels.length === 0 ? (
                <div className="p-6 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {models.length === 0
                      ? t("noModelsConfigured")
                      : t("noModelsMatchFilter")}
                  </p>
                  {filter && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFilter("")}
                    >
                      Clear search
                    </Button>
                  )}
                  {!models.length && (
                    <p className="text-xs text-muted-foreground">
                      Refresh the model list or check the provider credentials.
                      A connected provider may not expose a model catalogue.
                    </p>
                  )}
                </div>
              ) : (
                visibleModels.map((model) => (
                  <button
                    key={model}
                    type="button"
                    aria-pressed={selectedModel === model}
                    disabled={isRunning}
                    onClick={() => {
                      setSelectedModel(model);
                      setResult(null);
                    }}
                    className={cn(
                      "text-left text-sm px-4 py-3 transition-colors flex items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-50",
                      selectedModel === model
                        ? "bg-primary/10 font-medium"
                        : "hover:bg-muted",
                    )}
                    data-testid="test-model-option"
                  >
                    <span className="font-mono break-all min-w-0 flex-1">
                      {model}
                    </span>
                    {selectedModel === model && (
                      <span className="text-xs flex items-center gap-1 shrink-0 text-primary">
                        <CheckCircle2 className="size-3.5" />
                        Selected
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Result pane */}
          <div className="flex flex-col gap-4 min-w-0">
            <h2 className="text-lg font-semibold">Test selected model</h2>
            <p className="text-xs text-muted-foreground">
              Runs a live response and tool-calling check. Provider usage
              charges may apply.
            </p>
            <div className="flex flex-col gap-3 border rounded-lg p-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {t("selectedModel")}
                </p>
                <p
                  className="font-mono text-sm break-all mt-1"
                  data-testid="selected-test-model"
                >
                  {selectedModel ?? "—"}
                </p>
              </div>
              <Button
                onClick={runTest}
                disabled={!selectedModel || isRunning || isRefreshing}
                className="font-semibold shrink-0"
                data-testid="run-model-test"
              >
                {isRunning ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <FlaskConical className="size-4 mr-2" />
                )}
                {isRunning ? "Testing model..." : "Run model test"}
              </Button>
            </div>

            {isRunning && (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}

            {result && !isRunning && (
              <div
                className="flex flex-col gap-4"
                data-testid="model-test-result"
              >
                <Alert
                  variant={result.ok ? "default" : "destructive"}
                  className={cn(
                    result.ok && "border-green-500/40 bg-green-500/5",
                  )}
                >
                  {result.ok ? (
                    <CheckCircle2 className="text-green-600 dark:text-green-500" />
                  ) : (
                    <XCircle />
                  )}
                  <AlertTitle>
                    {result.ok ? t("testPassed") : t("testFailed")}
                  </AlertTitle>
                  <AlertDescription className="whitespace-pre-wrap break-words">
                    {result.ok ? (
                      <span className="flex items-center gap-1.5">
                        <Zap className="size-3.5" />
                        {t("respondedIn", { ms: result.latencyMs })}
                      </span>
                    ) : (
                      result.error
                    )}
                  </AlertDescription>
                </Alert>

                {result.note && (
                  <Alert>
                    <AlertDescription className="text-xs">
                      {result.note}
                    </AlertDescription>
                  </Alert>
                )}

                {result.ok && (
                  <>
                    <ResultBlock title={t("modelReply")}>
                      <p className="font-mono text-sm whitespace-pre-wrap break-words">
                        {result.text || (
                          <span className="italic text-muted-foreground">
                            {t("noVisibleText")}
                          </span>
                        )}
                      </p>
                    </ResultBlock>

                    <ResultBlock
                      title={
                        <span className="flex items-center gap-1.5">
                          <Wrench className="size-3.5" />
                          {t("toolCalling")}
                        </span>
                      }
                    >
                      {result.toolCall?.supported ? (
                        <div className="space-y-2">
                          <Badge className="bg-green-500/10 text-green-600 dark:text-green-500 border-green-500/20">
                            {t("toolCallingSupported")}
                          </Badge>
                          <JsonView
                            data={{
                              tool: result.toolCall.name,
                              arguments: result.toolCall.arguments,
                            }}
                          />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Badge variant="secondary">
                            {t("toolCallingUnsupported")}
                          </Badge>
                          <p className="text-xs text-muted-foreground">
                            {result.toolCall?.error ?? t("toolCallingUnknown")}
                          </p>
                        </div>
                      )}
                    </ResultBlock>

                    {result.usage && (
                      <ResultBlock title={t("tokenUsage")}>
                        <div className="flex gap-4 text-sm">
                          <Stat
                            label={t("promptTokens")}
                            value={result.usage.PromptTokens}
                          />
                          <Stat
                            label={t("completionTokens")}
                            value={result.usage.CompletionTokens}
                          />
                          <Stat
                            label={t("totalTokens")}
                            value={result.usage.TotalTokens}
                          />
                        </div>
                      </ResultBlock>
                    )}
                  </>
                )}
              </div>
            )}

            {!result && !isRunning && (
              <div className="border border-dashed rounded-xl p-8 text-center text-sm text-muted-foreground">
                {t("runTestHint")}
              </div>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/admin/providers"
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 w-fit"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </Link>
  );
}

function ResultBlock({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border rounded-xl p-4 bg-secondary/30 min-w-0">
      <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}
