"use client";

import { useMemo, useState, useEffect } from "react";
import {
  Volume2,
  Mic,
  Play,
  Square,
  Sparkles,
  Check,
  CheckCircle2,
  Loader2,
  Sliders,
  Globe,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DEFAULT_VOICE_SETTINGS,
  FALLBACK_STT_CATALOG,
  FALLBACK_TTS_CATALOG,
  getElevenLabsVoiceName,
  type VoiceProviderCatalogEntry,
  type VoiceSettingsData,
  fetchVoiceSettings,
  updateVoiceSettings,
} from "@/lib/backend/voice-api";
import { useMessageReadAloudStore } from "@/lib/ai/speech/read-aloud-store";
import { cn } from "lib/utils";

const STT_LANGUAGES = [
  { value: "en", label: "English", code: "en", flag: "🇺🇸" },
  { value: "hi", label: "Hindi (हिन्दी)", code: "hi", flag: "🇮🇳" },
  { value: "multi", label: "Multilingual (Auto-Detect)", code: "multi", flag: "🌐" },
];

// Curated high-craft voices with descriptions matching Vellum standards
const CURATED_VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", provider: "elevenlabs", style: "Soft, warm, approachable", accent: "American", gender: "Female" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", provider: "elevenlabs", style: "Warm, distinguished, articulate", accent: "British", gender: "Male" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", provider: "elevenlabs", style: "Calm, friendly, executive", accent: "American", gender: "Female" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", provider: "elevenlabs", style: "Strong, energetic, direct", accent: "American", gender: "Female" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", provider: "elevenlabs", style: "Deep, crisp, narrative", accent: "American", gender: "Male" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", provider: "elevenlabs", style: "Casual, relatable, warm", accent: "American", gender: "Male" },
  { id: "aura-2-thalia-en", name: "Thalia", provider: "deepgram", style: "Confident, dynamic, clear", accent: "American", gender: "Female" },
  { id: "aura-2-luna-en", name: "Luna", provider: "deepgram", style: "Friendly, casual, engaging", accent: "American", gender: "Female" },
  { id: "aura-2-zeus-en", name: "Zeus", provider: "deepgram", style: "Deep, authoritative, smooth", accent: "American", gender: "Male" },
  { id: "aura-2-apollo-en", name: "Apollo", provider: "deepgram", style: "Polite, upbeat, versatile", accent: "American", gender: "Male" },
  { id: "aura-2-draco-en", name: "Draco", provider: "deepgram", style: "Distinguished, warm baritone", accent: "British", gender: "Male" },
  { id: "alloy", name: "Alloy", provider: "openai", style: "Balanced, versatile, neutral", accent: "American", gender: "Neutral" },
  { id: "echo", name: "Echo", provider: "openai", style: "Smooth, warm, characterful", accent: "American", gender: "Male" },
  { id: "nova", name: "Nova", provider: "openai", style: "Energetic, bright, friendly", accent: "American", gender: "Female" },
  { id: "shimmer", name: "Shimmer", provider: "openai", style: "Clear, expressive, gentle", accent: "American", gender: "Female" },
  { id: "fable", name: "Fable", provider: "openai", style: "Expressive, animated, rhythmic", accent: "British", gender: "Neutral" },
];

export default function AdminVoicePage() {
  const [loading, setLoading] = useState(true);
  const [ttsCatalog, setTtsCatalog] = useState<VoiceProviderCatalogEntry[]>(FALLBACK_TTS_CATALOG);
  const [sttCatalog, setSttCatalog] = useState<VoiceProviderCatalogEntry[]>(FALLBACK_STT_CATALOG);
  const [settings, setSettings] = useState<VoiceSettingsData>(DEFAULT_VOICE_SETTINGS);

  // Active state
  const [activeTab, setActiveTab] = useState<"output" | "input" | "providers">("output");
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceGenderFilter, setVoiceGenderFilter] = useState<string>("all");

  // Read aloud store status for test voice button
  const readAloudStatus = useMessageReadAloudStore((s) => s.status);
  const activeMessageId = useMessageReadAloudStore((s) => s.messageId);

  // TTS states
  const [activeTts, setActiveTts] = useState("elevenlabs");
  const [currentVoiceId, setCurrentVoiceId] = useState("EXAVITQu4vr4xnSDxMaL");
  const [speed, setSpeed] = useState<number>(1.0);
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsSaving, setTtsSaving] = useState(false);

  // STT states
  const [activeStt, setActiveStt] = useState("deepgram");
  const [sttLanguage, setSttLanguage] = useState("en");
  const [sttApiKey, setSttApiKey] = useState("");
  const [sttBaseUrl, setSttBaseUrl] = useState("");
  const [sttSaving, setSttSaving] = useState(false);

  // Toggles
  const [readAloudEnabled, setReadAloudEnabled] = useState(true);
  const [autoReadAloud, setAutoReadAloud] = useState(false);

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

        const currentTts = res.settings.ttsProvider || "elevenlabs";
        setActiveTts(currentTts);
        const ttsState = res.settings.ttsProviders[currentTts];
        if (ttsState) {
          setCurrentVoiceId(ttsState.voiceId || "EXAVITQu4vr4xnSDxMaL");
          setTtsBaseUrl(ttsState.baseUrl || "");
          setSpeed(ttsState.speed || 1.0);
        }

        const currentStt = res.settings.sttProvider || "deepgram";
        setActiveStt(currentStt);
        setSttLanguage(res.settings.sttLanguage || "en");
        const sttState = res.settings.sttProviders[currentStt];
        if (sttState) {
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

  const handleSelectVoice = async (voice: typeof CURATED_VOICES[0]) => {
    setCurrentVoiceId(voice.id);
    setActiveTts(voice.provider);
    setVoicePickerOpen(false);

    try {
      const res = await updateVoiceSettings({
        ttsProvider: voice.provider,
        ttsProviderUpdate: {
          provider: voice.provider,
          voiceId: voice.id,
          speed,
        },
      });
      setSettings(res.settings);
      toast.success(`Voice set to ${voice.name}`);
    } catch {
      toast.error("Failed to update voice selection");
    }
  };

  const handlePreviewVoice = (voiceId: string, provider: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const previewMsgId = `voice-preview-${voiceId}`;
    if (activeMessageId === previewMsgId && readAloudStatus !== "idle") {
      useMessageReadAloudStore.getState().stop();
      return;
    }
    void useMessageReadAloudStore.getState().playMessage({
      messageId: previewMsgId,
      text: "Hello! This is a preview of my voice.",
      provider,
      voiceId,
      speed,
    });
  };

  const handleSaveTts = async () => {
    setTtsSaving(true);
    try {
      const res = await updateVoiceSettings({
        ttsProvider: activeTts,
        ttsProviderUpdate: {
          provider: activeTts,
          voiceId: currentVoiceId,
          baseUrl: ttsBaseUrl.trim() || undefined,
          apiKey: ttsApiKey.trim() || undefined,
          speed,
        },
      });
      setSettings(res.settings);
      setTtsApiKey("");
      toast.success("Voice settings saved");
    } catch {
      toast.error("Failed to save voice settings");
    } finally {
      setTtsSaving(false);
    }
  };

  const handleSaveStt = async () => {
    setSttSaving(true);
    try {
      const res = await updateVoiceSettings({
        sttProvider: activeStt,
        sttLanguage,
        sttProviderUpdate: {
          provider: activeStt,
          baseUrl: sttBaseUrl.trim() || undefined,
          language: sttLanguage,
          apiKey: sttApiKey.trim() || undefined,
        },
      });
      setSettings(res.settings);
      setSttApiKey("");
      toast.success("Speech recognition settings saved");
    } catch {
      toast.error("Failed to save speech recognition settings");
    } finally {
      setSttSaving(false);
    }
  };

  const activeVoiceObj = useMemo(() => {
    return (
      CURATED_VOICES.find((v) => v.id === currentVoiceId) ?? {
        id: currentVoiceId,
        name: getElevenLabsVoiceName(currentVoiceId) || currentVoiceId,
        provider: activeTts,
        style: "Custom Voice",
        accent: "Configured",
        gender: "Voice",
      }
    );
  }, [currentVoiceId, activeTts]);

  const filteredVoices = useMemo(() => {
    const q = voiceSearch.toLowerCase().trim();
    return CURATED_VOICES.filter((v) => {
      if (voiceGenderFilter !== "all" && v.gender.toLowerCase() !== voiceGenderFilter.toLowerCase()) {
        return false;
      }
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        v.style.toLowerCase().includes(q) ||
        v.accent.toLowerCase().includes(q) ||
        v.provider.toLowerCase().includes(q)
      );
    });
  }, [voiceSearch, voiceGenderFilter]);

  const currentTtsState = settings.ttsProviders[activeTts];
  const currentSttState = settings.sttProviders[activeStt];
  // Keyless engines (in-browser) have nothing to paste; "saved" is claimed
  // only when the vault really holds a key for the engine (it has a hint).
  const ttsKeyless = ttsCatalog.find((p) => p.id === activeTts)?.keyless;
  const sttKeyless = sttCatalog.find((p) => p.id === activeStt)?.keyless;

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto max-w-4xl px-6 py-8 flex flex-col gap-8">
        {/* Header */}
        <div className="flex flex-col gap-1 border-b border-border/60 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Voice &amp; Speech</h1>
            <p className="text-sm text-muted-foreground">
              Configure assistant voice output, speech recognition, and live voice mode.
            </p>
          </div>
          {/* Top navigation tabs: Output · Input · Engine Providers */}
          <div className="mt-4 flex items-center rounded-lg border border-border/80 bg-muted/40 p-1 sm:mt-0">
            <button
              type="button"
              onClick={() => setActiveTab("output")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
                activeTab === "output"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Output &amp; Voice
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("input")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
                activeTab === "input"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Input &amp; Speech
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("providers")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
                activeTab === "providers"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Engines &amp; Keys
            </button>
          </div>
        </div>

        {/* TAB 1: OUTPUT & VOICE (Vellum Clean Style) */}
        {activeTab === "output" && (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Primary Voice Card */}
            <Card className="overflow-hidden border border-border/80 bg-card/60 shadow-xs">
              <CardHeader className="border-b border-border/60 bg-muted/20 pb-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                      Spoken Output
                    </span>
                    <CardTitle className="text-lg font-bold">Assistant Voice</CardTitle>
                    <CardDescription className="text-xs">
                      How your assistant sounds during conversations, read-aloud, and phone calls.
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary text-xs">
                    {activeVoiceObj.provider.toUpperCase()}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4">
                    <div className="relative flex size-14 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-xs">
                      <Volume2 className="size-7" />
                      {activeMessageId === `voice-preview-${currentVoiceId}` && readAloudStatus !== "idle" && (
                        <span className="absolute -top-1 -right-1 flex size-3">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex size-3 rounded-full bg-primary" />
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-xl font-bold text-foreground">{activeVoiceObj.name}</h3>
                        <Badge variant="secondary" className="text-[10px] px-1.5 font-normal">
                          {activeVoiceObj.accent}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{activeVoiceObj.style}</p>
                      <p className="font-mono text-[11px] text-muted-foreground/80 mt-1">ID: {currentVoiceId}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => handlePreviewVoice(currentVoiceId, activeTts, e)}
                      className="gap-1.5 font-medium"
                    >
                      {activeMessageId === `voice-preview-${currentVoiceId}` && readAloudStatus !== "idle" ? (
                        <>
                          <Square className="size-3.5 fill-current text-destructive" />
                          Stop
                        </>
                      ) : (
                        <>
                          <Play className="size-3.5" />
                          Play Preview
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setVoicePickerOpen(true)}
                      className="gap-1.5 font-medium"
                      data-testid="change-voice-button"
                    >
                      <Sparkles className="size-3.5" />
                      Change Voice
                    </Button>
                  </div>
                </div>

                {/* Voice Speed Slider */}
                <div className="mt-6 border-t border-border/60 pt-5">
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Sliders className="size-3 text-muted-foreground" />
                      Playback Speed
                    </Label>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{speed.toFixed(2)}x</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[11px] text-muted-foreground">0.5x</span>
                    <input
                      type="range"
                      aria-label="Playback Speed"
                      min="0.5"
                      max="2.0"
                      step="0.05"
                      value={speed}
                      onChange={(e) => setSpeed(parseFloat(e.target.value))}
                      onMouseUp={handleSaveTts}
                      onTouchEnd={handleSaveTts}
                      className="h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-secondary accent-primary"
                    />
                    <span className="text-[11px] text-muted-foreground">2.0x</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Read Aloud Behavior */}
            <Card className="border border-border/80 bg-card/60 shadow-xs">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Read Aloud Preferences</CardTitle>
                <CardDescription className="text-xs">
                  Controls how speech is initiated in conversations.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-1">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Speaker icon on messages</p>
                    <p className="text-xs text-muted-foreground">
                      Shows a button next to assistant replies to read them aloud on demand.
                    </p>
                  </div>
                  <Switch
                    aria-label="Speaker icon on messages"
                    checked={readAloudEnabled}
                    onCheckedChange={async (val) => {
                      setReadAloudEnabled(val);
                      await updateVoiceSettings({ readAloudEnabled: val });
                      toast.success(val ? "Read-aloud buttons enabled" : "Read-aloud buttons disabled");
                    }}
                  />
                </div>
                <div className="border-t border-border/50 pt-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Automatic narration on complete</p>
                    <p className="text-xs text-muted-foreground">
                      Immediately starts speaking responses as soon as the agent finishes writing.
                    </p>
                  </div>
                  <Switch
                    aria-label="Automatic narration on complete"
                    checked={autoReadAloud}
                    onCheckedChange={async (val) => {
                      setAutoReadAloud(val);
                      await updateVoiceSettings({ autoReadAloud: val });
                      toast.success(val ? "Auto read-aloud enabled" : "Auto read-aloud disabled");
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 2: INPUT & SPEECH (Microphone, Language, Dictation) */}
        {activeTab === "input" && (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Spoken Language Card */}
            <Card className="border border-border/80 bg-card/60 shadow-xs">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <CardTitle className="text-base font-semibold flex items-center gap-2">
                      <Globe className="size-4 text-primary" />
                      Listening Language
                    </CardTitle>
                    <CardDescription className="text-xs">
                      The primary spoken language for dictation and speech recognition.
                    </CardDescription>
                  </div>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {sttLanguage}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {STT_LANGUAGES.map((lang) => {
                    const isSelected = sttLanguage === lang.value;
                    return (
                      <button
                        key={lang.value}
                        type="button"
                        onClick={async () => {
                          setSttLanguage(lang.value);
                          await updateVoiceSettings({ sttLanguage: lang.value });
                          toast.success(`Language set to ${lang.label}`);
                        }}
                        className={cn(
                          "flex items-center justify-between rounded-xl border p-3 text-left transition-all",
                          isSelected
                            ? "border-primary bg-primary/10 text-foreground font-semibold shadow-xs"
                            : "border-border/70 bg-card/40 text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-base">{lang.flag}</span>
                          <span className="truncate text-xs">{lang.label}</span>
                        </div>
                        {isSelected && <Check className="size-3.5 shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Dictation Engine Status */}
            <Card className="border border-border/80 bg-card/60 shadow-xs">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <CardTitle className="text-base font-semibold flex items-center gap-2">
                      <Mic className="size-4 text-primary" />
                      Speech-to-Text Dictation
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Backend engine powering voice recognition in chat.
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs">
                    <CheckCircle2 className="size-3 mr-1" />
                    {activeStt.toUpperCase()}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-1">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Amiro uses <strong className="text-foreground font-semibold">{activeStt.toUpperCase()}</strong> with
                  Nova-3 and streaming turn detection. You can dictate into any prompt using the microphone button or the Talk shortcut.
                </p>
                <div className="flex items-center gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => setActiveTab("providers")}>
                    Manage STT Provider &amp; Keys
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 3: ENGINES & KEYS (Technical Backend Settings) */}
        {activeTab === "providers" && (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* TTS Engine Config */}
            <Card className="border border-border/80 bg-card/60 shadow-xs">
              <CardHeader className="pb-3 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">TTS Provider Configuration</CardTitle>
                    <CardDescription className="text-xs">
                      Configure your text-to-speech engine credentials and endpoints.
                    </CardDescription>
                  </div>
                  {currentTtsState?.configured && (
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs">
                      <CheckCircle2 className="size-3 mr-1" />
                      Connected {currentTtsState.apiKeyHint && `(${currentTtsState.apiKeyHint})`}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Engine</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {ttsCatalog.map((p) => {
                      const selected = activeTts === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setActiveTts(p.id);
                            if (p.defaultVoice) setCurrentVoiceId(p.defaultVoice);
                          }}
                          className={cn(
                            "rounded-xl border p-2.5 text-center text-xs font-medium transition-all",
                            selected
                              ? "border-primary bg-primary/10 text-foreground font-semibold shadow-xs"
                              : "border-border/70 bg-card/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* API Key */}
                {!ttsKeyless && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-semibold">API Key</Label>
                      <span className="text-[11px] text-muted-foreground">Stored encrypted in vault</span>
                    </div>
                    <Input
                      type="password"
                      placeholder={currentTtsState?.apiKeyHint ? "•••• saved (paste new key to update)" : "Paste API key"}
                      value={ttsApiKey}
                      onChange={(e) => setTtsApiKey(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <Button size="sm" onClick={handleSaveTts} disabled={ttsSaving}>
                    {ttsSaving && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                    Save TTS Engine
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* STT Engine Config */}
            <Card className="border border-border/80 bg-card/60 shadow-xs">
              <CardHeader className="pb-3 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">STT Provider Configuration</CardTitle>
                    <CardDescription className="text-xs">
                      Configure speech recognition models and credentials.
                    </CardDescription>
                  </div>
                  {currentSttState?.configured && (
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs">
                      <CheckCircle2 className="size-3 mr-1" />
                      Connected {currentSttState.apiKeyHint && `(${currentSttState.apiKeyHint})`}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Engine</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {sttCatalog.map((p) => {
                      const selected = activeStt === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setActiveStt(p.id)}
                          className={cn(
                            "rounded-xl border p-2.5 text-center text-xs font-medium transition-all",
                            selected
                              ? "border-primary bg-primary/10 text-foreground font-semibold shadow-xs"
                              : "border-border/70 bg-card/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* STT API Key */}
                {!sttKeyless && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-semibold">API Key</Label>
                      <span className="text-[11px] text-muted-foreground">Stored encrypted in vault</span>
                    </div>
                    <Input
                      type="password"
                      placeholder={currentSttState?.apiKeyHint ? "•••• saved (paste new key to update)" : "Paste API key"}
                      value={sttApiKey}
                      onChange={(e) => setSttApiKey(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <Button size="sm" onClick={handleSaveStt} disabled={sttSaving}>
                    {sttSaving && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                    Save STT Engine
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* VOICE PICKER MODAL (Vellum Catalog Experience) */}
        <Dialog open={voicePickerOpen} onOpenChange={setVoicePickerOpen}>
          <DialogContent className="max-w-2xl p-0 overflow-hidden rounded-2xl">
            <DialogHeader className="p-6 border-b border-border/60 bg-muted/20">
              <div className="flex items-center justify-between">
                <div>
                  <DialogTitle className="text-lg font-bold">Choose a Voice</DialogTitle>
                  <DialogDescription className="text-xs">
                    Audition and select how your assistant speaks across conversations.
                  </DialogDescription>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name, accent, or style…"
                    value={voiceSearch}
                    onChange={(e) => setVoiceSearch(e.target.value)}
                    className="pl-9 h-9 text-xs rounded-full"
                  />
                </div>
                <div className="flex items-center gap-1">
                  {["all", "female", "male"].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setVoiceGenderFilter(g)}
                      className={cn(
                        "rounded-full px-3 py-1 text-xs capitalize transition-colors",
                        voiceGenderFilter === g
                          ? "bg-foreground text-background font-semibold"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            </DialogHeader>

            <ScrollArea className="max-h-[460px] p-6">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {filteredVoices.map((v) => {
                  const isSelected = currentVoiceId === v.id;
                  const isPlaying = activeMessageId === `voice-preview-${v.id}` && readAloudStatus !== "idle";
                  return (
                    <div
                      key={v.id}
                      onClick={() => handleSelectVoice(v)}
                      className={cn(
                        "group relative flex cursor-pointer items-start justify-between rounded-xl border p-3.5 transition-all",
                        isSelected
                          ? "border-primary bg-primary/10 shadow-xs"
                          : "border-border/70 bg-card/60 hover:border-foreground/20 hover:bg-accent/40",
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-sm text-foreground">{v.name}</span>
                          <span className="text-xs text-muted-foreground font-normal">· {v.accent}</span>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase tracking-wider ml-auto mr-1">
                            {v.provider}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1">{v.style}</p>
                      </div>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "size-8 shrink-0 rounded-full ml-2",
                          isPlaying ? "text-destructive" : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={(e) => handlePreviewVoice(v.id, v.provider, e)}
                        title={`Listen to ${v.name}`}
                      >
                        {isPlaying ? <Square className="size-4 fill-current" /> : <Play className="size-4" />}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
