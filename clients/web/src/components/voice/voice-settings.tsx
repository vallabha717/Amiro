"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Check, Loader2, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_VOICE_SETTINGS,
  FALLBACK_STT_CATALOG,
  FALLBACK_TTS_CATALOG,
  fetchVoiceSettings,
  updateVoiceSettings,
  type UpdateVoiceSettingsPayload,
  type VoiceProviderCatalogEntry,
  type VoiceSettingsData,
} from "@/lib/backend/voice-api";
import { cn } from "lib/utils";
import { ListenTest } from "./listen-test";
import { ModelPanel } from "./model-step";
import {
  type ConnectInput,
  ProviderPanel,
  type VoiceKind,
} from "./provider-step";
import { VoiceHero } from "./voice-hero";
import { VoiceStep } from "./voice-step";

type StepState = "done" | "active" | "locked";

function Step({
  index,
  title,
  description,
  state,
  lockedHint,
  testId,
  children,
}: {
  index: number;
  title: string;
  description: string;
  state: StepState;
  lockedHint: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-state={state}
      aria-labelledby={`${testId}-title`}
      className="flex gap-4"
    >
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
          state === "done" && "border-emerald-500 bg-emerald-500 text-white",
          state === "active" && "border-primary bg-primary text-primary-foreground",
          state === "locked" && "border-border text-muted-foreground",
        )}
        aria-hidden
      >
        {state === "done" ? (
          <Check className="size-3.5" />
        ) : state === "locked" ? (
          <Lock className="size-3" />
        ) : (
          index
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <h2
            id={`${testId}-title`}
            className="text-base font-semibold text-foreground"
          >
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {state === "locked" ? (
          <p className="rounded-lg border border-dashed border-border/70 p-4 text-xs text-muted-foreground">
            {lockedHint}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

const isReady = (
  catalog: VoiceProviderCatalogEntry[],
  states: VoiceSettingsData["ttsProviders"],
  id: string,
) => Boolean(states[id]?.configured || catalog.find((p) => p.id === id)?.keyless);

/**
 * Voice & Speech as three ordered steps, like the model providers page:
 * connect an engine for speaking and listening, pick their models, then audition
 * and choose the assistant's voice.
 */
export function VoiceSettings() {
  const t = useTranslations("VoiceSettings");
  const [loading, setLoading] = useState(true);
  const [ttsCatalog, setTtsCatalog] =
    useState<VoiceProviderCatalogEntry[]>(FALLBACK_TTS_CATALOG);
  const [sttCatalog, setSttCatalog] =
    useState<VoiceProviderCatalogEntry[]>(FALLBACK_STT_CATALOG);
  const [settings, setSettings] =
    useState<VoiceSettingsData>(DEFAULT_VOICE_SETTINGS);
  const [pickedName, setPickedName] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchVoiceSettings()
      .then((res) => {
        if (!mounted) return;
        setTtsCatalog(res.ttsCatalog);
        setSttCatalog(res.sttCatalog);
        setSettings(res.settings);
      })
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, []);

  const save = useCallback(
    async (payload: UpdateVoiceSettingsPayload, message?: string) => {
      try {
        const res = await updateVoiceSettings(payload);
        setSettings(res.settings);
        if (message) toast.success(message);
      } catch {
        toast.error(t("saveFailed"));
      }
    },
    [t],
  );

  const connect = (kind: VoiceKind) => async (input: ConnectInput) => {
    const update = {
      provider: input.provider,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
    };
    await save(
      kind === "tts"
        ? { ttsProvider: input.provider, ttsProviderUpdate: update }
        : { sttProvider: input.provider, sttProviderUpdate: update },
      t("providerSaved"),
    );
  };

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ttsId = settings.ttsProvider;
  const sttId = settings.sttProvider;
  const ttsEntry = ttsCatalog.find((p) => p.id === ttsId);
  const sttEntry = sttCatalog.find((p) => p.id === sttId);
  const ttsState = settings.ttsProviders[ttsId];
  const sttState = settings.sttProviders[sttId];
  const ttsReady = isReady(ttsCatalog, settings.ttsProviders, ttsId);
  const sttReady = sttCatalog.some(
    (p) => p.id === sttId && (settings.sttProviders[p.id]?.configured || p.keyless),
  );
  const ttsModel = ttsState?.model || ttsEntry?.defaultModel || "";
  const sttModel = sttState?.model || sttEntry?.defaultModel || "";
  const voiceId = ttsState?.voiceId || ttsEntry?.defaultVoice || "";

  const voiceName =
    pickedName ?? ttsEntry?.voiceLabels?.[voiceId] ?? (voiceId || t("defaultVoice"));

  const providersDone = ttsReady && sttReady;
  const providersState: StepState = providersDone ? "done" : "active";
  const modelsState: StepState = providersDone ? "done" : "locked";
  const voiceState: StepState = ttsReady
    ? providersDone
      ? "done"
      : "active"
    : "locked";

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-8">
        <header className="border-b border-border/60 pb-5">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </header>

        {ttsReady ? (
          <VoiceHero
            voiceName={voiceName}
            providerName={ttsEntry?.displayName ?? ttsId}
            model={ttsModel}
            provider={ttsId}
            voiceId={voiceId}
            speed={ttsState?.speed || 1}
          />
        ) : null}

        <Step
          index={1}
          testId="voice-step-providers"
          state={providersState}
          title={t("step1Title")}
          description={t("step1Description")}
          lockedHint=""
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ProviderPanel
              kind="tts"
              catalog={ttsCatalog}
              activeId={ttsId}
              states={settings.ttsProviders}
              onConnect={connect("tts")}
            />
            <ProviderPanel
              kind="stt"
              catalog={sttCatalog}
              activeId={sttId}
              states={settings.sttProviders}
              onConnect={connect("stt")}
            />
          </div>
        </Step>

        <Step
          index={2}
          testId="voice-step-models"
          state={modelsState}
          title={t("step2Title")}
          description={t("step2Description")}
          lockedHint={t("connectFirst")}
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ModelPanel
              kind="tts"
              entry={ttsEntry}
              model={ttsModel}
              onModelChange={(model) =>
                save(
                  { ttsProviderUpdate: { provider: ttsId, model } },
                  t("modelSaved"),
                )
              }
            />
            <ModelPanel
              kind="stt"
              entry={sttEntry}
              model={sttModel}
              language={settings.sttLanguage}
              onModelChange={(model) =>
                save(
                  { sttProviderUpdate: { provider: sttId, model } },
                  t("modelSaved"),
                )
              }
              onLanguageChange={(language) =>
                save(
                  {
                    sttLanguage: language,
                    sttProviderUpdate: { provider: sttId, language },
                  },
                  t("languageSaved"),
                )
              }
            >
              {sttReady ? (
                <ListenTest
                  provider={sttId}
                  model={sttModel}
                  language={settings.sttLanguage}
                  keyless={Boolean(sttEntry?.keyless)}
                />
              ) : null}
            </ModelPanel>
          </div>
        </Step>

        <Step
          index={3}
          testId="voice-step-voice"
          state={voiceState}
          title={t("step3Title")}
          description={t("step3Description")}
          lockedHint={t("connectFirst")}
        >
          <VoiceStep
            entry={ttsEntry}
            model={ttsModel}
            voiceId={voiceId}
            speed={ttsState?.speed || 1}
            onSelect={(voice) => {
              setPickedName(voice.name);
              void save(
                { ttsProviderUpdate: { provider: ttsId, voiceId: voice.id } },
                t("voiceSaved", { name: voice.name }),
              );
            }}
            onSpeedCommit={(speed) =>
              save({ ttsProviderUpdate: { provider: ttsId, speed } })
            }
          />
        </Step>

        <section
          aria-labelledby="voice-prefs-title"
          className="space-y-4 rounded-xl border border-border/70 bg-card/50 p-4"
        >
          <h2 id="voice-prefs-title" className="text-sm font-semibold">
            {t("prefsTitle")}
          </h2>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{t("readAloudButton")}</p>
              <p className="text-xs text-muted-foreground">
                {t("readAloudButtonHint")}
              </p>
            </div>
            <Switch
              aria-label={t("readAloudButton")}
              checked={settings.readAloudEnabled}
              onCheckedChange={(readAloudEnabled) =>
                save({ readAloudEnabled }, t("prefSaved"))
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{t("autoRead")}</p>
              <p className="text-xs text-muted-foreground">{t("autoReadHint")}</p>
            </div>
            <Switch
              aria-label={t("autoRead")}
              checked={settings.autoReadAloud}
              onCheckedChange={(autoReadAloud) =>
                save({ autoReadAloud }, t("prefSaved"))
              }
            />
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
