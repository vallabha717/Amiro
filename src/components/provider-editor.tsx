"use client";

import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  Eye,
  EyeOff,
  KeySquare,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { handleErrorWithToast } from "ui/shared-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import {
  PROVIDERS_KEY,
  fetchProviderModels,
  saveProvider,
  type ProviderConfig,
} from "@/lib/backend/provider-api";
import { AVAILABLE_PROVIDERS } from "@/app/(chat)/(admin)/admin/providers/page";

/**
 * Provider types that get a base URL field.
 *
 * OpenAI is here because "OpenAI-compatible endpoint" is the single most
 * common self-hosted/gateway shape (LiteLLM, vLLM, Nous, Together, ...), and
 * `custom` *is* that case with no pretense of being api.openai.com. The rest
 * are hosted-only in this app, so offering a base URL there would just be a
 * field to get wrong.
 */
const BASE_URL_PROVIDERS = new Set(["openai", "custom"]);

export interface ProviderEditorProps {
  initialConfig?: ProviderConfig;
  /** Pre-selected type when creating; "custom" means OpenAI-compatible. */
  templateProvider?: string;
}

export default function ProviderEditor({
  initialConfig,
  templateProvider,
}: ProviderEditorProps) {
  const t = useTranslations("Providers");
  const router = useRouter();
  const isNew = !initialConfig?.id;

  const [isCustom, setIsCustom] = useState(templateProvider === "custom");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [revealKey, setRevealKey] = useState(false);

  const [name, setName] = useState(initialConfig?.name ?? "");
  const [providerType, setProviderType] = useState(
    initialConfig?.provider ??
      (templateProvider === "custom" ? "openai" : (templateProvider ?? "openai")),
  );
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "");
  const [models, setModels] = useState<string[]>(initialConfig?.models ?? []);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [newModelInput, setNewModelInput] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const searchContainerRef = useRef<HTMLDivElement>(null);

  const showBaseUrl = isCustom || BASE_URL_PROVIDERS.has(providerType);

  // Close suggestions dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  // Fetch available models dynamically from provider endpoint
  const loadProviderModels = useCallback(async () => {
    // Only attempt fetch if we have an existing ID or key (or default provider)
    if (isNew && !apiKey.trim() && !baseUrl.trim()) {
      return;
    }
    if (isCustom && !baseUrl.trim()) {
      return;
    }

    setIsLoadingModels(true);
    try {
      const data = await fetchProviderModels({
        id: initialConfig?.id,
        provider: isCustom ? "openai" : providerType,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
      });
      if (data.models && Array.isArray(data.models)) {
        setRemoteModels(data.models);
      }
    } catch {
      // Silently catch in-background; user can still enter models manually
    } finally {
      setIsLoadingModels(false);
    }
  }, [initialConfig?.id, isNew, isCustom, providerType, apiKey, baseUrl]);

  // Automatically fetch models on mount or when credentials/provider change
  useEffect(() => {
    const timer = setTimeout(() => {
      loadProviderModels();
    }, 400);
    return () => clearTimeout(timer);
  }, [loadProviderModels]);

  // Combined pool of available models: models fetched live from provider endpoint + any already permitted
  const allAvailableModels = useMemo(() => {
    return Array.from(new Set([...remoteModels, ...models]));
  }, [remoteModels, models]);

  // Real-time filtered suggestions based on typing in the model input
  const filteredSuggestions = useMemo(() => {
    const query = newModelInput.trim().toLowerCase();
    if (!query) {
      return allAvailableModels;
    }
    return allAvailableModels.filter((m) =>
      m.toLowerCase().includes(query),
    );
  }, [allAvailableModels, newModelInput]);

  // Unadded matching models in current filtered set
  const unaddedMatching = useMemo(() => {
    return filteredSuggestions.filter((m) => !models.includes(m));
  }, [filteredSuggestions, models]);

  // Permitted models filtered by in-list search filter
  const visiblePermittedModels = useMemo(() => {
    const needle = modelFilter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((m) => m.toLowerCase().includes(needle));
  }, [models, modelFilter]);

  const handleSave = async () => {
    if (!name.trim()) return toast.error(t("errorNameRequired"));
    if (isNew && !apiKey.trim()) return toast.error(t("errorKeyRequired"));
    if (isCustom && !baseUrl.trim()) return toast.error(t("errorBaseUrlRequired"));

    setIsSaving(true);
    try {
      await saveProvider({
        id: initialConfig?.id,
        name: name.trim(),
        provider: providerType,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        models,
      });
      // Both the admin list and the chat model selector read from this.
      await Promise.all([mutate(PROVIDERS_KEY), mutate("/api/chat/models")]);
      toast.success(t("providerSaved"));
      router.push("/admin/providers");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setIsSaving(false);
    }
  };

  const addModel = (modelName?: string) => {
    const value = (modelName ?? newModelInput).trim();
    if (!value) return;
    if (models.includes(value)) {
      toast.warning(t("modelAlreadyAdded"));
      return;
    }
    setModels((prev) => [...prev, value]);
    setNewModelInput("");
  };

  const toggleModel = (modelName: string) => {
    if (models.includes(modelName)) {
      setModels((prev) => prev.filter((m) => m !== modelName));
    } else {
      setModels((prev) => [...prev, modelName]);
    }
  };

  const handleAddAllFiltered = () => {
    if (unaddedMatching.length === 0) return;
    setModels((prev) => Array.from(new Set([...prev, ...unaddedMatching])));
    toast.success(t("modelsAdded", { count: unaddedMatching.length }));
  };

  const handleClearAllModels = () => {
    if (models.length === 0) return;
    setModels([]);
    setModelFilter("");
  };

  const removeModel = (model: string) =>
    setModels((prev) => prev.filter((m) => m !== model));

  const selectedProviderName = isCustom
    ? t("customProvider")
    : (AVAILABLE_PROVIDERS.find((p) => p.id === providerType)?.name ??
      providerType);

  const exactInputMatch = allAvailableModels.some(
    (m) => m.toLowerCase() === newModelInput.trim().toLowerCase(),
  );

  return (
    <div className="flex flex-col space-y-8 animate-in fade-in duration-500">
      <div className="space-y-2">
        <Label htmlFor="name" className="text-sm font-semibold">
          {t("configurationName")}
        </Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("configurationNamePlaceholder")}
          className="max-w-md bg-background/50 shadow-sm"
          data-testid="provider-name-input"
        />
        <p className="text-xs text-muted-foreground">
          {t("configurationNameHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-semibold">{t("providerType")}</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full max-w-md justify-between bg-background/50 cursor-pointer"
              disabled={!isNew}
              data-testid="provider-type-trigger"
            >
              <div className="flex items-center gap-2">
                <ModelProviderIcon
                  provider={isCustom ? "custom" : providerType}
                  className="size-4"
                />
                <span>{selectedProviderName}</span>
              </div>
              {isNew && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  {t("change")}
                  <ChevronDown className="size-3.5" />
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          {isNew && (
            <DropdownMenuContent className="w-[300px]">
              {AVAILABLE_PROVIDERS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => {
                    setProviderType(p.id);
                    setIsCustom(false);
                    setRemoteModels([]);
                  }}
                  className="cursor-pointer"
                >
                  <ModelProviderIcon provider={p.id} className="size-4 mr-2" />
                  <span>{p.name}</span>
                  {!isCustom && providerType === p.id && (
                    <Check className="ml-auto size-4" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() => {
                  setProviderType("openai");
                  setIsCustom(true);
                  setRemoteModels([]);
                }}
                className="cursor-pointer border-t"
              >
                <Box className="size-4 mr-2" />
                <span>{t("customProvider")}</span>
                {isCustom && <Check className="ml-auto size-4" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          )}
        </DropdownMenu>
        {isCustom && (
          <p className="text-xs text-muted-foreground max-w-md">
            {t("customProviderHint")}
          </p>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label
              htmlFor="api-key"
              className="flex items-center gap-2 font-medium"
            >
              <KeySquare className="w-4 h-4 text-primary" /> {t("apiKey")}
            </Label>
            <div className="relative">
              <Input
                id="api-key"
                type={revealKey ? "text" : "password"}
                placeholder={isNew ? "sk-..." : t("apiKeyKeepPlaceholder")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="bg-background/50 shadow-sm pr-10"
                autoComplete="off"
                data-testid="provider-key-input"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 size-7 text-muted-foreground hover:text-foreground cursor-pointer"
                onClick={() => setRevealKey((v) => !v)}
                aria-label={revealKey ? t("hideKey") : t("showKey")}
                data-testid="provider-key-reveal"
              >
                {revealKey ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </Button>
            </div>
            {!isNew && (
              <p className="text-xs text-muted-foreground">
                {t("apiKeyEditHint")}
              </p>
            )}
          </div>

          {showBaseUrl && (
            <div className="space-y-2">
              <Label
                htmlFor="base-url"
                className="flex items-center gap-2 font-medium"
              >
                <Link2 className="w-4 h-4 text-primary" /> {t("baseUrl")}
                <span className="text-muted-foreground font-normal">
                  {isCustom ? t("required") : t("optional")}
                </span>
              </Label>
              <Input
                id="base-url"
                type="url"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="bg-background/50 shadow-sm"
                data-testid="provider-baseurl-input"
              />
              <p className="text-xs text-muted-foreground">
                {t("baseUrlHint")}
              </p>
            </div>
          )}
        </div>

        {/* Permitted Models & Interactive Filter/Selection Box */}
        <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label className="flex items-center gap-2 font-medium text-sm">
                  <Box className="w-4 h-4 text-primary" /> {t("permittedModels")}
                </Label>
                {models.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 font-semibold">
                    {models.length}
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-1">
                {isLoadingModels && (
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground mr-1">
                    <Loader2 className="size-3 animate-spin text-primary" />
                    <span>Fetching models...</span>
                  </div>
                )}
                {models.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleClearAllModels}
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive cursor-pointer"
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    {t("clearAll")}
                  </Button>
                )}
              </div>
            </div>

            {/* In-list filter when list has many models */}
            {models.length > 6 && (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder={t("filterModels")}
                  className="h-8 pl-7 bg-background/50 text-xs"
                />
              </div>
            )}

            {/* Currently Permitted Models Badges */}
            <div className="flex flex-wrap gap-1.5 min-h-[72px] max-h-[220px] overflow-y-auto p-2 border border-border/50 rounded-md bg-background/50 items-start content-start">
              {models.length === 0 ? (
                <div className="text-xs text-muted-foreground p-3 italic flex-1 text-center">
                  {t("noModelsYet")}
                </div>
              ) : visiblePermittedModels.length === 0 ? (
                <div className="text-xs text-muted-foreground p-3 italic flex-1 text-center">
                  {t("noModelsMatchFilter")}
                </div>
              ) : (
                visiblePermittedModels.map((m) => (
                  <Badge
                    key={m}
                    variant="secondary"
                    className="pl-2 pr-1 py-1 flex items-center gap-1.5 shadow-sm font-medium border-border/60 text-xs hover:border-border"
                  >
                    <span className="truncate max-w-[200px]">{m}</span>
                    <button
                      type="button"
                      onClick={() => removeModel(m)}
                      className="hover:bg-destructive/10 hover:text-destructive rounded-full p-0.5 transition-colors shrink-0 cursor-pointer"
                      aria-label={`Remove ${m}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))
              )}
            </div>
          </div>

          {/* Interactive Search & Multi-Select Autocomplete Bar */}
          <div className="space-y-2 pt-2" ref={searchContainerRef}>
            <div className="relative">
              <div className="relative flex items-center">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder={t("addModelPlaceholder")}
                  value={newModelInput}
                  onChange={(e) => {
                    setNewModelInput(e.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addModel();
                      setShowSuggestions(false);
                    } else if (e.key === "Escape") {
                      setShowSuggestions(false);
                    }
                  }}
                  className="h-10 pl-9 pr-20 bg-background/70 shadow-sm text-sm"
                  data-testid="provider-add-model-input"
                />
                {newModelInput.trim() && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setNewModelInput("")}
                    type="button"
                    className="absolute right-12 top-1/2 -translate-y-1/2 size-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    addModel();
                    setShowSuggestions(false);
                  }}
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 px-2.5 shadow-xs font-semibold text-xs cursor-pointer"
                >
                  <Plus className="size-3.5 mr-1" />
                  {t("add")}
                </Button>
              </div>

              {/* Suggestions Panel / Dropdown */}
              {showSuggestions && (
                <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border bg-popover text-popover-foreground shadow-xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100">
                  {/* Action Bar inside Suggestions */}
                  <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30 text-xs">
                    <span className="font-medium text-muted-foreground flex items-center gap-1.5">
                      <Sparkles className="size-3.5 text-primary" />
                      {newModelInput.trim()
                        ? t("availableModelsMatching", {
                            count: filteredSuggestions.length,
                            query: newModelInput.trim(),
                          })
                        : `${filteredSuggestions.length} ${t("availableCatalogModels")}`}
                    </span>

                    <div className="flex items-center gap-1.5">
                      {filteredSuggestions.length > 0 && (
                        <div>
                          {unaddedMatching.length > 0 ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={handleAddAllFiltered}
                              className="h-6 px-2 text-[11px] font-semibold bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer"
                            >
                              <CheckCheck className="size-3 mr-1" />
                              {t("selectAllFiltered", {
                                count: unaddedMatching.length,
                              })}
                            </Button>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20">
                              <Check className="size-3 mr-1" />
                              {t("allSelected")}
                            </Badge>
                          )}
                        </div>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={loadProviderModels}
                        className="size-6 text-muted-foreground hover:text-foreground cursor-pointer"
                        title="Refresh models from provider endpoint"
                      >
                        <RefreshCw className={`size-3 ${isLoadingModels ? "animate-spin" : ""}`} />
                      </Button>
                    </div>
                  </div>

                  {/* Suggestions List */}
                  <div className="max-h-[220px] overflow-y-auto p-1 divide-y divide-border/20">
                    {/* Option to add custom typed model if not an exact match */}
                    {newModelInput.trim() && !exactInputMatch && (
                      <div
                        onClick={() => {
                          addModel(newModelInput.trim());
                          setShowSuggestions(false);
                        }}
                        className="flex items-center justify-between p-2 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer text-xs font-medium text-primary"
                      >
                        <div className="flex items-center gap-2">
                          <Plus className="size-4" />
                          <span>
                            {t("addCustomModel", {
                              model: newModelInput.trim(),
                            })}
                          </span>
                        </div>
                        <Badge variant="outline" className="text-[10px]">
                          Enter ↵
                        </Badge>
                      </div>
                    )}

                    {filteredSuggestions.length === 0 && !newModelInput.trim() ? (
                      <div className="p-4 text-center text-xs text-muted-foreground italic">
                        {isLoadingModels ? "Fetching available models from provider endpoint..." : "No models found from provider. Type an ID above to add."}
                      </div>
                    ) : (
                      filteredSuggestions.map((item) => {
                        const isSelected = models.includes(item);
                        return (
                          <div
                            key={item}
                            onClick={() => toggleModel(item)}
                            className="flex items-center justify-between p-2 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors text-xs"
                          >
                            <div className="flex items-center gap-2.5 truncate">
                              <div
                                className={`size-4 rounded flex items-center justify-center border transition-colors ${
                                  isSelected
                                    ? "bg-primary border-primary text-primary-foreground"
                                    : "border-muted-foreground/40 hover:border-primary"
                                }`}
                              >
                                {isSelected && <Check className="size-3 stroke-[3]" />}
                              </div>
                              <span
                                className={`truncate font-mono ${
                                  isSelected
                                    ? "font-semibold text-foreground"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {item}
                              </span>
                            </div>

                            {isSelected ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 bg-primary/10 text-primary border-transparent"
                              >
                                Added
                              </Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  addModel(item);
                                }}
                              >
                                <Plus className="size-3" />
                              </Button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground">
              {t("permittedModelsHint")}
            </p>
          </div>
        </div>
      </div>

      <div className="pt-4 flex justify-end gap-3">
        <Button
          variant="ghost"
          onClick={() => router.push("/admin/providers")}
          className="font-semibold cursor-pointer"
        >
          {t("cancel")}
        </Button>
        <Button
          onClick={handleSave}
          disabled={isSaving || !name.trim()}
          className="min-w-[120px] font-bold shadow-md cursor-pointer"
          data-testid="provider-save-button"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("saveConfiguration")}
        </Button>
      </div>
    </div>
  );
}
