"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { VoiceProviderCatalogEntry } from "@/lib/backend/voice-api";
import { cn } from "lib/utils";
import type { VoiceKind } from "./provider-step";

const STT_LANGUAGES = ["en", "hi", "multi"] as const;

interface ModelPanelProps {
  kind: VoiceKind;
  entry: VoiceProviderCatalogEntry | undefined;
  model: string;
  onModelChange: (model: string) => void;
  language?: string;
  onLanguageChange?: (language: string) => void;
  children?: ReactNode;
}

/** Step 2: the model of the connected engine (and the listening language). */
export function ModelPanel({
  kind,
  entry,
  model,
  onModelChange,
  language,
  onLanguageChange,
  children,
}: ModelPanelProps) {
  const t = useTranslations("VoiceSettings");
  const selectable = Boolean(entry?.supportsModelSelection) && !entry?.keyless;

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-card/50 p-4"
      data-testid={`voice-${kind}-model-panel`}
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {kind === "tts" ? t("ttsModelTitle") : t("sttModelTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {entry ? entry.displayName : ""}
        </p>
      </div>

      {selectable && entry ? (
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">{t("model")}</Label>
          <Select value={model} onValueChange={onModelChange}>
            <SelectTrigger
              className="h-9 w-full text-xs"
              data-testid={`voice-${kind}-model`}
              aria-label={t("model")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entry.models.map((m) => (
                <SelectItem key={m} value={m} className="text-xs">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("browserModel")}</p>
      )}

      {kind === "stt" && onLanguageChange ? (
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">{t("language")}</Label>
          <div className="flex flex-wrap gap-2">
            {STT_LANGUAGES.map((value) => {
              const active = language === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  data-testid={`voice-language-${value}`}
                  onClick={() => onLanguageChange(value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary bg-primary/10 font-semibold text-foreground"
                      : "border-border/70 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`lang_${value}`)}
                  {active ? <Check className="size-3 text-primary" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {children}
    </div>
  );
}
