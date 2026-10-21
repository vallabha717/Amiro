"use client";

import {
  type UpdateVoiceSettingsPayload,
  VOICE_SETTINGS_KEY,
  type VoiceProviderCatalogEntry,
  type VoiceSettingsResponse,
  fetchVoiceSettings,
  updateVoiceSettings,
} from "@/lib/backend/voice-api";
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

function useVoice() {
  return useSWR<VoiceSettingsResponse>(VOICE_SETTINGS_KEY, fetchVoiceSettings, {
    revalidateOnFocus: false,
  });
}

/**
 * Make `entry` the speaking voice, and the listening engine too when the same
 * provider offers speech-to-text, so one key turns on both directions.
 */
async function applyVoiceProvider(
  entry: VoiceProviderCatalogEntry,
  voice: VoiceSettingsResponse,
  input: { apiKey?: string; baseUrl?: string },
) {
  const payload: UpdateVoiceSettingsPayload = {
    readAloudEnabled: true,
    ttsProvider: entry.id,
    ttsProviderUpdate: {
      provider: entry.id,
      model: entry.defaultModel,
      voiceId: entry.defaultVoice,
      baseUrl: input.baseUrl || undefined,
      apiKey: input.apiKey || undefined,
    },
  };
  if (voice.sttCatalog.some((s) => s.id === entry.id)) {
    payload.sttProvider = entry.id;
    payload.sttProviderUpdate = {
      provider: entry.id,
      baseUrl: input.baseUrl || undefined,
      apiKey: input.apiKey || undefined,
    };
  }
  await updateVoiceSettings(payload);
  await mutate(VOICE_SETTINGS_KEY);
}

export function VoicePickCard({
  onSaved,
  onNeedsKey,
  onSkip,
}: {
  onSaved: (label: string) => void;
  onNeedsKey: (entry: VoiceProviderCatalogEntry) => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: voice, isLoading } = useVoice();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configured = (id: string) =>
    !!voice?.settings.ttsProviders[id]?.configured;
  const current = voice?.ttsCatalog.find(
    (e) => e.id === voice.settings.ttsProvider && configured(e.id),
  );

  const pick = async (entry: VoiceProviderCatalogEntry) => {
    if (!voice) return;
    if (!entry.keyless && !configured(entry.id)) {
      onNeedsKey(entry);
      return;
    }
    setBusy(entry.id);
    setError(null);
    try {
      await applyVoiceProvider(entry, voice, {});
      onSaved(entry.displayName);
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(null);
    }
  };

  return (
    <SetupCard testId="setup-voice-card">
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {(voice?.ttsCatalog ?? []).map((entry) => (
            <ChoiceButton
              key={entry.id}
              title={entry.displayName}
              subtitle={entry.subtitle}
              badge={entry.keyless ? t("noKey") : null}
              connected={configured(entry.id)}
              disabled={busy !== null}
              onClick={() => pick(entry)}
              testId={`setup-voice-${entry.id}`}
            />
          ))}
        </div>
      )}
      <ErrorLine error={error} />
      <CardActions onSkip={onSkip} busy={busy !== null}>
        {current && (
          <Button
            variant="outline"
            onClick={() => onSaved(current.displayName)}
            data-testid="setup-voice-keep"
          >
            {t("keepProvider", { provider: current.displayName })}
          </Button>
        )}
      </CardActions>
    </SetupCard>
  );
}

export function VoiceKeyCard({
  providerId,
  onSaved,
  onBack,
  onSkip,
}: {
  providerId: string;
  onSaved: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: voice } = useVoice();
  const entry = voice?.ttsCatalog.find((e) => e.id === providerId);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsBase = !!entry?.requiresBaseUrl;
  const ready = !!entry && key.trim() && (!needsBase || baseUrl.trim());

  const save = async () => {
    if (!voice || !entry || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await applyVoiceProvider(entry, voice, {
        apiKey: key.trim(),
        baseUrl: baseUrl.trim(),
      });
      setKey("");
      onSaved();
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(false);
    }
  };

  const label = entry?.displayName ?? providerId;
  return (
    <SetupCard testId="setup-voice-key-card">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {needsBase && (
          <div className="space-y-1.5">
            <Label htmlFor="setup-voice-base">{t("baseUrl")}</Label>
            <Input
              id="setup-voice-base"
              value={baseUrl}
              placeholder={entry?.defaultBaseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="setup-voice-base"
            />
          </div>
        )}
        <SecretField
          id="setup-voice-key"
          label={t("apiKeyFor", { provider: label })}
          value={key}
          onChange={setKey}
          placeholder={entry?.apiKeyPlaceholder}
          docsUrl={entry?.docsUrl}
          docsLabel={t("getKey", { provider: label })}
          testId="setup-voice-key"
        />
        <ErrorLine error={error} />
        <CardActions onSkip={onSkip} busy={busy}>
          <Button
            type="submit"
            disabled={!ready || busy}
            data-testid="setup-voice-save"
          >
            {busy ? t("saving") : t("saveKey")}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            {t("pickAnother")}
          </Button>
        </CardActions>
      </form>
    </SetupCard>
  );
}
