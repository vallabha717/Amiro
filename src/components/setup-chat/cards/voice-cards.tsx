"use client";

import {
  type UpdateVoiceSettingsPayload,
  VOICE_SETTINGS_KEY,
  type VoiceProviderCatalogEntry,
  type VoiceSettingsResponse,
  fetchVoiceSettings,
  updateVoiceSettings,
} from "@/lib/backend/voice-api";
import { cn } from "@/lib/utils";
import { AudioLines, CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Skeleton } from "ui/skeleton";
import {
  CardActions,
  ChoiceButton,
  ErrorLine,
  SetupCard,
  errorText,
} from "../card-ui";
import { SecretField } from "./search-cards";

/** Speaking (text to speech) or listening (speech to text). */
export type VoiceKind = "tts" | "stt";


export function useVoice() {
  return useSWR<VoiceSettingsResponse>(VOICE_SETTINGS_KEY, fetchVoiceSettings, {
    revalidateOnFocus: false,
  });
}

function catalogOf(voice: VoiceSettingsResponse | undefined, kind: VoiceKind) {
  return (kind === "tts" ? voice?.ttsCatalog : voice?.sttCatalog) ?? [];
}

function isConfigured(
  voice: VoiceSettingsResponse | undefined,
  kind: VoiceKind,
  id: string,
) {
  const slot =
    kind === "tts"
      ? voice?.settings.ttsProviders
      : voice?.settings.sttProviders;
  return !!slot?.[id]?.configured;
}

/** What one engine choice sends: the chosen direction, and listening too when asked. */
export function voicePayload(
  kind: VoiceKind,
  entry: VoiceProviderCatalogEntry,
  input: { apiKey?: string; baseUrl?: string; alsoListen?: boolean },
): UpdateVoiceSettingsPayload {
  const apiKey = input.apiKey || undefined;
  const baseUrl = input.baseUrl || undefined;
  const listen = {
    sttProvider: entry.id,
    sttProviderUpdate: {
      provider: entry.id,
      model: entry.defaultModel,
      baseUrl,
      apiKey,
    },
  };
  if (kind === "stt") return listen;
  return {
    readAloudEnabled: true,
    ttsProvider: entry.id,
    ttsProviderUpdate: {
      provider: entry.id,
      model: entry.defaultModel,
      voiceId: entry.defaultVoice,
      baseUrl,
      apiKey,
    },
    ...(input.alsoListen ? listen : {}),
  };
}

async function applyVoice(payload: UpdateVoiceSettingsPayload) {
  await updateVoiceSettings(payload);
  await mutate(VOICE_SETTINGS_KEY);
}

/**
 * Whether live voice (a hands-free conversation) can run. It works with any
 * keyed speaking and listening provider; the browser's own voices cover
 * read-aloud and dictation but not live voice, which runs on the server.
 */
export function LiveVoiceNote() {
  const t = useTranslations("SetupChat");
  const { data: voice } = useVoice();
  const live = voice?.settings.liveVoice;
  const ready = !!live?.configured;
  return (
    <p
      className={cn(
        "mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs",
        ready
          ? "border-emerald-500/40 text-foreground"
          : "border-dashed text-muted-foreground",
      )}
      data-testid="setup-live-voice"
      data-state={ready ? "ready" : "needs-provider"}
    >
      {ready ? (
        <CheckCircle2
          className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
      ) : (
        <AudioLines className="mt-px size-3.5 shrink-0" aria-hidden />
      )}
      <span>
        {ready
          ? t("liveVoiceReady", {
              stt: live?.sttName ?? "",
              tts: live?.ttsName ?? "",
            })
          : t("liveVoiceNeeds")}
      </span>
    </p>
  );
}

export function VoicePickCard({
  kind,
  onSaved,
  onNeedsKey,
  onSkip,
}: {
  kind: VoiceKind;
  onSaved: (label: string) => void;
  onNeedsKey: (entry: VoiceProviderCatalogEntry) => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: voice, isLoading } = useVoice();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = catalogOf(voice, kind);
  const currentId =
    kind === "tts" ? voice?.settings.ttsProvider : voice?.settings.sttProvider;
  const current = catalog.find(
    (e) => e.id === currentId && isConfigured(voice, kind, e.id),
  );

  const pick = async (entry: VoiceProviderCatalogEntry) => {
    if (!entry.keyless && !isConfigured(voice, kind, entry.id)) {
      onNeedsKey(entry);
      return;
    }
    setBusy(entry.id);
    setError(null);
    try {
      await applyVoice(voicePayload(kind, entry, {}));
      onSaved(entry.displayName);
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(null);
    }
  };

  return (
    <SetupCard
      testId={kind === "tts" ? "setup-voice-card" : "setup-listen-card"}
    >
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.map((entry) => (
            <ChoiceButton
              key={entry.id}
              title={entry.displayName}
              subtitle={entry.subtitle}
              badge={entry.keyless ? t("browserOnly") : null}
              connected={isConfigured(voice, kind, entry.id)}
              disabled={busy !== null}
              onClick={() => pick(entry)}
              testId={`setup-${kind === "tts" ? "voice" : "listen"}-${entry.id}`}
            />
          ))}
        </div>
      )}
      <LiveVoiceNote />
      <ErrorLine error={error} />
      <CardActions onSkip={onSkip} busy={busy !== null}>
        {current && (
          <Button
            variant="outline"
            onClick={() => onSaved(current.displayName)}
            data-testid={
              kind === "tts" ? "setup-voice-keep" : "setup-listen-keep"
            }
          >
            {t("keepProvider", { provider: current.displayName })}
          </Button>
        )}
      </CardActions>
    </SetupCard>
  );
}

export function VoiceKeyCard({
  kind,
  providerId,
  onSaved,
  onBack,
  onSkip,
}: {
  kind: VoiceKind;
  providerId: string;
  onSaved: (alsoListen: boolean) => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: voice } = useVoice();
  const entry = catalogOf(voice, kind).find((e) => e.id === providerId);
  const canListen =
    kind === "tts" && !!voice?.sttCatalog.some((s) => s.id === providerId);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [alsoListen, setAlsoListen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsBase = !!entry?.requiresBaseUrl;
  const ready = !!entry && key.trim() && (!needsBase || baseUrl.trim());
  const prefix = kind === "tts" ? "setup-voice" : "setup-listen";

  const save = async () => {
    if (!entry || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const listen = canListen && alsoListen;
      await applyVoice(
        voicePayload(kind, entry, {
          apiKey: key.trim(),
          baseUrl: baseUrl.trim(),
          alsoListen: listen,
        }),
      );
      setKey("");
      onSaved(listen);
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(false);
    }
  };

  const label = entry?.displayName ?? providerId;
  return (
    <SetupCard testId={`${prefix}-key-card`}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {needsBase && (
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-base`}>{t("baseUrl")}</Label>
            <Input
              id={`${prefix}-base`}
              value={baseUrl}
              placeholder={entry?.defaultBaseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid={`${prefix}-base`}
            />
          </div>
        )}
        <SecretField
          id={`${prefix}-key`}
          label={t("apiKeyFor", { provider: label })}
          value={key}
          onChange={setKey}
          placeholder={entry?.apiKeyPlaceholder}
          docsUrl={entry?.docsUrl}
          docsLabel={t("getKey", { provider: label })}
          testId={`${prefix}-key`}
        />
        {canListen && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={alsoListen}
              onChange={(e) => setAlsoListen(e.target.checked)}
              data-testid="setup-voice-also-listen"
            />
            {t("alsoListen", { provider: label })}
          </label>
        )}
        <ErrorLine error={error} />
        <CardActions onSkip={onSkip} busy={busy}>
          <Button
            type="submit"
            disabled={!ready || busy}
            data-testid={`${prefix}-save`}
          >
            {busy ? t("saving") : t("saveKey")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={busy}
          >
            {t("pickAnother")}
          </Button>
        </CardActions>
      </form>
    </SetupCard>
  );
}
