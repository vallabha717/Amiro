import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "./client";
import {
  DEFAULT_VOICE_SETTINGS,
  FALLBACK_STT_CATALOG,
  FALLBACK_TTS_CATALOG,
  VOICE_SETTINGS_KEY,
  VOICE_SETTINGS_STORAGE_KEY,
  applyLocalSettingsUpdate,
  fetchVoiceSettings,
  getCachedVoiceSettings,
  setCachedVoiceSettings,
  updateVoiceSettings,
} from "./voice-api";

describe("voice-api", () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = {};

    const mockWindow = {
      localStorage: {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v;
        },
        removeItem: (k: string) => {
          delete mockStorage[k];
        },
      },
    };
    (globalThis as any).window = mockWindow;
  });

  it("contains all 7 required TTS providers in fallback catalog", () => {
    const ttsIds = FALLBACK_TTS_CATALOG.map((c) => c.id);
    expect(ttsIds).toEqual([
      "openai",
      "elevenlabs",
      "deepgram",
      "fish-audio",
      "xai",
      "custom-openai",
      "browser-native",
    ]);

    const customOpenai = FALLBACK_TTS_CATALOG.find(
      (c) => c.id === "custom-openai",
    );
    expect(customOpenai?.supportsBaseUrl).toBe(true);
    expect(customOpenai?.requiresBaseUrl).toBe(true);

    const browserNative = FALLBACK_TTS_CATALOG.find(
      (c) => c.id === "browser-native",
    );
    expect(browserNative?.keyless).toBe(true);
  });

  it("contains all 7 required STT providers in fallback catalog", () => {
    const sttIds = FALLBACK_STT_CATALOG.map((c) => c.id);
    expect(sttIds).toEqual([
      "deepgram",
      "openai",
      "groq",
      "elevenlabs",
      "xai",
      "custom-openai",
      "browser-native",
    ]);

    const customOpenai = FALLBACK_STT_CATALOG.find(
      (c) => c.id === "custom-openai",
    );
    expect(customOpenai?.supportsBaseUrl).toBe(true);
    expect(customOpenai?.requiresBaseUrl).toBe(true);

    const browserNative = FALLBACK_STT_CATALOG.find(
      (c) => c.id === "browser-native",
    );
    expect(browserNative?.keyless).toBe(true);
  });

  it("applies local settings updates properly and masks API key", () => {
    const updated = applyLocalSettingsUpdate(DEFAULT_VOICE_SETTINGS, {
      readAloudEnabled: true,
      autoReadAloud: true,
      ttsProvider: "openai",
      ttsProviderUpdate: {
        provider: "openai",
        model: "tts-1-hd",
        voiceId: "nova",
        apiKey: "sk-secret1234",
      },
      sttProvider: "groq",
      sttProviderUpdate: {
        provider: "groq",
        model: "whisper-large-v3",
        apiKey: "gsk_test5678",
      },
    });

    expect(updated.autoReadAloud).toBe(true);
    expect(updated.ttsProvider).toBe("openai");
    expect(updated.ttsProviders.openai.model).toBe("tts-1-hd");
    expect(updated.ttsProviders.openai.voiceId).toBe("nova");
    expect(updated.ttsProviders.openai.configured).toBe(true);
    expect(updated.ttsProviders.openai.apiKeyHint).toBe("••••1234");

    expect(updated.sttProvider).toBe("groq");
    expect(updated.sttProviders.groq.configured).toBe(true);
    expect(updated.sttProviders.groq.apiKeyHint).toBe("••••5678");
  });

  it("caches voice settings to localStorage", () => {
    expect(VOICE_SETTINGS_STORAGE_KEY).toBe("amiro.voice.settings");
    setCachedVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      autoReadAloud: true,
    });
    const retrieved = getCachedVoiceSettings();
    expect(retrieved.autoReadAloud).toBe(true);
  });

  it("fetchVoiceSettings returns remote response on success", async () => {
    const mockResponse = {
      ttsCatalog: FALLBACK_TTS_CATALOG,
      sttCatalog: FALLBACK_STT_CATALOG,
      settings: {
        ...DEFAULT_VOICE_SETTINGS,
        autoReadAloud: true,
      },
    };
    vi.spyOn(client, "apiJson").mockResolvedValue(mockResponse);

    const res = await fetchVoiceSettings();
    expect(res.settings.autoReadAloud).toBe(true);
    expect(client.apiJson).toHaveBeenCalledWith(VOICE_SETTINGS_KEY);
  });

  it("fetchVoiceSettings falls back to cached settings and static catalog when remote fails", async () => {
    vi.spyOn(client, "apiJson").mockRejectedValue(
      new Error("Connection refused"),
    );

    const res = await fetchVoiceSettings();
    expect(res.ttsCatalog.length).toBe(7);
    expect(res.sttCatalog.length).toBe(7);
    expect(res.settings.readAloudEnabled).toBe(true);
  });

  it("updateVoiceSettings sends PUT and updates local cache", async () => {
    const mockUpdatedResponse = {
      ttsCatalog: FALLBACK_TTS_CATALOG,
      sttCatalog: FALLBACK_STT_CATALOG,
      settings: {
        ...DEFAULT_VOICE_SETTINGS,
        autoReadAloud: true,
      },
    };
    vi.spyOn(client, "apiJson").mockResolvedValue(mockUpdatedResponse);

    const res = await updateVoiceSettings({ autoReadAloud: true });
    expect(res.settings.autoReadAloud).toBe(true);
    expect(client.apiJson).toHaveBeenCalledWith(VOICE_SETTINGS_KEY, {
      method: "PUT",
      body: JSON.stringify({ autoReadAloud: true }),
    });
  });
});
