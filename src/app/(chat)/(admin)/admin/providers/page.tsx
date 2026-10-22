"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { agentScopedPath } from "@/components/team/team-paths";
import { useAgentScope } from "@/lib/backend/agent-scope";
import useSWR from "swr";
import { Loader2, Plus, Box, Cpu } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { ScrollArea } from "ui/scroll-area";
import { Skeleton } from "ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "ui/command";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { ProviderCard } from "@/components/provider-card";
import {
  LoginPanel,
  type CatalogProvider,
  CATALOG_KEY,
  loadCatalogProviders,
  mechanismOf,
  isConfigured,
  providerLabel,
  MECHANISM_LABEL,
  MECHANISM_ORDER,
} from "@/components/chat/login-panel";
import {
  PROVIDERS_KEY,
  selectProviders,
  type ProviderConfig,
} from "@/lib/backend/provider-api";
import { appStore } from "@/app/store";

const LightRays = dynamic(() => import("@/components/ui/light-rays"), {
  ssr: false,
});

export default function AdminProvidersPage() {
  const t = useTranslations("Providers");
  const router = useRouter();
  const agentScope = useAgentScope();

  const [loginProviderId, setLoginProviderId] = useState<string | null>(null);
  const [isLoginPanelOpen, setIsLoginPanelOpen] = useState(false);
  const [openHeaderMenu, setOpenHeaderMenu] = useState(false);
  const [openEmptyMenu, setOpenEmptyMenu] = useState(false);

  const {
    data: providers,
    isLoading,
    isValidating,
  } = useSWR<ProviderConfig[]>(PROVIDERS_KEY, selectProviders, {
    fallbackData: [],
    revalidateOnFocus: false,
  });

  const {
    data: catalogProviders = [],
    isLoading: isCatalogLoading,
  } = useSWR<CatalogProvider[]>(`catalog:${CATALOG_KEY}`, loadCatalogProviders, {
    fallbackData: [],
    revalidateOnFocus: false,
  });

  const groupedProviders = useMemo(() => {
    const groups = new Map<string, CatalogProvider[]>();
    for (const p of catalogProviders) {
      const m = mechanismOf(p);
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m)!.push(p);
    }
    const ordered: Array<[string, CatalogProvider[]]> = [];
    for (const m of MECHANISM_ORDER) {
      const list = groups.get(m);
      if (list && list.length) {
        list.sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
        ordered.push([m, list]);
      }
    }
    for (const [m, list] of groups) {
      if (!MECHANISM_ORDER.includes(m)) {
        list.sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
        ordered.push([m, list]);
      }
    }
    return ordered;
  }, [catalogProviders]);

  const handleSelectProvider = (providerId: string) => {
    setOpenHeaderMenu(false);
    setOpenEmptyMenu(false);
    if (providerId === "custom" || providerId === "openai-compatible") {
      router.push(
        agentScopedPath(agentScope, `/admin/providers/create?template=${providerId}`),
      );
      return;
    }
    setLoginProviderId(providerId);
    setIsLoginPanelOpen(true);
  };

  const renderAddMenu = (
    align: "end" | "center",
    open: boolean,
    onOpenChange: (open: boolean) => void,
    trigger: React.ReactNode,
  ) => (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-80 sm:w-96 p-0"
        data-testid="admin-add-provider-menu"
      >
        <Command className="rounded-lg shadow-md max-h-[460px]">
          <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground border-b bg-muted/20">
            <span
              data-testid="admin-provider-count"
              className="font-semibold flex items-center gap-1.5"
            >
              {isCatalogLoading && catalogProviders.length === 0 ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  Loading providers...
                </>
              ) : (
                `${catalogProviders.length} providers`
              )}
            </span>
            <span>
              {catalogProviders.filter(isConfigured).length} connected
            </span>
          </div>
          <CommandInput
            placeholder="Search providers..."
            data-testid="admin-provider-search"
          />
          <CommandList className="max-h-72 overflow-y-auto p-1">
            <CommandEmpty className="p-4 text-center text-xs text-muted-foreground">
              No providers found.
            </CommandEmpty>
            <CommandGroup heading="Custom gateway">
              <CommandItem
                value="custom custom provider openai-compatible base url self-hosted gateway"
                onSelect={() => handleSelectProvider("custom")}
                className="cursor-pointer text-xs flex items-center gap-2"
                data-testid="add-custom-provider"
              >
                <Box className="size-4 mr-1 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{t("customProvider")}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    OpenAI-compatible base URL & models
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className="text-[9px] px-1 py-0 h-4 shrink-0 ml-auto"
                >
                  Custom URL
                </Badge>
              </CommandItem>
            </CommandGroup>
            {groupedProviders.map(([mechanism, list]) => (
              <CommandGroup
                key={mechanism}
                heading={`${MECHANISM_LABEL[mechanism] ?? mechanism} · ${list.length}`}
              >
                {list.map((p) => {
                  const label = providerLabel(p);
                  const isConnected = isConfigured(p);
                  const mech = mechanismOf(p);
                  return (
                    <CommandItem
                      key={p.id}
                      value={`${label} ${p.id} ${mech} ${(p.aliases || []).join(" ")}`.toLowerCase()}
                      onSelect={() => handleSelectProvider(p.id)}
                      className="cursor-pointer text-xs flex items-center gap-2"
                      data-testid={`admin-provider-option-${p.id}`}
                    >
                      <ModelProviderIcon
                        provider={p.id}
                        className="size-4 mr-1 text-muted-foreground shrink-0"
                      />
                      <span className="font-medium truncate flex-1 min-w-0">
                        {label}
                      </span>
                      <Badge
                        variant={isConnected ? "secondary" : "outline"}
                        className="text-[9px] px-1 py-0 h-4 shrink-0"
                      >
                        {isConnected ? "Connected" : "Not connected"}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-1">
                        {MECHANISM_LABEL[mech] ?? mech}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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

  const currentChatModel = appStore((state) => state.chatModel);
  const activeDefaultChatModel =
    currentChatModel?.model ||
    providers?.find((p) => p.selectedModel)?.selectedModel ||
    providers?.[0]?.models?.[0] ||
    "default";
  const activeDefaultChatProvider =
    currentChatModel?.provider ||
    providers?.find((p) => p.selectedModel)?.name ||
    providers?.[0]?.name;

  return (
    <>
      {particle}
      <ScrollArea className="h-full w-full z-40">
        <div className="pt-8 flex-1 relative flex flex-col gap-4 px-8 max-w-3xl h-full mx-auto pb-8">
          <div className="flex items-center pb-4">
            <h1 className="text-2xl font-bold flex items-center gap-2">
              {t("myProviders")}
              {isValidating && !isLoading && (
                <Loader2 className="size-4 animate-spin" />
              )}
            </h1>
            <div className="flex-1" />
            {renderAddMenu(
              "end",
              openHeaderMenu,
              setOpenHeaderMenu,
              <Button
                className="font-semibold bg-input/20"
                variant="outline"
                data-testid="add-provider-button"
              >
                <Plus className="size-3.5" />
                {t("addProvider")}
              </Button>,
            )}
          </div>

          {/* Active Default Summary */}
          {providers && providers.length > 0 && (
            <div
              data-testid="providers-active-default-summary"
              className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground mb-2"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-foreground">
                  {providers.length}{" "}
                  {providers.length === 1 ? "provider" : "providers"} connected
                </span>
                <span>•</span>
                <span>
                  Active chat default:{" "}
                  <strong className="text-foreground font-mono">
                    {activeDefaultChatModel}
                  </strong>
                  {activeDefaultChatProvider && (
                    <span className="ml-1 text-muted-foreground">
                      ({activeDefaultChatProvider})
                    </span>
                  )}
                </span>
              </div>
              <Badge
                variant="outline"
                className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5 shrink-0"
              >
                Active
              </Badge>
            </div>
          )}

          {isLoginPanelOpen && (
            <div className="mb-4">
              <LoginPanel
                initialProviderId={loginProviderId ?? undefined}
                onClose={() => {
                  setIsLoginPanelOpen(false);
                  setLoginProviderId(null);
                }}
              />
            </div>
          )}

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
              {renderAddMenu(
                "center",
                openEmptyMenu,
                setOpenEmptyMenu,
                <Button size="lg" className="mt-4 font-bold" data-testid="connect-provider-button">
                  <Plus className="size-5 mr-2" />
                  {t("connectProvider")}
                </Button>,
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
