"use client";

import ProviderEditor from "@/components/provider-editor";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Settings2, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import useSWR from "swr";
import {
  PROVIDERS_KEY,
  selectProviders,
  type ProviderConfig,
} from "@/lib/backend/provider-api";

const LightRays = dynamic(() => import("@/components/ui/light-rays"), {
  ssr: false,
});

export default function ModifyProviderPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  // We reuse the list endpoint to find the exact provider config since it's
  // small -- and it shares SWR's cache with the providers page, so an edit
  // opened from a card renders without a second round trip.
  const { data: providers, isLoading } = useSWR<ProviderConfig[]>(
    PROVIDERS_KEY,
    selectProviders,
  );

  const initialConfig = useMemo(
    () => (id ? providers?.find((p) => p.id === id) : undefined),
    [providers, id],
  );

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
                Modify Provider
              </h1>
              <p className="text-muted-foreground">
                Update the configuration for this AI model provider.
              </p>
            </div>
          </div>
          
          <div className="bg-card/40 backdrop-blur-md border rounded-xl p-6 shadow-sm">
            {isLoading ? (
              <div className="flex justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : initialConfig ? (
              <ProviderEditor initialConfig={initialConfig} />
            ) : (
              <div className="text-center py-10 text-muted-foreground">
                Configuration not found.
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
