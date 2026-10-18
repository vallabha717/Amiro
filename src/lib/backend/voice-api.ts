import { apiFetch, apiJson } from "./client";

export const VOICE_SETTINGS_KEY = "/api/voice/settings";
export const VOICE_SETTINGS_STORAGE_KEY = "amiro.voice.settings";

export interface VoiceProviderCatalogEntry {
  id: string;
  name?: string;
  displayName: string;
  subtitle: string;
  defaultModel: string;
  defaultVoice?: string;
  voices?: string[];
  models: string[];
  supportsVoiceSelection?: boolean;
  supportsModelSelection?: boolean;
  supportsBaseUrl?: boolean;
  requiresBaseUrl?: boolean;
  defaultBaseUrl?: string;
  apiKeyPlaceholder?: string;
  docsUrl?: string;
  keyless?: boolean;
}

export interface VoiceOptionItem {
  id: string;
  name: string;
  previewUrl?: string;
  category?: string;
}

export interface FetchProviderVoicesParams {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface FetchProviderVoicesResponse {
  provider: string;
  voices: VoiceOptionItem[];
}

export interface ConfiguredTtsProviderState {
  model: string;
  voiceId: string;
  baseUrl: string;
  speed: number;
  configured: boolean;
  apiKeyHint?: string;
}

export interface ConfiguredSttProviderState {
  model: string;
  baseUrl: string;
  language: string;
  configured: boolean;
  apiKeyHint?: string;
}

export interface VoiceSettingsData {
  readAloudEnabled: boolean;
  autoReadAloud: boolean;
  ttsProvider: string;
  sttProvider: string;
  sttLanguage: string;
  ttsProviders: Record<string, ConfiguredTtsProviderState>;
  sttProviders: Record<string, ConfiguredSttProviderState>;
}

export interface VoiceSettingsResponse {
  ttsCatalog: VoiceProviderCatalogEntry[];
  sttCatalog: VoiceProviderCatalogEntry[];
  settings: VoiceSettingsData;
}

export interface UpdateVoiceSettingsPayload {
  readAloudEnabled?: boolean;
  autoReadAloud?: boolean;
  ttsProvider?: string;
  sttProvider?: string;
  sttLanguage?: string;
  ttsProviderUpdate?: {
    provider: string;
    model?: string;
    voiceId?: string;
    baseUrl?: string;
    speed?: number;
    apiKey?: string;
    clearApiKey?: boolean;
  };
  sttProviderUpdate?: {
    provider: string;
    model?: string;
    baseUrl?: string;
    language?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  };
}

export interface SynthesizeSpeechParams {
  text: string;
  provider?: string;
  voiceId?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  speed?: number;
}

export interface TranscribeSpeechParams {
  audio: string;
  mimeType: string;
  provider?: string;
  model?: string;
  language?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface TranscribeSpeechResult {
  status: string;
  text: string;
  providerId: string;
}

export const FALLBACK_TTS_CATALOG: VoiceProviderCatalogEntry[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    subtitle:
      "Fast, natural text-to-speech with alloy, echo, fable, onyx, nova, and shimmer",
    defaultModel: "tts-1",
    defaultVoice: "alloy",
    voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    models: ["tts-1", "tts-1-hd"],
    supportsVoiceSelection: true,
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyPlaceholder: "sk-...",
    docsUrl: "https://platform.openai.com/docs/guides/text-to-speech",
  },
  {
    id: "elevenlabs",
    displayName: "ElevenLabs",
    subtitle: "Industry-leading expressive AI voices and voice cloning",
    defaultModel: "eleven_turbo_v2_5",
    defaultVoice: "21m00Tcm4TlvDq8ikWAM",
    voices: [
      "21m00Tcm4TlvDq8ikWAM",
      "AZnzlk1XvdvUeBnXmlld",
      "EXAVITQu4vr4xnSDxMaL",
      "ErXwobaYiN019PkySvjV",
      "MF3mGyEYCl7XYWbV9V6O",
      "TxGEqnHWrfWFTfGW9XjX",
      "VR6AewLTigWG4xVXQiKG",
      "pNInz6obpgDQGcFmaJgB",
      "yoZ06aMxZJJ28mfd3POQ",
    ],
    models: [
      "eleven_turbo_v2_5",
      "eleven_multilingual_v2",
      "eleven_flash_v2_5",
    ],
    supportsVoiceSelection: true,
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    apiKeyPlaceholder: "xi-api-key...",
    docsUrl: "https://elevenlabs.io/docs",
  },
  {
    id: "deepgram",
    displayName: "Deepgram Aura",
    subtitle: "Ultra-low latency conversational text-to-speech",
    defaultModel: "aura-asteria-en",
    defaultVoice: "aura-asteria-en",
    voices: [
      "aura-asteria-en",
      "aura-luna-en",
      "aura-stella-en",
      "aura-athena-en",
      "aura-hera-en",
      "aura-orion-en",
      "aura-arcas-en",
      "aura-perseus-en",
      "aura-angus-en",
      "aura-orpheus-en",
      "aura-helios-en",
      "aura-zeus-en",
    ],
    models: [
      "aura-asteria-en",
      "aura-luna-en",
      "aura-stella-en",
      "aura-athena-en",
      "aura-hera-en",
      "aura-orion-en",
      "aura-arcas-en",
    ],
    supportsVoiceSelection: true,
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.deepgram.com/v1",
    apiKeyPlaceholder: "Token...",
    docsUrl: "https://developers.deepgram.com/docs/tts-models",
  },
  {
    id: "fish-audio",
    displayName: "Fish Audio",
    subtitle: "Expressive open-weights TTS and voice reference engine",
    defaultModel: "s1",
    defaultVoice: "default",
    voices: ["default", "energy", "calm"],
    models: ["s1"],
    supportsVoiceSelection: true,
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.fish.audio/v1",
    apiKeyPlaceholder: "Bearer token...",
    docsUrl: "https://fish.audio/docs",
  },
  {
    id: "xai",
    displayName: "xAI Grok Voice",
    subtitle: "xAI speech synthesis engine",
    defaultModel: "grok-tts",
    defaultVoice: "eve",
    voices: ["eve", "ara"],
    models: ["grok-tts"],
    supportsVoiceSelection: true,
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyPlaceholder: "xai-...",
    docsUrl: "https://docs.x.ai",
  },
  {
    id: "custom-openai",
    displayName: "Custom OpenAI-Compatible / 9Router",
    subtitle:
      "Self-hosted or multi-provider reverse proxy (e.g. 9Router, LocalAI, vLLM)",
    defaultModel: "tts-1",
    defaultVoice: "alloy",
    voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    models: ["tts-1", "tts-1-hd"],
    supportsVoiceSelection: true,
    supportsModelSelection: true,
    supportsBaseUrl: true,
    requiresBaseUrl: true,
    defaultBaseUrl: "http://localhost:20128/v1",
    apiKeyPlaceholder: "Bearer token if required...",
    docsUrl: "https://platform.openai.com/docs/api-reference/audio",
  },
  {
    id: "browser-native",
    displayName: "Browser Native (Web Speech API)",
    subtitle:
      "Zero-setup in-browser speech synthesis, completely offline and keyless",
    defaultModel: "browser-default",
    defaultVoice: "default",
    voices: ["default"],
    models: ["browser-default"],
    supportsVoiceSelection: false,
    supportsModelSelection: false,
    supportsBaseUrl: false,
    keyless: true,
  },
];

export const FALLBACK_STT_CATALOG: VoiceProviderCatalogEntry[] = [
  {
    id: "deepgram",
    displayName: "Deepgram Nova",
    subtitle: "Fast, accurate streaming and batch speech recognition",
    defaultModel: "nova-3",
    models: ["nova-3", "nova-2", "nova-2-general", "nova-2-meeting"],
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.deepgram.com/v1",
    apiKeyPlaceholder: "Token...",
    docsUrl: "https://developers.deepgram.com/docs/stt-models",
  },
  {
    id: "openai",
    displayName: "OpenAI Whisper",
    subtitle: "Robust multilingual speech-to-text",
    defaultModel: "whisper-1",
    models: ["whisper-1"],
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyPlaceholder: "sk-...",
    docsUrl: "https://platform.openai.com/docs/guides/speech-to-text",
  },
  {
    id: "groq",
    displayName: "Groq Whisper",
    subtitle: "Ultra-fast Whisper transcription hosted on LPUs",
    defaultModel: "whisper-large-v3",
    models: [
      "whisper-large-v3",
      "whisper-large-v3-turbo",
      "distil-whisper-large-v3-en",
    ],
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyPlaceholder: "gsk_...",
    docsUrl: "https://console.groq.com/docs/speech-text",
  },
  {
    id: "elevenlabs",
    displayName: "ElevenLabs Scribe",
    subtitle: "Accurate speech recognition with speaker diarization",
    defaultModel: "scribe_v1",
    models: ["scribe_v1"],
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    apiKeyPlaceholder: "xi-api-key...",
    docsUrl: "https://elevenlabs.io/docs",
  },
  {
    id: "xai",
    displayName: "xAI Grok STT",
    subtitle: "Speech transcription by xAI",
    defaultModel: "grok-stt",
    models: ["grok-stt"],
    supportsModelSelection: true,
    supportsBaseUrl: true,
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyPlaceholder: "xai-...",
    docsUrl: "https://docs.x.ai",
  },
  {
    id: "custom-openai",
    displayName: "Custom OpenAI-Compatible / 9Router",
    subtitle:
      "Self-hosted or reverse proxy transcription endpoint (/v1/audio/transcriptions)",
    defaultModel: "whisper-1",
    models: ["whisper-1"],
    supportsModelSelection: true,
    supportsBaseUrl: true,
    requiresBaseUrl: true,
    defaultBaseUrl: "http://localhost:20128/v1",
    apiKeyPlaceholder: "Bearer token if required...",
    docsUrl:
      "https://platform.openai.com/docs/api-reference/audio/createTranscription",
  },
  {
    id: "browser-native",
    displayName: "Browser Native (SpeechRecognition)",
    subtitle: "Zero-setup in-browser speech recognition (Web Speech API)",
    defaultModel: "browser-default",
    models: ["browser-default"],
    supportsModelSelection: false,
    supportsBaseUrl: false,
    keyless: true,
  },
];

export const DEFAULT_VOICE_SETTINGS: VoiceSettingsData = {
  readAloudEnabled: true,
  autoReadAloud: false,
  ttsProvider: "browser-native",
  sttProvider: "browser-native",
  sttLanguage: "en",
  ttsProviders: {
    "browser-native": {
      model: "browser-default",
      voiceId: "default",
      baseUrl: "",
      speed: 1.0,
      configured: true,
    },
    openai: {
      model: "tts-1",
      voiceId: "alloy",
      baseUrl: "https://api.openai.com/v1",
      speed: 1.0,
      configured: false,
    },
    elevenlabs: {
      model: "eleven_turbo_v2_5",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      baseUrl: "https://api.elevenlabs.io/v1",
      speed: 1.0,
      configured: false,
    },
    deepgram: {
      model: "aura-asteria-en",
      voiceId: "aura-asteria-en",
      baseUrl: "https://api.deepgram.com/v1",
      speed: 1.0,
      configured: false,
    },
    "fish-audio": {
      model: "s1",
      voiceId: "default",
      baseUrl: "https://api.fish.audio/v1",
      speed: 1.0,
      configured: false,
    },
    xai: {
      model: "grok-tts",
      voiceId: "eve",
      baseUrl: "https://api.x.ai/v1",
      speed: 1.0,
      configured: false,
    },
    "custom-openai": {
      model: "tts-1",
      voiceId: "alloy",
      baseUrl: "http://localhost:20128/v1",
      speed: 1.0,
      configured: false,
    },
  },
  sttProviders: {
    "browser-native": {
      model: "browser-default",
      baseUrl: "",
      language: "en",
      configured: true,
    },
    deepgram: {
      model: "nova-3",
      baseUrl: "https://api.deepgram.com/v1",
      language: "en",
      configured: false,
    },
    openai: {
      model: "whisper-1",
      baseUrl: "https://api.openai.com/v1",
      language: "en",
      configured: false,
    },
    groq: {
      model: "whisper-large-v3",
      baseUrl: "https://api.groq.com/openai/v1",
      language: "en",
      configured: false,
    },
    elevenlabs: {
      model: "scribe_v1",
      baseUrl: "https://api.elevenlabs.io/v1",
      language: "en",
      configured: false,
    },
    xai: {
      model: "grok-stt",
      baseUrl: "https://api.x.ai/v1",
      language: "en",
      configured: false,
    },
    "custom-openai": {
      model: "whisper-1",
      baseUrl: "http://localhost:20128/v1",
      language: "en",
      configured: false,
    },
  },
};

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "••••";
  return `••••${key.slice(-4)}`;
}

export function applyLocalSettingsUpdate(
  current: VoiceSettingsData,
  payload: UpdateVoiceSettingsPayload,
): VoiceSettingsData {
  const updated: VoiceSettingsData = {
    ...current,
    ttsProviders: { ...current.ttsProviders },
    sttProviders: { ...current.sttProviders },
  };

  if (typeof payload.readAloudEnabled === "boolean") {
    updated.readAloudEnabled = payload.readAloudEnabled;
  }
  if (typeof payload.autoReadAloud === "boolean") {
    updated.autoReadAloud = payload.autoReadAloud;
  }
  if (payload.ttsProvider) {
    updated.ttsProvider = payload.ttsProvider;
  }
  if (payload.sttProvider) {
    updated.sttProvider = payload.sttProvider;
  }
  if (payload.sttLanguage) {
    updated.sttLanguage = payload.sttLanguage;
  }

  if (payload.ttsProviderUpdate) {
    const { provider, model, voiceId, baseUrl, speed, apiKey, clearApiKey } =
      payload.ttsProviderUpdate;
    const existing = updated.ttsProviders[provider] ?? {
      model: "",
      voiceId: "",
      baseUrl: "",
      speed: 1.0,
      configured: false,
    };
    const nextTtsState: ConfiguredTtsProviderState = { ...existing };
    if (model !== undefined) nextTtsState.model = model;
    if (voiceId !== undefined) nextTtsState.voiceId = voiceId;
    if (baseUrl !== undefined) nextTtsState.baseUrl = baseUrl;
    if (speed !== undefined) nextTtsState.speed = speed;
    if (clearApiKey) {
      nextTtsState.configured = provider === "browser-native";
      nextTtsState.apiKeyHint = undefined;
    } else if (apiKey) {
      nextTtsState.configured = true;
      nextTtsState.apiKeyHint = maskApiKey(apiKey);
    }
    updated.ttsProviders[provider] = nextTtsState;
  }

  if (payload.sttProviderUpdate) {
    const { provider, model, baseUrl, language, apiKey, clearApiKey } =
      payload.sttProviderUpdate;
    const existing = updated.sttProviders[provider] ?? {
      model: "",
      baseUrl: "",
      language: "en",
      configured: false,
    };
    const nextSttState: ConfiguredSttProviderState = { ...existing };
    if (model !== undefined) nextSttState.model = model;
    if (baseUrl !== undefined) nextSttState.baseUrl = baseUrl;
    if (language !== undefined) nextSttState.language = language;
    if (clearApiKey) {
      nextSttState.configured = provider === "browser-native";
      nextSttState.apiKeyHint = undefined;
    } else if (apiKey) {
      nextSttState.configured = true;
      nextSttState.apiKeyHint = maskApiKey(apiKey);
    }
    updated.sttProviders[provider] = nextSttState;
  }

  return updated;
}

export function getCachedVoiceSettings(): VoiceSettingsData {
  if (typeof window === "undefined") {
    return DEFAULT_VOICE_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_VOICE_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_VOICE_SETTINGS,
      ...parsed,
      ttsProviders: {
        ...DEFAULT_VOICE_SETTINGS.ttsProviders,
        ...(parsed.ttsProviders || {}),
      },
      sttProviders: {
        ...DEFAULT_VOICE_SETTINGS.sttProviders,
        ...(parsed.sttProviders || {}),
      },
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export function setCachedVoiceSettings(settings: VoiceSettingsData): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // ignore quota/storage errors
  }
}

function normalizeCatalog(
  entries: VoiceProviderCatalogEntry[] | undefined,
  fallback: VoiceProviderCatalogEntry[],
): VoiceProviderCatalogEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return fallback;
  return entries.map((entry) => ({
    ...entry,
    displayName: entry.displayName || entry.name || entry.id,
  }));
}

export async function fetchVoiceSettings(): Promise<VoiceSettingsResponse> {
  try {
    const data = await apiJson<VoiceSettingsResponse>(VOICE_SETTINGS_KEY);
    if (data && data.settings) {
      setCachedVoiceSettings(data.settings);
      return {
        ttsCatalog: normalizeCatalog(data.ttsCatalog, FALLBACK_TTS_CATALOG),
        sttCatalog: normalizeCatalog(data.sttCatalog, FALLBACK_STT_CATALOG),
        settings: data.settings,
      };
    }
  } catch {
    // Backend offline / restarting / route pending: fallback to local cache + static catalog
  }
  const cached = getCachedVoiceSettings();
  return {
    ttsCatalog: FALLBACK_TTS_CATALOG,
    sttCatalog: FALLBACK_STT_CATALOG,
    settings: cached,
  };
}

export async function fetchProviderVoices(
  params: FetchProviderVoicesParams,
): Promise<VoiceOptionItem[]> {
  try {
    const res = await apiJson<FetchProviderVoicesResponse>("/api/tts/voices", {
      method: "POST",
      body: JSON.stringify(params),
    });
    if (res && Array.isArray(res.voices) && res.voices.length > 0) {
      return res.voices;
    }
  } catch {
    // Fallback to static catalog voices below
  }
  const entry = FALLBACK_TTS_CATALOG.find((p) => p.id === params.provider);
  return (entry?.voices || []).map((id) => ({ id, name: id }));
}

export async function updateVoiceSettings(
  payload: UpdateVoiceSettingsPayload,
): Promise<VoiceSettingsResponse> {
  const current = getCachedVoiceSettings();
  const nextSettings = applyLocalSettingsUpdate(current, payload);
  setCachedVoiceSettings(nextSettings);

  try {
    const data = await apiJson<VoiceSettingsResponse>(VOICE_SETTINGS_KEY, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (data && data.settings) {
      setCachedVoiceSettings(data.settings);
      return data;
    }
  } catch {
    // Backend offline or error: retain optimistic local updates
  }

  return {
    ttsCatalog: FALLBACK_TTS_CATALOG,
    sttCatalog: FALLBACK_STT_CATALOG,
    settings: nextSettings,
  };
}

export async function synthesizeSpeech(
  params: SynthesizeSpeechParams,
): Promise<Blob> {
  const res = await apiFetch("/api/tts/synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    let errorMsg = `Synthesis failed (${res.status})`;
    try {
      const err = await res.json();
      errorMsg = err.error || err.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }
  return await res.blob();
}

export async function transcribeSpeech(
  params: TranscribeSpeechParams,
): Promise<TranscribeSpeechResult> {
  return await apiJson<TranscribeSpeechResult>("/api/stt/transcribe", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
