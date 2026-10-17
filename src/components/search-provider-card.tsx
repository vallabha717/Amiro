"use client";

import {
  CheckCircle2,
  FileText,
  FlaskConical,
  KeySquare,
  Link2,
  Loader,
  Loader2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { safe } from "ts-safe";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card, CardContent, CardHeader } from "ui/card";
import { Separator } from "ui/separator";
import { handleErrorWithToast } from "ui/shared-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { WriteIcon } from "ui/write-icon";

import {
  SEARCH_PROVIDERS_KEY,
  type SearchProviderConfig,
  activateSearchProvider,
  deleteSearchProvider,
} from "@/lib/backend/search-provider-api";

/**
 * One saved provider.
 *
 * There is no "reveal key" control here any more, and that is the point: the
 * server sends a masked hint and never the key itself, so there is nothing
 * to reveal. The hint exists only to tell two saved keys apart.
 */
export const SearchProviderCard = memo(function SearchProviderCard({
  id,
  name,
  provider,
  configured,
  apiKeyHint,
  isActive,
  extracts,
  baseUrl,
  custom,
}: SearchProviderConfig) {
  const t = useTranslations("Providers");
  const router = useRouter();
  const { mutate } = useSWRConfig();

  const [isProcessing, setIsProcessing] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete "${name}"?`)) {
      return;
    }
    await safe(() => setIsProcessing(true))
      .ifOk(() => deleteSearchProvider(id))
      .ifOk(() => mutate(SEARCH_PROVIDERS_KEY))
      .ifOk(() => toast.success(t("providerDeleted")))
      .ifFail(handleErrorWithToast)
      .watch(() => setIsProcessing(false));
  }, [id, name, mutate, t]);

  const handleActivate = useCallback(async () => {
    await safe(() => setIsProcessing(true))
      .ifOk(() => activateSearchProvider(id))
      .ifOk(() => mutate(SEARCH_PROVIDERS_KEY))
      .ifOk(() => toast.success(`${name} activated`))
      .ifFail(handleErrorWithToast)
      .watch(() => setIsProcessing(false));
  }, [id, name, mutate]);

  const isLoading = isProcessing;

  return (
    <Card
      className={`relative transition-colors ${
        isActive
          ? "border-primary/50 shadow-[0_0_15px_rgba(var(--primary),0.2)] bg-primary/5"
          : "hover:border-foreground/20 bg-secondary/40"
      }`}
      data-testid="search-provider-card"
      data-provider-id={id}
    >
      {isLoading && (
        <div className="animate-pulse z-10 absolute inset-0 bg-background/50 flex items-center justify-center w-full h-full" />
      )}

      <CardHeader className="flex items-center gap-1 mb-2">
        {isLoading && <Loader className="size-4 z-20 animate-spin mr-1" />}

        <h4 className="font-bold text-xs sm:text-lg flex items-center gap-2">
          {name}
          {configured ? (
            isActive ? (
              <Badge
                variant="secondary"
                className="bg-primary/20 text-primary border-primary/30 text-[10px] px-1.5"
              >
                {t("active")}
              </Badge>
            ) : (
              <Badge
                variant="secondary"
                className="bg-green-500/10 text-green-600 dark:text-green-500 border-green-500/20 text-[10px] px-1.5"
              >
                Configured
              </Badge>
            )
          ) : (
            <Badge variant="destructive" className="text-[10px] px-1.5">
              {t("noKey")}
            </Badge>
          )}
        </h4>

        <div className="flex-1" />

        {!isActive && configured && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-primary"
                  onClick={handleActivate}
                  disabled={isLoading}
                >
                  <CheckCircle2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Set Active</p>
              </TooltipContent>
            </Tooltip>
            <div className="h-4 mx-1">
              <Separator orientation="vertical" />
            </div>
          </>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            {isLoading || !configured ? (
              <div className="hidden sm:block">
                <Button variant="ghost" size="icon" disabled>
                  <FlaskConical className="size-3.5" />
                </Button>
              </div>
            ) : (
              <Link
                href={`/admin/search/test?id=${encodeURIComponent(id)}`}
                className="cursor-pointer hidden sm:block"
                data-testid="search-provider-test-link"
              >
                <Button variant="ghost" size="icon">
                  <FlaskConical className="size-3.5" />
                </Button>
              </Link>
            )}
          </TooltipTrigger>
          <TooltipContent>
            <p>Test Connection</p>
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
              onClick={() => router.push(`/admin/search/modify?id=${id}`)}
              data-testid="search-provider-edit-button"
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
              data-testid="search-provider-delete-button"
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

      {/* The detail strip: what engine, what key, and whether picking it
          keeps the web_content tool working. Three facts, stated flat --
          the JSON dump this replaced existed to show a key that is no
          longer sent to the browser at all. */}
      <CardContent className="hidden sm:flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0 text-xs text-muted-foreground">
        <span className="font-mono">{provider}</span>

        <span className="flex items-center gap-1.5">
          <KeySquare className="size-3.5 shrink-0" />
          {apiKeyHint ? (
            <span className="font-mono">{apiKeyHint}</span>
          ) : (
            <span>no key saved</span>
          )}
        </span>

        {(baseUrl || custom?.endpoint) && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] truncate max-w-xs text-primary/80">
            <Link2 className="size-3 shrink-0" />
            <span className="truncate">{baseUrl || custom?.endpoint}</span>
          </span>
        )}

        <span className="flex items-center gap-1.5">
          <FileText className="size-3.5 shrink-0" />
          <span>{extracts ? "extracts page content" : "links and snippets only"}</span>
        </span>
      </CardContent>
    </Card>
  );
});
