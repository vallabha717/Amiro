"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Box,
  Check,
  CloudDownload,
  Eye,
  EyeOff,
  KeySquare,
  Link2,
  Loader2,
  Search,
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

  // "custom" only exists in the form: it saves as an `openai` type whose base
  // URL points somewhere else. Reopening such a config shows it as OpenAI
  // with a base URL, which is exactly what it is.
  const [isCustom, setIsCustom] = useState(templateProvider === "custom");

  const [isSaving, setIsSaving] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [revealKey, setRevealKey] = useState(false);

  const [name, setName] = useState(initialConfig?.name ?? "");
  const [providerType, setProviderType] = useState(
    initialConfig?.provider ??
      (templateProvider === "custom" ? "openai" : (templateProvider ?? "openai")),
  );
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "");
  const [models, setModels] = useState<string[]>(initialConfig?.models ?? []);
  const [newModelInput, setNewModelInput] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  const showBaseUrl = isCustom || BASE_URL_PROVIDERS.has(providerType);

  // A sync against a large gateway can return several hundred ids, so the
  // list needs to be filterable to stay usable.
  const visibleModels = useMemo(() => {
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

  const handleFetchModels = async () => {
    setIsFetchingModels(true);
    try {
      const data = await fetchProviderModels({
        // On an edit, the server falls back to the stored key for anything
        // left blank -- so syncing works without retyping the key.
        id: initialConfig?.id,
        provider: providerType,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
      });
      if (data.models?.length) {
        setModels(data.models);
        toast.success(t("modelsSynced", { count: data.models.length }));
      } else {
        toast.warning(t("noModelsReturned"));
      }
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const addModel = () => {
    const value = newModelInput.trim();
    if (!value) return;
    if (models.includes(value)) {
      toast.warning(t("modelAlreadyAdded"));
      return;
    }
    setModels([...models, value]);
    setNewModelInput("");
  };

  const removeModel = (model: string) =>
    setModels(models.filter((m) => m !== model));

  const selectedProviderName = isCustom
    ? t("customProvider")
    : (AVAILABLE_PROVIDERS.find((p) => p.id === providerType)?.name ??
      providerType);

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
              className="w-full max-w-md justify-between bg-background/50"
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
                <span className="text-xs text-muted-foreground">
                  {t("change")}
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
                className="absolute right-1 top-1/2 -translate-y-1/2 size-7 text-muted-foreground hover:text-foreground"
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

        <div className="space-y-4 border rounded-xl p-4 bg-background/40 shadow-inner">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2 font-medium">
              <Box className="w-4 h-4 text-primary" /> {t("permittedModels")}
              {models.length > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5">
                  {models.length}
                </Badge>
              )}
            </Label>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleFetchModels}
              disabled={isFetchingModels || (isNew && !apiKey.trim())}
              className="h-8 shadow-sm text-xs font-semibold"
              data-testid="provider-sync-models"
            >
              {isFetchingModels ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudDownload className="mr-2 h-3.5 w-3.5" />
              )}
              {t("syncModels")}
            </Button>
          </div>

          {models.length > 8 && (
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

          <div className="flex flex-wrap gap-2 min-h-[60px] max-h-[240px] overflow-y-auto p-2 border border-border/50 rounded-md bg-background/50 items-start">
            {models.length === 0 ? (
              <div className="text-sm text-muted-foreground p-2 italic flex-1 text-center">
                {t("noModelsYet")}
              </div>
            ) : visibleModels.length === 0 ? (
              <div className="text-sm text-muted-foreground p-2 italic flex-1 text-center">
                {t("noModelsMatchFilter")}
              </div>
            ) : (
              visibleModels.map((m) => (
                <Badge
                  key={m}
                  variant="secondary"
                  className="pl-2 pr-1 py-1 flex items-center gap-1 shadow-sm font-medium border-border/60 max-w-full"
                >
                  <span className="truncate">{m}</span>
                  <button
                    type="button"
                    onClick={() => removeModel(m)}
                    className="hover:bg-destructive/10 hover:text-destructive rounded-full p-0.5 transition-colors shrink-0"
                    aria-label={`Remove ${m}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder={t("addModelPlaceholder")}
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModel();
                }
              }}
              className="h-9 bg-background/50 shadow-sm"
              data-testid="provider-add-model-input"
            />
            <Button
              size="sm"
              variant="default"
              onClick={addModel}
              type="button"
              className="h-9 shadow-md font-semibold"
            >
              {t("add")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("permittedModelsHint")}
          </p>
        </div>
      </div>

      <div className="pt-4 flex justify-end gap-3">
        <Button
          variant="ghost"
          onClick={() => router.push("/admin/providers")}
          className="font-semibold"
        >
          {t("cancel")}
        </Button>
        <Button
          onClick={handleSave}
          disabled={isSaving || !name.trim()}
          className="min-w-[120px] font-bold shadow-md"
          data-testid="provider-save-button"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("saveConfiguration")}
        </Button>
      </div>
    </div>
  );
}
