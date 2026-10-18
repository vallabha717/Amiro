// adapter/src/routes/voice.mjs -- Vellum-style Voice & Speech routes (Node mirror).
//
// GET  /api/voice/settings  -> provider catalogs + non-secret settings with a
//                              per-provider `configured` flag and masked key hint.
// PUT  /api/voice/settings  -> update settings; API keys go to the encrypted
//                              credential store, never the settings file.
// POST /api/tts/synthesize  -> proxy text to a provider, return audio bytes.
// POST /api/stt/transcribe  -> decode base64 audio, proxy, return transcript.
//
// Mirrors backend/src/routes/voice.rs. Provider catalogs are identical so the
// UI renders the same options regardless of which server is running.

import { createCredentials } from '../credentials.mjs';

const SETTINGS_KEY = 'voice-settings.json';
const MAX_TTS_CHARS = 8192;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function ttsCatalog() {
  return [
    {
      id: 'openai',
      name: 'OpenAI Speech',
      displayName: 'OpenAI Speech',
      subtitle: 'OpenAI TTS (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`) with natural voices.',
      defaultModel: 'tts-1',
      defaultVoice: 'alloy',
      voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'],
      models: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
      supportsVoiceSelection: true,
      supportsModelSelection: true,
      supportsBaseUrl: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      apiKeyPlaceholder: 'sk-...',
      docsUrl: 'https://platform.openai.com/api-keys',
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      displayName: 'ElevenLabs',
      subtitle: 'High-quality expressive voice synthesis for conversations and read-aloud.',
      defaultModel: 'eleven_turbo_v2_5',
      defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
      voices: ['EXAVITQu4vr4xnSDxMaL', 'JBFqnCBsd6RMkjVDRZzb', '21m00Tcm4TlvDq8ikWAM', 'AZnzlk1XvdvUeBnXmlld', 'ErXwobaYiN019PkySvjV', 'TxGEqnHWrfWFTfGW9XjX'],
      voiceLabels: {
        EXAVITQu4vr4xnSDxMaL: 'Sarah',
        JBFqnCBsd6RMkjVDRZzb: 'George',
        '21m00Tcm4TlvDq8ikWAM': 'Rachel',
        AZnzlk1XvdvUeBnXmlld: 'Domi',
        ErXwobaYiN019PkySvjV: 'Antoni',
        TxGEqnHWrfWFTfGW9XjX: 'Josh',
      },
      models: ['eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_flash_v2_5'],
      supportsVoiceSelection: true,
      supportsModelSelection: true,
      supportsBaseUrl: true,
      defaultBaseUrl: 'https://api.elevenlabs.io',
      apiKeyPlaceholder: 'sk_...',
      docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    },
    {
      id: 'deepgram',
      name: 'Deepgram Aura',
      displayName: 'Deepgram Aura',
      subtitle: 'Fast, low-latency text-to-speech synthesis. Shares key with Deepgram STT.',
      defaultModel: 'aura-2-thalia-en',
      defaultVoice: 'aura-2-thalia-en',
      voices: ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-2-apollo-en', 'aura-asteria-en', 'aura-orion-en'],
      models: ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-2-apollo-en', 'aura-asteria-en'],
      supportsVoiceSelection: true,
      supportsModelSelection: true,
      supportsBaseUrl: false,
      defaultBaseUrl: 'https://api.deepgram.com',
      apiKeyPlaceholder: 'Enter your Deepgram API key',
      docsUrl: 'https://console.deepgram.com/',
    },
    {
      id: 'fish-audio',
      name: 'Fish Audio',
      displayName: 'Fish Audio',
      subtitle: 'Natural-sounding voice synthesis with custom voice cloning reference IDs.',
      defaultModel: 'speech-1.5',
      defaultVoice: '',
      voices: [],
      models: ['speech-1.5', 'speech-1.6'],
      supportsVoiceSelection: true,
      supportsModelSelection: true,
      supportsBaseUrl: true,
      defaultBaseUrl: 'https://api.fish.audio',
      apiKeyPlaceholder: 'Enter your Fish Audio API key',
      docsUrl: 'https://fish.audio/app/api-keys/',
    },
    {
      id: 'xai',
      name: 'xAI Grok Voice',
      displayName: 'xAI Grok Voice',
      subtitle: 'Expressive text-to-speech from xAI (eve, ara, rex, sal, leo).',
      defaultModel: 'grok-tts',
      defaultVoice: 'eve',
      voices: ['eve', 'ara', 'rex', 'sal', 'leo'],
      models: ['grok-tts'],
      supportsVoiceSelection: true,
      supportsModelSelection: false,
      supportsBaseUrl: false,
      defaultBaseUrl: 'https://api.x.ai',
      apiKeyPlaceholder: 'xai-...',
      docsUrl: 'https://console.x.ai/',
    },
    {
      id: 'custom-openai',
      name: 'Custom OpenAI-Compatible (9Router / LiteLLM)',
      displayName: 'Custom OpenAI-Compatible (9Router / LiteLLM)',
      subtitle: 'Any OpenAI-compatible `/v1/audio/speech` router such as 9Router, LiteLLM, LocalAI, or Kokoro.',
      defaultModel: 'tts-1',
      defaultVoice: 'alloy',
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      models: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
      supportsVoiceSelection: true,
      supportsModelSelection: true,
      supportsBaseUrl: true,
      requiresBaseUrl: true,
      defaultBaseUrl: 'http://localhost:20128/v1',
      apiKeyPlaceholder: 'sk-... or router key',
      docsUrl: 'https://platform.openai.com/docs/api-reference/audio/createSpeech',
    },
    {
      id: 'browser-native',
      name: 'Browser Web Speech (Free / Offline)',
      displayName: 'Browser Web Speech (Free / Offline)',
      subtitle: 'Built-in browser SpeechSynthesis. Needs no API key.',
      defaultModel: 'browser',
      defaultVoice: 'default',
      voices: ['default'],
      models: ['browser'],
      supportsVoiceSelection: false,
      supportsModelSelection: false,
      supportsBaseUrl: false,
      keyless: true,
      defaultBaseUrl: '',
      apiKeyPlaceholder: 'No API key required',
      docsUrl: '',
    },
  ];
}

export function sttCatalog() {
  return [
    {
      id: 'deepgram',
      name: 'Deepgram Nova',
      displayName: 'Deepgram Nova',
      subtitle: 'Fast, accurate Nova-3 speech-to-text transcription.',
      defaultModel: 'nova-2',
      models: ['nova-2', 'nova-3', 'whisper-large'],
      supportsModelSelection: true,
      supportsBaseUrl: false,
      defaultBaseUrl: 'https://api.deepgram.com',
      apiKeyPlaceholder: 'Enter your Deepgram API key',
      docsUrl: 'https://console.deepgram.com/',
    },
    {
      id: 'openai',
      name: 'OpenAI Whisper / GPT-4o Transcribe',
      displayName: 'OpenAI Whisper / GPT-4o Transcribe',
      subtitle: 'High-accuracy transcription via OpenAI `/v1/audio/transcriptions`.',
      defaultModel: 'whisper-1',
      models: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
      supportsModelSelection: true,
      supportsBaseUrl: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      apiKeyPlaceholder: 'sk-...',
      docsUrl: 'https://platform.openai.com/api-keys',
    },
    {
      id: 'groq',
      name: 'Groq Whisper',
      displayName: 'Groq Whisper',
      subtitle: 'Ultra-fast Whisper Large v3 Turbo transcription on Groq LPUs.',
      defaultModel: 'whisper-large-v3-turbo',
      models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
      supportsModelSelection: true,
      supportsBaseUrl: false,
      defaultBaseUrl: 'https://api.groq.com/openai/v1',
      apiKeyPlaceholder: 'gsk_...',
      docsUrl: 'https://console.groq.com/keys',
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs Scribe',
      displayName: 'ElevenLabs Scribe',
      subtitle: 'ElevenLabs Scribe v1 speech-to-text transcription.',
      defaultModel: 'scribe_v1',
      models: ['scribe_v1'],
      supportsModelSelection: true,
      supportsBaseUrl: true,
      defaultBaseUrl: 'https://api.elevenlabs.io',
      apiKeyPlaceholder: 'sk_...',
      docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    },
    {
      id: 'xai',
      name: 'xAI Audio Transcription',
      displayName: 'xAI Audio Transcription',
      subtitle: 'Speech-to-text transcription powered by xAI.',
      defaultModel: 'grok-stt',
      models: ['grok-stt', 'whisper-1'],
      supportsModelSelection: true,
      supportsBaseUrl: false,
      defaultBaseUrl: 'https://api.x.ai/v1',
      apiKeyPlaceholder: 'xai-...',
      docsUrl: 'https://console.x.ai/',
    },
    {
      id: 'custom-openai',
      name: 'Custom OpenAI-Compatible (9Router / LiteLLM / Whisper.cpp)',
      displayName: 'Custom OpenAI-Compatible (9Router / LiteLLM / Whisper.cpp)',
      subtitle: 'Any OpenAI-compatible `/v1/audio/transcriptions` endpoint such as 9Router, LiteLLM, or local Whisper.',
      defaultModel: 'whisper-1',
      models: ['whisper-1', 'gpt-4o-mini-transcribe', 'whisper-large-v3'],
      supportsModelSelection: true,
      supportsBaseUrl: true,
      requiresBaseUrl: true,
      defaultBaseUrl: 'http://localhost:20128/v1',
      apiKeyPlaceholder: 'sk-... or router key',
      docsUrl: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
    },
    {
      id: 'browser-native',
      name: 'Browser Web Speech Recognition',
      displayName: 'Browser Web Speech Recognition',
      subtitle: 'Built-in browser SpeechRecognition API. Needs no API key.',
      defaultModel: 'browser',
      models: ['browser'],
      supportsModelSelection: false,
      supportsBaseUrl: false,
      keyless: true,
      defaultBaseUrl: '',
      apiKeyPlaceholder: 'No API key required',
      docsUrl: '',
    },
  ];
}

const SHARED = new Set(['openai', 'deepgram', 'elevenlabs', 'xai', 'groq', 'fish-audio', 'custom-openai']);

function specFor(catalog, id) {
  return catalog.find((spec) => spec.id === id) || null;
}

// Normalize an OpenAI-style base URL to its `/audio/speech` endpoint.
export function normalizeSpeechUrl(base) {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.openai.com/v1/audio/speech';
  if (trimmed.endsWith('/audio/speech')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/audio/speech`;
  return `${trimmed}/v1/audio/speech`;
}

// Normalize an OpenAI-style base URL to its `/audio/transcriptions` endpoint.
export function normalizeTranscriptionUrl(base) {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.openai.com/v1/audio/transcriptions';
  if (trimmed.endsWith('/audio/transcriptions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/audio/transcriptions`;
  return `${trimmed}/v1/audio/transcriptions`;
}

export function defaultSettings() {
  return {
    readAloudEnabled: true,
    autoReadAloud: false,
    ttsProvider: 'browser-native',
    sttProvider: 'browser-native',
    sttLanguage: 'en',
    ttsProviders: {},
    sttProviders: {},
  };
}

export const ELEVENLABS_VOICE_NAMES = {
  EXAVITQu4vr4xnSDxMaL: 'Sarah',
  JBFqnCBsd6RMkjVDRZzb: 'George',
  '21m00Tcm4TlvDq8ikWAM': 'Rachel',
  AZnzlk1XvdvUeBnXmlld: 'Domi',
  ErXwobaYiN019PkySvjV: 'Antoni',
  TxGEqnHWrfWFTfGW9XjX: 'Josh',
};

export function elevenLabsVoiceName(id) {
  return ELEVENLABS_VOICE_NAMES[id] || id;
}

export function resolveDefaultTtsProvider(hints) {
  const candidates = ['elevenlabs', 'openai', 'deepgram', 'xai', 'fish-audio', 'custom-openai'];
  for (const c of candidates) {
    if (hints.has(`tts.${c}/api_key`) || hints.has(`${c}/api_key`)) return c;
  }
  return 'browser-native';
}

export function resolveDefaultSttProvider(hints) {
  const candidates = ['elevenlabs', 'deepgram', 'openai', 'groq', 'xai', 'custom-openai'];
  for (const c of candidates) {
    if (hints.has(`stt.${c}/api_key`) || hints.has(`${c}/api_key`)) return c;
  }
  return 'browser-native';
}

export function buildSettingsView(settings, hints) {
  const hintFor = (service, fallback) =>
    hints.get(`${service}/api_key`) ?? hints.get(`${fallback}/api_key`) ?? null;
  const hasKey = (service, fallback) =>
    hints.has(`${service}/api_key`) || hints.has(`${fallback}/api_key`);

  const tts = {};
  for (const spec of ttsCatalog()) {
    const saved = (settings.ttsProviders || {})[spec.id] || {};
    const baseUrl = (saved.baseUrl || spec.defaultBaseUrl || '').toString();
    tts[spec.id] = {
      model: saved.model || spec.defaultModel,
      voiceId: saved.voiceId !== undefined && saved.voiceId !== null ? saved.voiceId : spec.defaultVoice,
      baseUrl,
      speed: typeof saved.speed === 'number' ? saved.speed : 1.0,
      configured: Boolean(spec.keyless) ||
        (hasKey(`tts.${spec.id}`, spec.id) && (!spec.requiresBaseUrl || baseUrl.trim().length > 0)),
      apiKeyHint: spec.keyless ? null : hintFor(`tts.${spec.id}`, spec.id),
    };
  }

  const stt = {};
  for (const spec of sttCatalog()) {
    const saved = (settings.sttProviders || {})[spec.id] || {};
    const baseUrl = (saved.baseUrl || spec.defaultBaseUrl || '').toString();
    stt[spec.id] = {
      model: saved.model || spec.defaultModel,
      baseUrl,
      language: saved.language || settings.sttLanguage || 'en',
      configured: Boolean(spec.keyless) ||
        (hasKey(`stt.${spec.id}`, spec.id) && (!spec.requiresBaseUrl || baseUrl.trim().length > 0)),
      apiKeyHint: spec.keyless ? null : hintFor(`stt.${spec.id}`, spec.id),
    };
  }

  const elevenSavedTts = (settings.ttsProviders || {}).elevenlabs || {};
  const elevenSavedStt = (settings.sttProviders || {}).elevenlabs || {};
  const elevenTtsModel = elevenSavedTts.model || 'eleven_flash_v2_5';
  const elevenSttModel = elevenSavedStt.model || 'scribe_v1';
  const elevenVoiceId = elevenSavedTts.voiceId || 'EXAVITQu4vr4xnSDxMaL';
  const elevenVoiceName = elevenLabsVoiceName(elevenVoiceId);
  const elevenConfigured = hints.has('tts.elevenlabs/api_key') || hints.has('elevenlabs/api_key') || hints.has('stt.elevenlabs/api_key');
  const elevenHint = hints.get('tts.elevenlabs/api_key') || hints.get('elevenlabs/api_key') || hints.get('stt.elevenlabs/api_key') || null;

  const liveVoice = {
    provider: 'elevenlabs',
    displayName: 'ElevenLabs Conversational Voice',
    configured: elevenConfigured,
    apiKeyHint: elevenHint,
    ttsModel: elevenTtsModel,
    sttModel: elevenSttModel,
    voiceId: elevenVoiceId,
    voiceName: elevenVoiceName,
  };

  return { tts, stt, liveVoice };
}

function audioExtension(mimeType) {
  switch (mimeType) {
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/flac':
      return 'flac';
    default:
      return 'webm';
  }
}

export function register(app, ctx) {
  const creds = createCredentials({
    home: ctx.config?.home || ctx.store.home,
    store: ctx.store,
    log: ctx.log,
  });

  async function loadSettings(hints = null, rawStored = null) {
    const stored = rawStored ?? (await ctx.store.read(SETTINGS_KEY, {}));
    const settings = defaultSettings();
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored)) settings[key] = value;
    }
    if (!settings.ttsProviders || typeof settings.ttsProviders !== 'object') settings.ttsProviders = {};
    if (!settings.sttProviders || typeof settings.sttProviders !== 'object') settings.sttProviders = {};

    const hasStoredTts = stored && typeof stored.ttsProvider === 'string' && stored.ttsProvider.trim() !== '';
    const hasStoredStt = stored && typeof stored.sttProvider === 'string' && stored.sttProvider.trim() !== '';

    if (!hasStoredTts || !hasStoredStt) {
      const activeHints = hints ?? (await hintMap());
      if (!hasStoredTts) {
        settings.ttsProvider = resolveDefaultTtsProvider(activeHints);
      }
      if (!hasStoredStt) {
        settings.sttProvider = resolveDefaultSttProvider(activeHints);
      }
    }

    return settings;
  }

  async function hintMap() {
    const map = new Map();
    try {
      for (const item of await creds.listMetadata()) {
        map.set(`${item.service}/${item.field}`, item.hint);
      }
    } catch (err) {
      ctx.log?.('warn', 'voice credential hints failed', { error: String(err && err.message) });
    }
    return map;
  }

  async function settingsPayload() {
    const hints = await hintMap();
    const rawStored = await ctx.store.read(SETTINGS_KEY, {});
    const settings = await loadSettings(hints, rawStored);
    const { tts, stt, liveVoice } = buildSettingsView(settings, hints);
    return {
      ttsCatalog: ttsCatalog(),
      sttCatalog: sttCatalog(),
      settings: { ...settings, ttsProviders: tts, sttProviders: stt, liveVoice },
    };
  }

  async function resolveKey(kind, provider, requestKey) {
    if (typeof requestKey === 'string' && requestKey.trim()) return requestKey.trim();
    const namespaced = await creds.getPlaintext(`${kind}.${provider}`, 'api_key');
    if (namespaced) return namespaced;
    const shared = await creds.getPlaintext(provider, 'api_key');
    if (shared) return shared;
    return null;
  }

  function savedString(settings, slot, provider, field, fallback) {
    const entry = (settings[slot] || {})[provider];
    const value = entry && entry[field];
    return value !== undefined && value !== null && String(value).trim() !== '' ? String(value) : fallback;
  }

  // GET /api/voice/settings
  app.get('/api/voice/settings', async (req, res) => {
    ctx.requireUser(req);
    ctx.json(res, 200, await settingsPayload());
  });

  // PUT /api/voice/settings
  app.put('/api/voice/settings', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const settings = await loadSettings();
    const ops = [];

    if (typeof body.readAloudEnabled === 'boolean') settings.readAloudEnabled = body.readAloudEnabled;
    if (typeof body.autoReadAloud === 'boolean') settings.autoReadAloud = body.autoReadAloud;
    if (typeof body.sttLanguage === 'string') settings.sttLanguage = body.sttLanguage.trim();
    if (typeof body.ttsProvider === 'string' && body.ttsProvider.trim()) {
      if (!specFor(ttsCatalog(), body.ttsProvider.trim())) {
        ctx.error(res, 400, `unknown voice provider: ${body.ttsProvider}`);
        return;
      }
      settings.ttsProvider = body.ttsProvider.trim();
    }
    if (typeof body.sttProvider === 'string' && body.sttProvider.trim()) {
      if (!specFor(sttCatalog(), body.sttProvider.trim())) {
        ctx.error(res, 400, `unknown voice provider: ${body.sttProvider}`);
        return;
      }
      settings.sttProvider = body.sttProvider.trim();
    }

    const applyUpdate = (slot, kind, update, catalog) => {
      const provider = update && typeof update.provider === 'string' ? update.provider.trim() : '';
      const spec = specFor(catalog, provider);
      if (!spec) return `unknown voice provider: ${provider}`;
      const entry = { ...((settings[slot] || {})[provider] || {}) };
      if (kind === 'tts') {
        if (typeof update.model === 'string' && update.model.trim()) entry.model = update.model.trim();
        if (update.voiceId !== undefined) entry.voiceId = String(update.voiceId);
        if (typeof update.baseUrl === 'string') entry.baseUrl = update.baseUrl.trim().replace(/\/+$/, '');
        if (typeof update.speed === 'number' && Number.isFinite(update.speed)) {
          entry.speed = Math.min(4.0, Math.max(0.25, update.speed));
        }
      } else {
        if (typeof update.model === 'string' && update.model.trim()) entry.model = update.model.trim();
        if (typeof update.baseUrl === 'string') entry.baseUrl = update.baseUrl.trim().replace(/\/+$/, '');
        if (typeof update.language === 'string') entry.language = update.language.trim();
      }
      settings[slot][provider] = entry;

      const label = `${spec.name} API key`;
      if (update.clearApiKey) {
        ops.push({ delete: `${kind}.${provider}` });
        if (SHARED.has(provider)) ops.push({ delete: provider });
      } else if (typeof update.apiKey === 'string' && update.apiKey.trim()) {
        ops.push({ set: `${kind}.${provider}`, value: update.apiKey.trim(), label });
        if (SHARED.has(provider)) ops.push({ set: provider, value: update.apiKey.trim(), label });
      }
      return null;
    };

    if (body.ttsProviderUpdate && typeof body.ttsProviderUpdate === 'object') {
      const error = applyUpdate('ttsProviders', 'tts', body.ttsProviderUpdate, ttsCatalog());
      if (error) {
        ctx.error(res, 400, error);
        return;
      }
    }
    if (body.sttProviderUpdate && typeof body.sttProviderUpdate === 'object') {
      const error = applyUpdate('sttProviders', 'stt', body.sttProviderUpdate, sttCatalog());
      if (error) {
        ctx.error(res, 400, error);
        return;
      }
    }

    await ctx.store.write(SETTINGS_KEY, settings);
    for (const op of ops) {
      if (op.set) await creds.set(op.set, 'api_key', op.value, op.label);
      if (op.delete) await creds.delete(op.delete, 'api_key');
    }

    ctx.json(res, 200, await settingsPayload());
  });

  // POST /api/tts/voices
  app.post('/api/tts/voices', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const settings = await loadSettings();
    const provider = (typeof body.provider === 'string' && body.provider.trim()) || settings.ttsProvider;
    const spec = specFor(ttsCatalog(), provider);
    if (!spec) {
      ctx.error(res, 400, `unknown tts provider: ${provider}`);
      return;
    }

    const baseUrl = ((typeof body.baseUrl === 'string' && body.baseUrl.trim()) ||
      savedString(settings, 'ttsProviders', provider, 'baseUrl', spec.defaultBaseUrl)).replace(/\/+$/, '');
    const apiKey = await resolveKey('tts', provider, body.apiKey);
    const defaultVoices = (spec.voices || []).map((id) => ({
      id,
      name: provider === 'elevenlabs' ? elevenLabsVoiceName(id) : id,
    }));

    try {
      if (provider === 'elevenlabs' && apiKey) {
        const base = baseUrl || 'https://api.elevenlabs.io';
        const resp = await fetch(`${base}/v1/voices`, {
          headers: { 'xi-api-key': apiKey },
        });
        if (resp.ok) {
          const json = await resp.json();
          if (Array.isArray(json?.voices) && json.voices.length) {
            const voices = json.voices
              .filter((v) => v && typeof v.voice_id === 'string')
              .map((v) => ({
                id: v.voice_id,
                name: v.name || v.voice_id,
                previewUrl: v.preview_url || undefined,
                category: v.category || undefined,
              }));
            if (voices.length) {
              ctx.json(res, 200, { provider, voices });
              return;
            }
          }
        }
      } else if (provider === 'fish-audio' && apiKey) {
        const base = baseUrl || 'https://api.fish.audio';
        const resp = await fetch(`${base}/model?page_size=20&page_number=1`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (resp.ok) {
          const json = await resp.json();
          if (Array.isArray(json?.items) && json.items.length) {
            const voices = json.items
              .filter((v) => v && (v._id || v.id))
              .map((v) => ({
                id: String(v._id || v.id),
                name: String(v.title || v.name || v._id || v.id),
              }));
            if (voices.length) {
              ctx.json(res, 200, { provider, voices });
              return;
            }
          }
        }
      } else if ((provider === 'custom-openai' || provider === 'openai') && baseUrl) {
        const voicesUrl = baseUrl.endsWith('/v1')
          ? `${baseUrl}/audio/voices`
          : `${baseUrl}/v1/audio/voices`;
        const headers = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const resp = await fetch(voicesUrl, { headers });
        if (resp.ok) {
          const json = await resp.json();
          const arr = Array.isArray(json?.voices)
            ? json.voices
            : Array.isArray(json?.data)
              ? json.data
              : Array.isArray(json)
                ? json
                : null;
          if (arr && arr.length) {
            const voices = arr
              .map((v) => {
                if (typeof v === 'string') return { id: v, name: v };
                const id = v?.voice_id || v?.id || v?.name;
                return id ? { id: String(id), name: String(v?.name || id) } : null;
              })
              .filter(Boolean);
            if (voices.length) {
              ctx.json(res, 200, { provider, voices });
              return;
            }
          }
        }
      }
    } catch {
      // fall through to defaultVoices
    }

    ctx.json(res, 200, { provider, voices: defaultVoices });
  });

  // POST /api/tts/synthesize
  app.post('/api/tts/synthesize', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const input = typeof body.text === 'string' ? body.text.trim() : '';
    if (!input) {
      ctx.error(res, 400, 'text is required');
      return;
    }
    if (Array.from(input).length > MAX_TTS_CHARS) {
      ctx.error(res, 400, 'text is too long (max 8192 characters)');
      return;
    }

    const settings = await loadSettings();
    const provider = (typeof body.provider === 'string' && body.provider.trim()) || settings.ttsProvider;
    const spec = specFor(ttsCatalog(), provider);
    if (!spec) {
      ctx.error(res, 400, `unknown tts provider: ${provider}`);
      return;
    }
    if (spec.keyless) {
      ctx.error(res, 400, 'browser-native text-to-speech is synthesized in the browser, not the server');
      return;
    }

    const model = (typeof body.model === 'string' && body.model.trim()) ||
      savedString(settings, 'ttsProviders', provider, 'model', spec.defaultModel);
    const voice = (typeof body.voiceId === 'string' && body.voiceId !== '')
      ? body.voiceId
      : savedString(settings, 'ttsProviders', provider, 'voiceId', spec.defaultVoice);
    const baseUrl = ((typeof body.baseUrl === 'string' && body.baseUrl.trim()) ||
      savedString(settings, 'ttsProviders', provider, 'baseUrl', spec.defaultBaseUrl)).replace(/\/+$/, '');
    const savedSpeed = (settings.ttsProviders[provider] || {}).speed;
    const speed = typeof savedSpeed === 'number' ? savedSpeed : 1.0;

    const apiKey = await resolveKey('tts', provider, body.apiKey);
    if (!apiKey) {
      ctx.error(res, 400, `no API key configured for ${provider} text-to-speech`);
      return;
    }

    let upstream;
    if (provider === 'openai' || provider === 'custom-openai') {
      upstream = await doFetch(normalizeSpeechUrl(baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input, voice, speed, response_format: 'mp3' }),
      }, provider, apiKey, ctx, res);
    } else if (provider === 'elevenlabs') {
      const base = baseUrl || 'https://api.elevenlabs.io';
      upstream = await doFetch(`${base}/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, model_id: model }),
      }, provider, apiKey, ctx, res);
    } else if (provider === 'deepgram') {
      const modelId = voice || model;
      upstream = await doFetch(`https://api.deepgram.com/v1/speak?model=${modelId}`, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input }),
      }, provider, apiKey, ctx, res);
    } else if (provider === 'fish-audio') {
      const base = baseUrl || 'https://api.fish.audio';
      upstream = await doFetch(`${base}/v1/tts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, reference_id: voice, format: 'mp3' }),
      }, provider, apiKey, ctx, res);
    } else if (provider === 'xai') {
      upstream = await doFetch('https://api.x.ai/v1/tts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input,
          voice_id: voice,
          output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
        }),
      }, provider, apiKey, ctx, res);
    } else {
      ctx.error(res, 400, `unsupported tts provider: ${provider}`);
      return;
    }
    if (!upstream) return; // doFetch already sent an error response

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': buffer.length });
    res.end(buffer);
  });

  // POST /api/stt/transcribe
  app.post('/api/stt/transcribe', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const encoded = typeof body.audio === 'string' ? body.audio.trim() : '';
    if (!encoded) {
      ctx.error(res, 400, 'audio is required');
      return;
    }
    let audio;
    try {
      audio = Buffer.from(encoded, 'base64');
    } catch {
      ctx.error(res, 400, 'audio must be valid base64');
      return;
    }
    if (!audio.length) {
      ctx.error(res, 400, 'audio must be valid base64');
      return;
    }
    if (audio.length > MAX_AUDIO_BYTES) {
      ctx.error(res, 400, 'audio is too large (max 25 MB)');
      return;
    }

    const settings = await loadSettings();
    const provider = (typeof body.provider === 'string' && body.provider.trim()) || settings.sttProvider;
    const spec = specFor(sttCatalog(), provider);
    if (!spec) {
      ctx.error(res, 400, `unknown stt provider: ${provider}`);
      return;
    }
    if (spec.keyless) {
      ctx.error(res, 400, 'browser-native speech recognition runs in the browser, not the server');
      return;
    }

    const model = (typeof body.model === 'string' && body.model.trim()) ||
      savedString(settings, 'sttProviders', provider, 'model', spec.defaultModel);
    const baseUrl = ((typeof body.baseUrl === 'string' && body.baseUrl.trim()) ||
      savedString(settings, 'sttProviders', provider, 'baseUrl', spec.defaultBaseUrl)).replace(/\/+$/, '');
    const language = (typeof body.language === 'string' && body.language.trim()) ||
      savedString(settings, 'sttProviders', provider, 'language', settings.sttLanguage || '');
    const mimeType = (typeof body.mimeType === 'string' && body.mimeType.trim()) || 'audio/webm';

    const apiKey = await resolveKey('stt', provider, body.apiKey);
    if (!apiKey) {
      ctx.error(res, 400, `no API key configured for ${provider} speech-to-text`);
      return;
    }

    let text = '';
    try {
      if (provider === 'deepgram') {
        let url = `https://api.deepgram.com/v1/listen?model=${model}&smart_format=true`;
        if (language) url += `&language=${encodeURIComponent(language)}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mimeType },
          body: audio,
        });
        if (!response.ok) throw await upstreamError(provider, response, apiKey);
        const json = await response.json();
        text = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      } else if (provider === 'elevenlabs') {
        const form = new FormData();
        form.append('file', new Blob([audio], { type: mimeType }), `audio.${audioExtension(mimeType)}`);
        form.append('model_id', model);
        const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: form,
        });
        if (!response.ok) throw await upstreamError(provider, response, apiKey);
        const json = await response.json();
        text = json?.text || '';
      } else {
        const form = new FormData();
        form.append('file', new Blob([audio], { type: mimeType }), `audio.${audioExtension(mimeType)}`);
        form.append('model', model);
        if (language) form.append('language', language);
        const response = await fetch(normalizeTranscriptionUrl(baseUrl), {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (!response.ok) throw await upstreamError(provider, response, apiKey);
        const json = await response.json();
        text = json?.text || '';
      }
    } catch (err) {
      if (err && err.status) {
        ctx.error(res, err.status, err.message);
      } else {
        ctx.error(res, 502, `could not reach the ${provider} API`);
      }
      return;
    }

    ctx.json(res, 200, { status: 'ok', text, providerId: provider });
  });
}

// Fetch with an upstream-error guard. Returns the Response on success, or
// writes the error response and returns null.
async function doFetch(url, init, provider, apiKey, ctx, res) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    ctx.error(res, 502, `could not reach the ${provider} API`);
    return null;
  }
  if (!response.ok) {
    const err = await upstreamError(provider, response, apiKey);
    ctx.error(res, err.status, err.message);
    return null;
  }
  return response;
}

async function upstreamError(provider, response, apiKey) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  let message = body.slice(0, 400);
  if (apiKey) message = message.split(apiKey).join('[REDACTED]');
  const err = new Error(`${provider} request failed (${response.status}): ${message}`);
  err.status = 502;
  return err;
}

// Test surface: keep the pure helpers reachable without registering routes.
export const _normalizeSpeechUrlForTest = normalizeSpeechUrl;
export const _normalizeTranscriptionUrlForTest = normalizeTranscriptionUrl;
