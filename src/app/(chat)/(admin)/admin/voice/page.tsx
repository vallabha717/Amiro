"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useMessageReadAloudStore } from "@/lib/ai/speech/read-aloud-store";
import {
  DEFAULT_VOICE_SETTINGS,
  FALLBACK_STT_CATALOG,
  FALLBACK_TTS_CATALOG,
  type VoiceOptionItem,
  type VoiceProviderCatalogEntry,
  type VoiceSettingsData,
  fetchProviderVoices,
  fetchVoiceSettings,
  updateVoiceSettings,
} from "@/lib/backend/voice-api";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const STT_LANGUAGES = [
  { value: "en", label: "English (en)" },
  { value: "multi", label: "Multilingual auto-detect" },
  { value: "es", label: "Spanish (es)" },
  { value: "fr", label: "French (fr)" },
  { value: "de", label: "German (de)" },
  { value: "hi", label: "Hindi (hi)" },
  { value: "ja", label: "Japanese (ja)" },
  { value: "ko", label: "Korean (ko)" },
  { value: "zh", label: "Chinese (zh)" },
];

export default function AdminVoicePage() {
  const [loading, setLoading] = useState(true);
  const [ttsCatalog, setTtsCatalog] =
    useState<VoiceProviderCatalogEntry[]>(FALLBACK_TTS_CATALOG);
  const [sttCatalog, setSttCatalog] =
    useState<VoiceProviderCatalogEntry[]>(FALLBACK_STT_CATALOG);
  const [settings, setSettings] = useState<VoiceSettingsData>(
    DEFAULT_VOICE_SETTINGS,
  );

  // Read aloud section state
  const [readAloudEnabled, setReadAloudEnabled] = useState(true);
  const [autoReadAloud, setAutoReadAloud] = useState(false);

  // TTS section state
  const [activeTts, setActiveTts] = useState("browser-native");
  const [ttsModel, setTtsModel] = useState("browser-default");
  const [ttsVoice, setTtsVoice] = useState("default");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsSaving, setTtsSaving] = useState(false);
  const [fetchedVoices, setFetchedVoices] = useState<
    Record<string, VoiceOptionItem[]>
  >({});
  const [fetchingVoices, setFetchingVoices] = useState(false);

  // STT section state
  const [activeStt, setActiveStt] = useState("browser-native");
  const [sttModel, setSttModel] = useState("browser-default");
  const [sttBaseUrl, setSttBaseUrl] = useState("");
  const [sttLanguage, setSttLanguage] = useState("en");
  const [sttApiKey, setSttApiKey] = useState("");
  const [sttSaving, setSttSaving] = useState(false);

  // Read aloud store status for test voice button
  const readAloudStatus = useMessageReadAloudStore((s) => s.status);
  const activeMessageId = useMessageReadAloudStore((s) => s.messageId);
  const isTestingVoice =
    activeMessageId === "test-voice-preview" && readAloudStatus !== "idle";

  useEffect(() => {
    let mounted = true;
    fetchVoiceSettings()
      .then((res) => {
        if (!mounted) return;
        setTtsCatalog(res.ttsCatalog || FALLBACK_TTS_CATALOG);
        setSttCatalog(res.sttCatalog || FALLBACK_STT_CATALOG);
        setSettings(res.settings);

        setReadAloudEnabled(res.settings.readAloudEnabled ?? true);
        setAutoReadAloud(res.settings.autoReadAloud ?? false);

        const currentTts = res.settings.ttsProvider || "browser-native";
        setActiveTts(currentTts);
        const ttsState = res.settings.ttsProviders[currentTts];
        if (ttsState) {
          setTtsModel(ttsState.model || "");
          setTtsVoice(ttsState.voiceId || "");
          setTtsBaseUrl(ttsState.baseUrl || "");
        }

        const currentStt = res.settings.sttProvider || "browser-native";
        setActiveStt(currentStt);
        setSttLanguage(res.settings.sttLanguage || "en");
        const sttState = res.settings.sttProviders[currentStt];
        if (sttState) {
          setSttModel(sttState.model || "");
          setSttBaseUrl(sttState.baseUrl || "");
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleTtsProviderChange = (providerId: string) => {
    setActiveTts(providerId);
    setTtsApiKey("");
    const state = settings.ttsProviders[providerId];
    const cat = ttsCatalog.find((c) => c.id === providerId);
    if (state) {
      setTtsModel(state.model || cat?.defaultModel || "");
      setTtsVoice(state.voiceId || cat?.defaultVoice || "");
      setTtsBaseUrl(state.baseUrl || cat?.defaultBaseUrl || "");
    } else if (cat) {
      setTtsModel(cat.defaultModel || "");
      setTtsVoice(cat.defaultVoice || "");
      setTtsBaseUrl(cat.defaultBaseUrl || "");
    }
  };

  const handleSttProviderChange = (providerId: string) => {
    setActiveStt(providerId);
    setSttApiKey("");
    const state = settings.sttProviders[providerId];
    const cat = sttCatalog.find((c) => c.id === providerId);
    if (state) {
      setSttModel(state.model || cat?.defaultModel || "");
      setSttBaseUrl(state.baseUrl || cat?.defaultBaseUrl || "");
    } else if (cat) {
      setSttModel(cat.defaultModel || "");
      setSttBaseUrl(cat.defaultBaseUrl || "");
    }
  };

  const handleToggleReadAloud = async (enabled: boolean) => {
    setReadAloudEnabled(enabled);
    try {
      const res = await updateVoiceSettings({ readAloudEnabled: enabled });
      setSettings(res.settings);
      toast.success(
        enabled ? "Read aloud action enabled" : "Read aloud action disabled",
      );
    } catch {
      toast.error("Failed to update read aloud setting");
    }
  };

  const handleToggleAutoReadAloud = async (enabled: boolean) => {
    setAutoReadAloud(enabled);
    try {
      const res = await updateVoiceSettings({ autoReadAloud: enabled });
      setSettings(res.settings);
      toast.success(
        enabled
          ? "Automatic read aloud on chat finish enabled"
          : "Automatic read aloud on chat finish disabled",
      );
    } catch {
      toast.error("Failed to update auto read aloud setting");
    }
  };

  const handleSaveTts = async () => {
    setTtsSaving(true);
    try {
      const res = await updateVoiceSettings({
        ttsProvider: activeTts,
        ttsProviderUpdate: {
          provider: activeTts,
          model: ttsModel,
          voiceId: ttsVoice,
          baseUrl: ttsBaseUrl,
          apiKey: ttsApiKey.trim() || undefined,
        },
      });
      setSettings(res.settings);
      setTtsApiKey("");
      toast.success("Text-to-speech settings saved");
    } catch {
      toast.error("Failed to save text-to-speech settings");
    } finally {
      setTtsSaving(false);
    }
  };

  const handleClearTtsKey = async () => {
    setTtsSaving(true);
    try {
      const res = await updateVoiceSettings({
        ttsProviderUpdate: {
          provider: activeTts,
          clearApiKey: true,
        },
      });
      setSettings(res.settings);
      setTtsApiKey("");
      toast.success("API key cleared");
    } catch {
      toast.error("Failed to clear API key");
    } finally {
      setTtsSaving(false);
    }
  };

  const handleFetchVoices = async () => {
    setFetchingVoices(true);
    try {
      const voices = await fetchProviderVoices({
        provider: activeTts,
        baseUrl: ttsBaseUrl.trim() || undefined,
        apiKey: ttsApiKey.trim() || undefined,
      });
      setFetchedVoices((prev) => ({ ...prev, [activeTts]: voices }));
      if (voices.length > 0) {
        toast.success(`Loaded ${voices.length} voices for ${activeTts}`);
      } else {
        toast.info("No voices returned; enter a custom Voice / Reference ID");
      }
    } catch {
      toast.error("Could not fetch voices from provider");
    } finally {
      setFetchingVoices(false);
    }
  };

  const handlePreviewVoice = (voiceIdToTest: string) => {
    const previewMsgId = `voice-preview-${voiceIdToTest}`;
    if (activeMessageId === previewMsgId && readAloudStatus !== "idle") {
      useMessageReadAloudStore.getState().stop();
      return;
    }
    void useMessageReadAloudStore.getState().playMessage({
      messageId: previewMsgId,
      text: `Hello! This is voice ${voiceIdToTest} on Amiro.`,
      provider: activeTts,
      model: ttsModel || undefined,
      voiceId: voiceIdToTest,
      baseUrl: ttsBaseUrl.trim() || undefined,
      apiKey: ttsApiKey.trim() || undefined,
    });
  };

  const handleTestVoice = () => {
    if (isTestingVoice) {
      useMessageReadAloudStore.getState().stop();
      return;
    }
    void useMessageReadAloudStore.getState().playMessage({
      messageId: "test-voice-preview",
      text: "Hello! I am your Amiro assistant.",
      provider: activeTts,
      model: ttsModel || undefined,
      voiceId: ttsVoice || undefined,
      baseUrl: ttsBaseUrl.trim() || undefined,
      apiKey: ttsApiKey.trim() || undefined,
    });
  };

  const handleSaveStt = async () => {
    setSttSaving(true);
    try {
      const res = await updateVoiceSettings({
        sttProvider: activeStt,
        sttLanguage: sttLanguage,
        sttProviderUpdate: {
          provider: activeStt,
          model: sttModel,
          baseUrl: sttBaseUrl,
          language: sttLanguage,
          apiKey: sttApiKey.trim() || undefined,
        },
      });
      setSettings(res.settings);
      setSttApiKey("");
      toast.success("Speech-to-text settings saved");
    } catch {
      toast.error("Failed to save speech-to-text settings");
    } finally {
      setSttSaving(false);
    }
  };

  const handleClearSttKey = async () => {
    setSttSaving(true);
    try {
      const res = await updateVoiceSettings({
        sttProviderUpdate: {
          provider: activeStt,
          clearApiKey: true,
        },
      });
      setSettings(res.settings);
      setSttApiKey("");
      toast.success("API key cleared");
    } catch {
      toast.error("Failed to clear API key");
    } finally {
      setSttSaving(false);
    }
  };

  const currentTtsEntry =
    ttsCatalog.find((c) => c.id === activeTts) || ttsCatalog[0];
  const currentTtsState = settings.ttsProviders[activeTts];
  const currentSttEntry =
    sttCatalog.find((c) => c.id === activeStt) || sttCatalog[0];
  const currentSttState = settings.sttProviders[activeStt];

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-3xl mx-auto px-8 py-8 flex flex-col gap-8">
        {/* Page header */}
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold tracking-tight">
            Voice &amp; Speech
          </h2>
          <p className="text-sm text-muted-foreground">
            Configure text-to-speech narration, speech recognition dictation,
            and custom 9Router endpoints.
          </p>
        </div>

        {/* Section 1: Read Aloud & Output Behavior */}
        <Card data-testid="voice-read-aloud-card" className="border shadow-xs">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">
              Read Aloud &amp; Output Behavior
            </CardTitle>
            <CardDescription>
              Control when assistant answers are spoken aloud.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label
                  htmlFor="read-aloud-toggle"
                  className="text-sm font-medium"
                >
                  Enable Read Aloud action on messages
                </Label>
                <p className="text-xs text-muted-foreground">
                  Shows a speaker button on assistant messages to narrate
                  responses on demand.
                </p>
              </div>
              <Switch
                id="read-aloud-toggle"
                data-testid="voice-read-aloud-enabled-toggle"
                checked={readAloudEnabled}
                onCheckedChange={handleToggleReadAloud}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label
                  htmlFor="auto-read-aloud-toggle"
                  className="text-sm font-medium"
                >
                  Automatically read aloud assistant replies when chat finishes
                </Label>
                <p className="text-xs text-muted-foreground">
                  Starts speaking the assistant reply as soon as generation
                  completes.
                </p>
              </div>
              <Switch
                id="auto-read-aloud-toggle"
                data-testid="voice-auto-read-aloud-toggle"
                checked={autoReadAloud}
                onCheckedChange={handleToggleAutoReadAloud}
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Text-to-Speech (TTS) Provider & Credentials */}
        <Card data-testid="voice-tts-card" className="border shadow-xs">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold">
                  Text-to-Speech (TTS) Provider &amp; Credentials
                </CardTitle>
                <CardDescription>
                  Select the synthesis engine used to generate spoken audio.
                </CardDescription>
              </div>
              {currentTtsEntry?.keyless ? (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="size-3 text-emerald-500" />
                  Built-in
                </Badge>
              ) : currentTtsState?.configured ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                >
                  <CheckCircle2 className="size-3" />
                  Configured{" "}
                  {currentTtsState.apiKeyHint
                    ? `(${currentTtsState.apiKeyHint})`
                    : ""}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  Not configured
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* Provider Selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">TTS Provider</Label>
              <Select value={activeTts} onValueChange={handleTtsProviderChange}>
                <SelectTrigger
                  data-testid="tts-provider-select"
                  className="w-full"
                >
                  <SelectValue placeholder="Select TTS Provider" />
                </SelectTrigger>
                <SelectContent>
                  {ttsCatalog.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentTtsEntry?.subtitle && (
                <p className="text-xs text-muted-foreground">
                  {currentTtsEntry.subtitle}
                </p>
              )}
            </div>

            {/* Base URL Input */}
            {currentTtsEntry?.supportsBaseUrl && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="tts-base-url" className="text-sm font-medium">
                    Base URL{" "}
                    {currentTtsEntry.requiresBaseUrl && (
                      <span className="text-destructive">*</span>
                    )}
                  </Label>
                  {currentTtsEntry.defaultBaseUrl && (
                    <span className="text-xs text-muted-foreground">
                      Default: {currentTtsEntry.defaultBaseUrl}
                    </span>
                  )}
                </div>
                <Input
                  id="tts-base-url"
                  data-testid="tts-base-url-input"
                  placeholder={
                    currentTtsEntry.defaultBaseUrl ||
                    "http://localhost:20128/v1"
                  }
                  value={ttsBaseUrl}
                  onChange={(e) => setTtsBaseUrl(e.target.value)}
                />
              </div>
            )}

            {/* API Key Input */}
            {!currentTtsEntry?.keyless && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="tts-api-key" className="text-sm font-medium">
                    API Key
                  </Label>
                  <div className="flex items-center gap-2">
                    {currentTtsState?.configured && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={handleClearTtsKey}
                      >
                        Clear Key
                      </Button>
                    )}
                    {currentTtsEntry?.docsUrl && (
                      <a
                        href={currentTtsEntry.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Docs <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                </div>
                <Input
                  id="tts-api-key"
                  type="password"
                  data-testid="tts-api-key-input"
                  placeholder={
                    currentTtsState?.configured
                      ? "Key is configured (enter new key to replace)"
                      : currentTtsEntry?.apiKeyPlaceholder || "Enter API key"
                  }
                  value={ttsApiKey}
                  onChange={(e) => setTtsApiKey(e.target.value)}
                />
              </div>
            )}

            {/* Model Input / Selection */}
            {currentTtsEntry?.supportsModelSelection && (
              <div className="space-y-2">
                <Label htmlFor="tts-model" className="text-sm font-medium">
                  Model
                </Label>
                <div className="flex flex-col gap-2">
                  <Input
                    id="tts-model"
                    data-testid="tts-model-input"
                    placeholder={
                      currentTtsEntry.defaultModel || "Enter model name"
                    }
                    value={ttsModel}
                    onChange={(e) => setTtsModel(e.target.value)}
                  />
                  {currentTtsEntry.models &&
                    currentTtsEntry.models.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {currentTtsEntry.models.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setTtsModel(m)}
                            className={`rounded-md px-2 py-0.5 text-xs transition-colors border ${
                              ttsModel === m
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted hover:bg-accent text-muted-foreground hover:text-foreground border-transparent"
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            )}

            {/* Voice / Reference ID Input / Selection */}
            {currentTtsEntry?.supportsVoiceSelection && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="tts-voice" className="text-sm font-medium">
                    Voice / Reference ID
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="tts-fetch-voices-button"
                    disabled={fetchingVoices}
                    onClick={handleFetchVoices}
                    className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw
                      className={`size-3 ${fetchingVoices ? "animate-spin" : ""}`}
                    />
                    Fetch Available Voices
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Input
                      id="tts-voice"
                      data-testid="tts-voice-input"
                      placeholder={
                        currentTtsEntry.defaultVoice ||
                        "Enter voice ID or reference ID"
                      }
                      value={ttsVoice}
                      onChange={(e) => setTtsVoice(e.target.value)}
                      className="flex-1"
                    />
                    {ttsVoice.trim() && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="tts-preview-entered-voice-button"
                        onClick={() => handlePreviewVoice(ttsVoice.trim())}
                        className="shrink-0 gap-1.5"
                      >
                        {activeMessageId ===
                          `voice-preview-${ttsVoice.trim()}` &&
                        readAloudStatus !== "idle" ? (
                          <>
                            <Square className="size-3.5 fill-current text-destructive" />
                            Stop
                          </>
                        ) : (
                          <>
                            <Play className="size-3.5" />
                            Preview ID
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                  {(() => {
                    const voiceOptions: VoiceOptionItem[] =
                      fetchedVoices[activeTts] ??
                      (currentTtsEntry.voices || []).map((id) => ({
                        id,
                        name: id,
                      }));
                    if (voiceOptions.length === 0) return null;
                    return (
                      <div
                        className="flex flex-wrap gap-1.5 pt-1"
                        data-testid="tts-voice-options-list"
                      >
                        {voiceOptions.map((v) => {
                          const isSelected = ttsVoice === v.id;
                          const isPreviewing =
                            activeMessageId === `voice-preview-${v.id}` &&
                            readAloudStatus !== "idle";
                          return (
                            <div
                              key={v.id}
                              className={`inline-flex items-center rounded-md border text-xs transition-colors ${
                                isSelected
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-muted/70 hover:bg-accent text-muted-foreground hover:text-foreground border-border/60"
                              }`}
                            >
                              <button
                                type="button"
                                data-testid={`tts-voice-chip-${v.id}`}
                                onClick={() => setTtsVoice(v.id)}
                                className="px-2.5 py-1 font-medium"
                                title={`Select voice ${v.name} (${v.id})`}
                              >
                                {v.name !== v.id ? `${v.name} (${v.id})` : v.id}
                              </button>
                              <button
                                type="button"
                                data-testid={`tts-voice-preview-${v.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handlePreviewVoice(v.id);
                                }}
                                aria-label={`Test voice ${v.name}`}
                                title={`Test voice ${v.name} before selecting`}
                                className={`border-l px-1.5 py-1 transition-colors ${
                                  isSelected
                                    ? "border-primary-foreground/30 hover:bg-primary-foreground/15"
                                    : "border-border/60 hover:bg-background/60"
                                }`}
                              >
                                {isPreviewing ? (
                                  <Square className="size-3 fill-current text-destructive" />
                                ) : (
                                  <Volume2 className="size-3" />
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="tts-test-button"
                onClick={handleTestVoice}
                className="gap-2"
              >
                {isTestingVoice ? (
                  <>
                    <VolumeX className="size-4 text-destructive" />
                    Stop Voice Preview
                  </>
                ) : (
                  <>
                    <Volume2 className="size-4" />
                    Test Voice
                  </>
                )}
              </Button>
              <Button
                type="button"
                data-testid="tts-save-button"
                size="sm"
                disabled={ttsSaving}
                onClick={handleSaveTts}
              >
                {ttsSaving && (
                  <Loader2 className="size-3.5 animate-spin mr-2" />
                )}
                Save TTS Settings
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Speech-to-Text (STT) Provider & Dictation */}
        <Card data-testid="voice-stt-card" className="border shadow-xs">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold">
                  Speech-to-Text (STT) Provider &amp; Dictation
                </CardTitle>
                <CardDescription>
                  Select the speech recognition provider for microphone
                  dictation in the composer.
                </CardDescription>
              </div>
              {currentSttEntry?.keyless ? (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="size-3 text-emerald-500" />
                  Built-in
                </Badge>
              ) : currentSttState?.configured ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                >
                  <CheckCircle2 className="size-3" />
                  Configured{" "}
                  {currentSttState.apiKeyHint
                    ? `(${currentSttState.apiKeyHint})`
                    : ""}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  Not configured
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* Provider Selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">STT Provider</Label>
              <Select value={activeStt} onValueChange={handleSttProviderChange}>
                <SelectTrigger
                  data-testid="stt-provider-select"
                  className="w-full"
                >
                  <SelectValue placeholder="Select STT Provider" />
                </SelectTrigger>
                <SelectContent>
                  {sttCatalog.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentSttEntry?.subtitle && (
                <p className="text-xs text-muted-foreground">
                  {currentSttEntry.subtitle}
                </p>
              )}
            </div>

            {/* Base URL Input */}
            {currentSttEntry?.supportsBaseUrl && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="stt-base-url" className="text-sm font-medium">
                    Base URL{" "}
                    {currentSttEntry.requiresBaseUrl && (
                      <span className="text-destructive">*</span>
                    )}
                  </Label>
                  {currentSttEntry.defaultBaseUrl && (
                    <span className="text-xs text-muted-foreground">
                      Default: {currentSttEntry.defaultBaseUrl}
                    </span>
                  )}
                </div>
                <Input
                  id="stt-base-url"
                  data-testid="stt-base-url-input"
                  placeholder={
                    currentSttEntry.defaultBaseUrl ||
                    "http://localhost:20128/v1"
                  }
                  value={sttBaseUrl}
                  onChange={(e) => setSttBaseUrl(e.target.value)}
                />
              </div>
            )}

            {/* API Key Input */}
            {!currentSttEntry?.keyless && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="stt-api-key" className="text-sm font-medium">
                    API Key
                  </Label>
                  <div className="flex items-center gap-2">
                    {currentSttState?.configured && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={handleClearSttKey}
                      >
                        Clear Key
                      </Button>
                    )}
                    {currentSttEntry?.docsUrl && (
                      <a
                        href={currentSttEntry.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Docs <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                </div>
                <Input
                  id="stt-api-key"
                  type="password"
                  data-testid="stt-api-key-input"
                  placeholder={
                    currentSttState?.configured
                      ? "Key is configured (enter new key to replace)"
                      : currentSttEntry?.apiKeyPlaceholder || "Enter API key"
                  }
                  value={sttApiKey}
                  onChange={(e) => setSttApiKey(e.target.value)}
                />
              </div>
            )}

            {/* Model Input / Selection */}
            {currentSttEntry?.supportsModelSelection && (
              <div className="space-y-2">
                <Label htmlFor="stt-model" className="text-sm font-medium">
                  Model
                </Label>
                <div className="flex flex-col gap-2">
                  <Input
                    id="stt-model"
                    data-testid="stt-model-input"
                    placeholder={
                      currentSttEntry.defaultModel || "Enter model name"
                    }
                    value={sttModel}
                    onChange={(e) => setSttModel(e.target.value)}
                  />
                  {currentSttEntry.models &&
                    currentSttEntry.models.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {currentSttEntry.models.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setSttModel(m)}
                            className={`rounded-md px-2 py-0.5 text-xs transition-colors border ${
                              sttModel === m
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted hover:bg-accent text-muted-foreground hover:text-foreground border-transparent"
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            )}

            {/* Spoken Language Selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Spoken Language</Label>
              <Select value={sttLanguage} onValueChange={setSttLanguage}>
                <SelectTrigger
                  data-testid="stt-language-select"
                  className="w-full"
                >
                  <SelectValue placeholder="Select Language" />
                </SelectTrigger>
                <SelectContent>
                  {STT_LANGUAGES.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                data-testid="stt-save-button"
                size="sm"
                disabled={sttSaving}
                onClick={handleSaveStt}
              >
                {sttSaving && (
                  <Loader2 className="size-3.5 animate-spin mr-2" />
                )}
                Save STT Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
