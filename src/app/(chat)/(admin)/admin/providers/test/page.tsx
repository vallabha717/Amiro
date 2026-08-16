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

  const { data: providers, isLoading } = useSWR<ProviderConfig[]>(
    PROVIDERS_KEY,
    selectProviders,
  );

  const provider = useMemo(
    () => providers?.find((p) => p.id === id),
    [providers, id],
  );

  const [selectedModel, setSelectedModel] = useState<string | null>(modelParam);
  const [filter, setFilter] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);

  // Land on a usable model instead of an empty right pane when the card
  // linked here without naming one.
  useEffect(() => {
    if (!selectedModel && provider?.models?.length) {
      setSelectedModel(provider.models[0]);
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
    try {
      setResult(await testProviderModel(id, selectedModel));
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setIsRunning(false);
    }
  };

  if (isLoading) return <PageSkeleton />;

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
      <div className="pt-8 px-8 max-w-4xl mx-auto w-full pb-16 flex flex-col gap-6">
        <div>
          <BackLink label={t("backToProviders")} />
          <div className="flex items-center gap-3 mt-4">
            <div className="p-2.5 bg-background border rounded-xl text-primary shadow-sm">
              <ModelProviderIcon provider={provider.provider} className="size-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                {provider.name}
                <Badge variant="secondary" className="text-[10px]">
                  {provider.provider}
                </Badge>
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("modelTestDescription")}
              </p>
            </div>
          </div>
        </div>

        <Separator />

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* Model picker */}
          <div className="flex flex-col gap-3 min-w-0">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {t("availableModels")} ({models.length})
            </h2>

            {models.length > 8 && (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("filterModels")}
                  className="h-8 pl-7 text-xs"
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto pr-1">
              {visibleModels.length === 0 ? (
                <p className="text-sm text-muted-foreground italic p-2">
                  {models.length === 0
                    ? t("noModelsConfigured")
                    : t("noModelsMatchFilter")}
                </p>
              ) : (
                visibleModels.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => {
                      setSelectedModel(model);
                      setResult(null);
                    }}
                    className={cn(
                      "text-left text-sm rounded-md px-3 py-2 transition-colors truncate border",
                      selectedModel === model
                        ? "bg-primary/10 border-primary/40 font-medium"
                        : "bg-secondary/50 border-transparent hover:bg-input",
                    )}
                    data-testid="test-model-option"
                  >
                    {model}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Result pane */}
          <div className="flex flex-col gap-4 min-w-0">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {t("selectedModel")}
                </p>
                <p className="font-mono text-sm truncate">
                  {selectedModel ?? "—"}
                </p>
              </div>
              <Button
                onClick={runTest}
                disabled={!selectedModel || isRunning}
                className="font-semibold shrink-0"
                data-testid="run-model-test"
              >
                {isRunning ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <FlaskConical className="size-4 mr-2" />
                )}
                {t("runTest")}
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
