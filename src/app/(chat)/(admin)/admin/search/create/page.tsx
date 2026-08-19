"use client";

import SearchProviderEditor from "@/components/search-provider-editor";
import { Settings2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { ScrollArea } from "ui/scroll-area";

const LightRays = dynamic(() => import("@/components/ui/light-rays"), {
  ssr: false,
});

export default function CreateSearchProviderPage() {
  const searchParams = useSearchParams();
  const templateProvider = searchParams.get("template") || "duckduckgo";

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
                Add Search Provider
              </h1>
              <p className="text-muted-foreground">
                Configure a new web search provider connection.
              </p>
            </div>
          </div>

          <div className="bg-card/40 backdrop-blur-md border rounded-xl p-6 shadow-sm">
            <SearchProviderEditor templateProvider={templateProvider} />
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
