"use client";

import {
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  Loader2,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import useSWR from "swr";

import { cn } from "lib/utils";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { ScrollArea } from "ui/scroll-area";
import { Separator } from "ui/separator";
import { handleErrorWithToast } from "ui/shared-toast";
import { Skeleton } from "ui/skeleton";

import {
  SEARCH_PROVIDERS_KEY,
  type SearchProviderConfig,
  type SearchProviderTestResult,
  selectSearchProviders,
  testSearchProvider,
} from "@/lib/backend/search-provider-api";

export default function SearchProviderTestPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SearchProviderTest />
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

function SearchProviderTest() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const { data: providers, isLoading } = useSWR<SearchProviderConfig[]>(
    SEARCH_PROVIDERS_KEY,
    selectSearchProviders,
  );

  const provider = useMemo(
    () => providers?.find((p) => p.id === id),
    [providers, id],
  );

  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<SearchProviderTestResult | null>(null);

  const runTest = async () => {
    if (!id) return;
    setIsRunning(true);
    setResult(null);
    try {
      setResult(await testSearchProvider(id));
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
        <BackLink label="Back to Search Providers" />
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>Search Provider Not Found</AlertTitle>
          <AlertDescription>
            The requested search provider configuration could not be found.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="pt-8 px-8 max-w-4xl mx-auto w-full pb-16 flex flex-col gap-6">
        <div>
          <BackLink label="Back to Search Providers" />
          <div className="flex items-center gap-3 mt-4">
            <div className="p-2.5 bg-background border rounded-xl text-primary shadow-sm">
              <FlaskConical className="size-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                {provider.name}
                <Badge variant="secondary" className="text-[10px]">
                  {provider.provider}
                </Badge>
              </h1>
              <p className="text-sm text-muted-foreground">
                Run a live connectivity test to verify your search provider
                configuration.
              </p>
            </div>
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Button
              onClick={runTest}
              disabled={isRunning}
              className="font-semibold"
              data-testid="run-search-test"
            >
              {isRunning ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <FlaskConical className="size-4 mr-2" />
              )}
              Run Connectivity Test
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
              data-testid="search-test-result"
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
                  {result.ok ? "Connection Successful" : "Connection Failed"}
                </AlertTitle>
                <AlertDescription className="whitespace-pre-wrap break-words">
                  {result.ok ? (
                    <span className="flex items-center gap-1.5">
                      <Zap className="size-3.5" />
                      Responded in {result.latencyMs}ms with {result.count}{" "}
                      search results.
                    </span>
                  ) : (
                    result.error
                  )}
                </AlertDescription>
              </Alert>
            </div>
          )}

          {!result && !isRunning && (
            <div className="border border-dashed rounded-xl p-8 text-center text-sm text-muted-foreground">
              Click the button above to run a live test query.
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/admin/search"
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 w-fit"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </Link>
  );
}
