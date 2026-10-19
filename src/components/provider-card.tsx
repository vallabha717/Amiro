"use client";

import {
  Box,
  Eye,
  EyeOff,
  FlaskConical,
  Loader,
  Loader2,
  Settings,
  Trash2,
} from "lucide-react";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card, CardContent, CardHeader } from "ui/card";
import JsonView from "ui/json-view";
import { Separator } from "ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { WriteIcon } from "ui/write-icon";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { handleErrorWithToast } from "ui/shared-toast";
import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { safe } from "ts-safe";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import {
  PROVIDERS_KEY,
  removeProvider,
  type ProviderConfig,
} from "@/lib/backend/provider-api";

/**
 * One configured provider connection, laid out like MCPCard: identity and
 * actions in the header, then the stored configuration on the left and what
 * the connection actually gives you -- its models -- on the right.
 */
export const ProviderCard = memo(function ProviderCard({
  id,
  name,
  provider,
  configured,
  apiKey,
  baseUrl,
  models,
  selectedModel,
}: ProviderConfig) {
  const t = useTranslations("Providers");
  const router = useRouter();
  const { mutate } = useSWRConfig();

  const [isProcessing, setIsProcessing] = useState(false);
  const [revealKey, setRevealKey] = useState(false);

  const modelList = models ?? [];

  // The key is stored in the clear and is meant to be readable here, but it
  // should not be sitting on screen by default -- this page is as likely to
  // be open during a screen share as any other.
  const configPreview = useMemo(() => {
    const preview: Record<string, unknown> = { provider };
    if (baseUrl) preview.baseUrl = baseUrl;
    preview.apiKey = !apiKey
      ? null
      : revealKey
        ? apiKey
        : `${apiKey.slice(0, 6)}${"•".repeat(Math.max(apiKey.length - 6, 0))}`;
    preview.models = modelList.length;
    return preview;
  }, [provider, baseUrl, apiKey, revealKey, modelList.length]);

  const handleDelete = useCallback(async () => {
    if (
      !confirm(
        `Delete "${name}"? Chats can no longer use its models until you add it back.`,
      )
    ) {
      return;
    }
    await safe(() => setIsProcessing(true))
      .ifOk(() => removeProvider(id))
      .ifOk(() => mutate(PROVIDERS_KEY))
      .ifOk(() => mutate("/api/chat/models"))
      .ifOk(() => toast.success(t("providerDeleted")))
      .ifFail(handleErrorWithToast)
      .watch(() => setIsProcessing(false));
  }, [id, name, mutate, t]);

  const isLoading = isProcessing;

  return (
    <Card
      className="relative hover:border-foreground/20 transition-colors bg-secondary/40"
      data-testid="provider-card"
      data-provider-id={id}
    >
      {isLoading && (
        <div className="animate-pulse z-10 absolute inset-0 bg-background/50 flex items-center justify-center w-full h-full" />
      )}

      <CardHeader className="flex flex-wrap items-center gap-1 mb-2">
        {isLoading && <Loader className="size-4 z-20 animate-spin mr-1" />}

        <ModelProviderIcon provider={provider} className="size-4 mr-1.5" />
        <h4 className="font-bold text-xs sm:text-lg flex items-center gap-2 flex-wrap">
          {name}
          {configured ? (
            <Badge
              variant="secondary"
              className="bg-green-500/10 text-green-600 dark:text-green-500 border-green-500/20 text-[10px] px-1.5"
            >
              {t("active")}
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px] px-1.5">
              {t("noKey")}
            </Badge>
          )}
          {selectedModel && (
            <Badge
              data-testid="provider-default-model-badge"
              variant="outline"
              className="border-primary/40 bg-primary/10 text-primary text-[10px] px-1.5 font-mono"
            >
              Default model: {selectedModel}
            </Badge>
          )}
        </h4>

        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            {isLoading || !configured ? (
              <div>
                <Button variant="outline" size="sm" disabled>
                  <FlaskConical className="size-3.5 mr-1.5" />
                  Models &amp; test
                </Button>
              </div>
            ) : (
              <Link
                href={`/admin/providers/test?id=${encodeURIComponent(id)}`}
                className="cursor-pointer"
                data-testid="provider-test-link"
              >
                <Button variant="outline" size="sm">
                  <FlaskConical className="size-3.5 mr-1.5" />
                  Models &amp; test
                </Button>
              </Link>
            )}
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("modelTest")}</p>
          </TooltipContent>
        </Tooltip>

        <div className="h-4">
          <Separator orientation="vertical" />
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              disabled={isLoading}
              onClick={() => router.push(`/admin/providers/modify?id=${id}`)}
              data-testid="provider-edit-button"
              aria-label={t("edit")}
            >
              <WriteIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("edit")}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive"
              disabled={isLoading}
              onClick={handleDelete}
              data-testid="provider-delete-button"
              aria-label={t("delete")}
            >
              {isProcessing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("delete")}</p>
          </TooltipContent>
        </Tooltip>
      </CardHeader>

      <div className="relative hidden sm:flex w-full">
        <CardContent className="flex min-w-0 w-full flex-row text-sm max-h-[320px] overflow-hidden border-r-0">
          <div className="w-1/2 min-w-0 flex flex-col pr-2 border-r border-border">
            <div className="flex items-center gap-2 mb-2 pt-2 pb-1 z-10">
              <Settings size={14} className="text-muted-foreground" />
              <h5 className="text-muted-foreground text-sm font-medium">
                {t("configuration")}
              </h5>
              <div className="flex-1" />
              {apiKey && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setRevealKey((v) => !v)}
                      data-testid="provider-reveal-key"
                    >
                      {revealKey ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{revealKey ? t("hideKey") : t("showKey")}</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              <JsonView data={configPreview} />
            </div>
          </div>

          <div className="w-1/2 min-w-0 flex flex-col pl-4">
            <div className="flex items-center gap-2 mb-4 pt-2 pb-1 z-10">
              <Box size={14} className="text-muted-foreground" />
              <h5 className="text-muted-foreground text-sm font-medium">
                {t("availableModels")}
              </h5>
              {modelList.length > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5">
                  {modelList.length}
                </Badge>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {modelList.length > 0 ? (
                <ModelsList
                  providerId={id}
                  models={modelList}
                  selectedModel={selectedModel}
                />
              ) : (
                <div className="bg-secondary/30 rounded-md p-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t("noModelsConfigured")}
                  </p>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </div>
    </Card>
  );
});

/**
 * Each model links straight into the test page preloaded with that model --
 * the equivalent of MCPCard's per-tool detail popup.
 */
const ModelsList = memo(
  ({
    providerId,
    models,
    selectedModel,
  }: {
    providerId: string;
    models: string[];
    selectedModel?: string;
  }) => (
    <div className="space-y-2 pr-2">
      {models.map((model) => {
        const isDefault = selectedModel === model;
        return (
          <Link
            key={model}
            href={`/admin/providers/test?id=${encodeURIComponent(
              providerId,
            )}&model=${encodeURIComponent(model)}`}
            className={`flex items-center gap-2 rounded-md p-2 transition-colors ${
              isDefault
                ? "bg-primary/15 border border-primary/40 text-foreground font-semibold hover:bg-primary/20"
                : "bg-secondary hover:bg-input text-foreground"
            }`}
            data-testid="provider-model-row"
          >
            <p className="font-medium text-sm break-all flex-1 min-w-0 flex items-center gap-2">
              {model}
              {isDefault && (
                <Badge
                  variant="secondary"
                  className="text-[9px] px-1 py-0 h-4 bg-primary/20 text-primary"
                >
                  Default
                </Badge>
              )}
            </p>
            <FlaskConical
              size={14}
              className={`shrink-0 ${isDefault ? "text-primary" : "text-muted-foreground"}`}
              aria-hidden
            />
          </Link>
        );
      })}
    </div>
  ),
);

ModelsList.displayName = "ModelsList";
