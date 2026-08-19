"use client";

import SearchProviderEditor from "@/components/search-provider-editor";
import {
  SEARCH_PROVIDERS_KEY,
  type SearchProviderConfig,
  selectSearchProviders,
} from "@/lib/backend/search-provider-api";
import { Settings2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ScrollArea } from "ui/scroll-area";
import { Skeleton } from "ui/skeleton";

const LightRays = dynamic(() => import("@/components/ui/light-rays"), {
  ssr: false,
});

export default function ModifySearchProviderPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const { data: providers, isLoading } = useSWR<SearchProviderConfig[]>(
    SEARCH_PROVIDERS_KEY,
    selectSearchProviders,
  );

  const provider = providers?.find((p) => p.id === id);

  return (
    <>
      <div className="absolute opacity-30 pointer-events-none top-0 left-0 w-full h-full z-10">
        <LightRays className="bg-transparent" />
      </div>
      <ScrollArea className="h-full w-full z-40">
        <div className="pt-8 flex-1 relative flex flex-col gap-6 px-8 max-w-4xl h-full mx-auto pb-8">
          <div className="flex items-center pb-4 border-b border-border/50">
            <div className="space-y-1">
              <h1 className="text-3xl font-extrabold flex items-center gap-2">
                <Settings2 className="w-8 h-8 text-primary" />
                Modify Search Provider
              </h1>
              <p className="text-muted-foreground">
                Update the configuration for this search provider connection.
              </p>
            </div>
          </div>

          <div className="bg-card/40 backdrop-blur-md border rounded-xl p-6 shadow-sm">
            {isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-full max-w-md" />
                <Skeleton className="h-10 w-full max-w-md" />
                <Skeleton className="h-20 w-full max-w-md" />
              </div>
            ) : provider ? (
              <SearchProviderEditor initialConfig={provider} />
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                Provider not found
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
