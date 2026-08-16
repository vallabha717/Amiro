"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Loader2, Plus, Box, Cpu } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "ui/button";
import { ScrollArea } from "ui/scroll-area";
import { Skeleton } from "ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { ProviderCard } from "@/components/provider-card";
import {
  PROVIDERS_KEY,
  selectProviders,
  type ProviderConfig,
} from "@/lib/backend/provider-api";

const LightRays = dynamic(() => import("@/components/ui/light-rays"), {
  ssr: false,
});

/**
 * Provider types offered in the "add" menu. `custom` is not a distinct
 * backend type -- it saves as `openai` with a required base URL, which is
 * what every OpenAI-compatible gateway (LiteLLM, Nous, vLLM, ...) actually
 * needs. See provider-editor.tsx.
 */
export const AVAILABLE_PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google Gemini" },
  { id: "xai", name: "xAI (Grok)" },
  { id: "groq", name: "Groq" },
  { id: "openRouter", name: "OpenRouter" },
] as const;

export default function AdminProvidersPage() {
  const t = useTranslations("Providers");
  const router = useRouter();

  const {
    data: providers,
    isLoading,
    isValidating,
  } = useSWR<ProviderConfig[]>(PROVIDERS_KEY, selectProviders, {
    fallbackData: [],
    revalidateOnFocus: false,
  });

  const handleCreateNew = (templateId: string) =>
    router.push(`/admin/providers/create?template=${templateId}`);

  const addMenu = (align: "end" | "center") => (
    <DropdownMenuContent align={align} className="w-56">
      {AVAILABLE_PROVIDERS.map((p) => (
        <DropdownMenuItem
          key={p.id}
          onClick={() => handleCreateNew(p.id)}
          className="cursor-pointer font-medium"
        >
          <ModelProviderIcon
            provider={p.id}
            className="size-4 mr-2 text-muted-foreground"
          />
          <span>{p.name}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem
        onClick={() => handleCreateNew("custom")}
        className="cursor-pointer font-medium border-t"
        data-testid="add-custom-provider"
      >
        <Box className="size-4 mr-2 text-muted-foreground" />
        <span>{t("customProvider")}</span>
      </DropdownMenuItem>
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
              {t("myProviders")}
              {isValidating && !isLoading && (
                <Loader2 className="size-4 animate-spin" />
              )}
            </h1>
            <div className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="font-semibold bg-input/20"
                  variant="outline"
                  data-testid="add-provider-button"
                >
                  <Plus className="size-3.5" />
                  {t("addProvider")}
                </Button>
              </DropdownMenuTrigger>
              {addMenu("end")}
            </DropdownMenu>
          </div>

          {isLoading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-60 w-full" />
              <Skeleton className="h-60 w-full" />
            </div>
          ) : providers?.length ? (
            <div
              className="flex flex-col gap-6 mb-4"
              data-testid="providers-section"
            >
              {providers.map((p) => (
                <ProviderCard key={p.id} {...p} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center space-y-4 my-20 text-center animate-in fade-in zoom-in duration-500">
              <div className="p-4 bg-muted/30 rounded-full border border-border/50">
                <Cpu className="w-12 h-12 text-muted-foreground" />
              </div>
              <h3 className="text-2xl md:text-3xl font-bold tracking-tight">
                {t("noProvidersTitle")}
              </h3>
              <p className="text-muted-foreground max-w-md text-lg">
                {t("noProvidersDescription")}
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="lg" className="mt-4 font-bold">
                    <Plus className="size-5 mr-2" />
                    {t("connectProvider")}
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
