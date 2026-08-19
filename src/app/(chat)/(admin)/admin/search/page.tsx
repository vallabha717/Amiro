"use client";

import { Globe, Loader2, Plus, Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import useSWR from "swr";

import { SearchProviderCard } from "@/components/search-provider-card";
import {
  SEARCH_CATALOG_KEY,
  SEARCH_PROVIDERS_KEY,
  type SearchProviderConfig,
  type SearchProviderSpec,
  selectSearchCatalog,
  selectSearchProviders,
} from "@/lib/backend/search-provider-api";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { ScrollArea } from "ui/scroll-area";
import { Skeleton } from "ui/skeleton";

const LightRays = dynamic(() => import("@/components/ui/light-rays"), {
  ssr: false,
});

export default function AdminSearchProvidersPage() {
  const router = useRouter();

  const {
    data: providers,
    isLoading,
    isValidating,
  } = useSWR<SearchProviderConfig[]>(
    SEARCH_PROVIDERS_KEY,
    selectSearchProviders,
    {
      fallbackData: [],
      revalidateOnFocus: false,
    },
  );

  // The picker is served by the Go registry, so a provider added there
  // appears here without a second list to keep in step.
  const { data: catalog = [] } = useSWR<SearchProviderSpec[]>(
    SEARCH_CATALOG_KEY,
    selectSearchCatalog,
    { revalidateOnFocus: false },
  );

  const handleCreateNew = (templateId: string) =>
    router.push(`/admin/search/create?template=${templateId}`);

  const addMenu = (align: "end" | "center") => (
    <DropdownMenuContent align={align} className="w-72">
      {catalog.map((p) => (
        <DropdownMenuItem
          key={p.kind}
          onClick={() => handleCreateNew(p.kind)}
          className="cursor-pointer items-start gap-2 py-2"
        >
          <Search className="size-4 mt-0.5 text-primary shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{p.label}</p>
            <p className="text-xs text-muted-foreground">{p.freeTier}</p>
          </div>
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );

  const particle = useMemo(
    () => (
      <>
        <div className="absolute opacity-30 pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <LightRays className="bg-transparent" />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <div className="w-full h-full bg-gradient-to-t from-background to-50% to-transparent z-20" />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <div className="w-full h-full bg-gradient-to-l from-background to-20% to-transparent z-20" />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <div className="w-full h-full bg-gradient-to-r from-background to-20% to-transparent z-20" />
        </div>
      </>
    ),
    [],
  );

  return (
    <>
      {particle}
      <ScrollArea className="h-full w-full z-40">
        <div className="pt-8 flex-1 relative flex flex-col gap-4 px-8 max-w-3xl h-full mx-auto pb-8">
          <div className="flex items-center pb-8">
            <h1 className="text-2xl font-bold flex items-center gap-2">
              Search Providers
              {isValidating && !isLoading && (
                <Loader2 className="size-4 animate-spin" />
              )}
            </h1>
            <div className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="font-semibold bg-input/20 cursor-pointer"
                  variant="outline"
                  data-testid="add-search-provider-button"
                >
                  <Plus className="size-3.5 mr-1" />
                  Add Provider
                </Button>
              </DropdownMenuTrigger>
              {addMenu("end")}
            </DropdownMenu>
          </div>

          {isLoading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : providers?.length ? (
            <div
              className="flex flex-col gap-6 mb-4"
              data-testid="search-providers-section"
            >
              {providers.map((p) => (
                <SearchProviderCard key={p.id} {...p} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center space-y-4 my-20 text-center animate-in fade-in zoom-in duration-500">
              <div className="p-4 bg-muted/30 rounded-full border border-border/50 shadow-inner">
                <Globe className="w-12 h-12 text-muted-foreground" />
              </div>
              <h3 className="text-2xl md:text-3xl font-bold tracking-tight">
                No Search Providers configured
              </h3>
              <p className="text-muted-foreground max-w-md text-lg">
                Connect a web search provider to allow your agent to browse the
                internet for real-time information.
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="lg"
                    className="mt-4 font-bold shadow-md cursor-pointer"
                  >
                    <Plus className="size-5 mr-2" />
                    Configure Provider
                  </Button>
                </DropdownMenuTrigger>
                {addMenu("center")}
              </DropdownMenu>
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
