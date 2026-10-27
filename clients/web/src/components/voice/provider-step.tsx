"use client";

import { useState } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { VoiceProviderCatalogEntry } from "@/lib/backend/voice-api";
import { cn } from "lib/utils";

export type VoiceKind = "tts" | "stt";

export interface ProviderState {
  configured: boolean;
  apiKeyHint?: string;
  baseUrl: string;
}

export interface ConnectInput {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}

interface ProviderPanelProps {
  kind: VoiceKind;
  catalog: VoiceProviderCatalogEntry[];
  activeId: string;
  states: Record<string, ProviderState | undefined>;
  onConnect: (input: ConnectInput) => Promise<void>;
}

/**
 * Step 1 for one direction (speaking or listening): pick an engine, then paste
 * its key. Engines that are already connected switch in one click.
 */
export function ProviderPanel({
  kind,
  catalog,
  activeId,
  states,
  onConnect,
}: ProviderPanelProps) {
  const t = useTranslations("VoiceSettings");
  const [selected, setSelected] = useState(activeId);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const entry = catalog.find((p) => p.id === selected);
  const state = states[selected];
  const configured = Boolean(state?.configured);
  const keyless = Boolean(entry?.keyless);
  const needsBaseUrl = Boolean(entry?.requiresBaseUrl);
  const effectiveBaseUrl =
    baseUrl || state?.baseUrl || entry?.defaultBaseUrl || "";
  const canSubmit =
    !saving &&
    (apiKey.trim().length > 0 ||
      (needsBaseUrl && baseUrl.trim().length > 0 && configured));

  function select(id: string) {
    setSelected(id);
    setApiKey("");
    setBaseUrl("");
    setShowKey(false);
    const next = states[id];
    const nextEntry = catalog.find((p) => p.id === id);
    if ((next?.configured || nextEntry?.keyless) && id !== activeId) {
      void onConnect({ provider: id });
    }
  }

  async function submit() {
    setSaving(true);
    try {
      await onConnect({
        provider: selected,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
      setApiKey("");
      setBaseUrl("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-card/50 p-4"
      data-testid={`voice-${kind}-provider-panel`}
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {kind === "tts" ? t("ttsTitle") : t("sttTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {kind === "tts" ? t("ttsHint") : t("sttHint")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {catalog.map((p) => {
          const isSelected = selected === p.id;
          const isActive = activeId === p.id;
          const ready = Boolean(states[p.id]?.configured || p.keyless);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => select(p.id)}
              aria-pressed={isSelected}
              data-testid={`voice-${kind}-provider-${p.id}`}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected
                  ? "border-primary bg-primary/10"
                  : "border-border/70 bg-background hover:border-foreground/30",
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="line-clamp-2 text-sm font-medium text-foreground">
                  {p.displayName}
                </span>
                {isActive && ready ? (
                  <CheckCircle2
                    className="ml-auto size-3.5 shrink-0 text-emerald-500"
                    aria-label={t("inUse")}
                  />
                ) : null}
              </span>
              <span className="line-clamp-1 text-[11px] text-muted-foreground">
                {ready
                  ? p.keyless
                    ? t("noKeyNeeded")
                    : t("connected")
                  : t("needsKey")}
              </span>
            </button>
          );
        })}
      </div>

      {entry && !keyless ? (
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label
                htmlFor={`voice-${kind}-key`}
                className="text-xs font-semibold"
              >
                {t("apiKey", { provider: entry.displayName })}
              </Label>
              <span className="text-[11px] text-muted-foreground">
                {t("storedEncrypted")}
              </span>
            </div>
            <div className="relative">
              <Input
                id={`voice-${kind}-key`}
                data-testid={`voice-${kind}-key`}
                type={showKey ? "text" : "password"}
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  configured && state?.apiKeyHint
                    ? t("keySaved", { hint: state.apiKeyHint })
                    : (entry.apiKeyPlaceholder ?? t("pasteKey"))
                }
                className="h-9 pr-9 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? t("hideKey") : t("showKey")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
              </button>
            </div>
          </div>

          {entry.supportsBaseUrl ? (
            <details open={needsBaseUrl} className="group text-xs">
              <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground">
                {t("advanced")}
              </summary>
              <div className="mt-2 space-y-1.5">
                <Label
                  htmlFor={`voice-${kind}-url`}
                  className="text-xs font-semibold"
                >
                  {t("baseUrl")}
                </Label>
                <Input
                  id={`voice-${kind}-url`}
                  data-testid={`voice-${kind}-url`}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={effectiveBaseUrl}
                  className="h-9 text-xs"
                />
              </div>
            </details>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            {entry.docsUrl ? (
              <a
                href={entry.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="mr-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                {t("getKey")}
              </a>
            ) : null}
            <Button
              size="sm"
              onClick={submit}
              disabled={!canSubmit}
              data-testid={`voice-${kind}-connect`}
            >
              {saving ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              {configured ? t("updateKey") : t("connect")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
