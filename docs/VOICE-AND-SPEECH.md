# Voice & Speech

Vellum-inspired Voice & Speech subsystem for Amiro: text-to-speech narration,
microphone dictation, and hands-free live voice mode. Live voice is documented
in [LIVE-VOICE.md](LIVE-VOICE.md). This document describes the shipped
architecture of the provider-based speech features, the seven TTS providers
and seven STT providers, the HTTP surface, and how to test it.

## Overview & Architecture

The subsystem spans four user-visible surfaces, all driven by one settings file
and one encrypted credential store:

| Surface | Entry point | What it does |
| --- | --- | --- |
| Admin Settings | `/admin/voice` (`src/app/(chat)/(admin)/admin/voice/page.tsx`) | Pick providers, models, voices, base URLs; store API keys; fetch live voice catalogs; preview voices; toggle Read Aloud. |
| Composer Dictation | `src/components/prompt-input.tsx` | Mic button dictation using the configured STT provider (browser `SpeechRecognition` or server transcription). |
| Per-Message & Auto Read Aloud | `src/components/message-parts.tsx`, `src/components/chat-bot.tsx` | A speaker action on each assistant message, plus an optional "speak the reply when the turn finishes" mode. Auto read-aloud is skipped while a live voice session is active. |
| Live Voice Mode | `src/components/voice-room/*`, `src/lib/voice/*` | A live, hands-free voice conversation (ElevenLabs only), rendered inline above the composer. See [LIVE-VOICE.md](LIVE-VOICE.md). |

```
┌──────────────────────────────────────────────────────────────────────┐
│ Chat thread (sidebar, header and text input stay interactive)        │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐   │
│ │ VoiceRoom  (src/components/voice-room/voice-room.tsx)          │   │
│ │   ├─ VoiceMascot  (plush; reacts to mic and speaker level)     │   │
│ │   └─ mute, stop, minimize and end controls                     │   │
│ └────────────────────────────────────────────────────────────────┘   │
│ [ VoiceDock above the composer when minimized ]                      │
│ [ prompt-input.tsx composer ]                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Data flow:

- **Settings** live in `$AMIRO_HOME/store/voice-settings.json` (never secrets).
- **API keys** live only in the encrypted Credential Vault
  (`docs/CREDENTIAL-VAULT.md`), under the namespaced `tts.<provider>/api_key`
  and `stt.<provider>/api_key` slots, and are additionally mirrored into the
  shared `<provider>/api_key` slot for shared providers (so an existing
  `openai/api_key` powers voice automatically). The `voice-tts-<provider>` /
  `voice-stt-<provider>` naming from the original brief maps to these
  `tts.<provider>` / `stt.<provider>` slots.
- **Runtime state** lives in two Zustand stores:
  - `src/lib/ai/speech/read-aloud-store.ts` — the single-message read-aloud
    player (`useMessageReadAloudStore`).
  - `src/lib/voice/voice-store.ts` — the live voice session, phase machine,
    captions and mute state (`useVoiceStore`). Mic capture and playback live in
    `src/lib/voice/pcm-capture.ts` and `src/lib/voice/tts-playback.ts`. See
    [LIVE-VOICE.md](LIVE-VOICE.md).

> Note on endpoint naming: the shipped routes are `GET/PUT /api/voice/settings`,
> `POST /api/tts/voices`, `POST /api/tts/synthesize`, and
> `POST /api/stt/transcribe` (see `routes()` in `backend/src/routes/voice.rs` and
> the Node mirror `adapter/src/routes/voice.mjs`). Older shorthand references to
> `/api/voice/voices`, `/api/voice/tts`, and `/api/voice/stt` map to those
> three POST routes. Live voice has its own routes under `/api/live-voice/*` (a
ticket, a preflight and a WebSocket), documented in [LIVE-VOICE.md](LIVE-VOICE.md).

## Supported TTS & STT Providers

Both catalogs contain **7 providers**. The provider catalogs are defined once in
Rust (`tts_catalog()` / `stt_catalog()` in `backend/src/routes/voice.rs`), once in
the Node adapter (`adapter/src/routes/voice.mjs`) with an identical payload, and
once as a static TypeScript fallback for offline rendering
(`src/lib/backend/voice-api.ts`). The backend catalog is authoritative; the
frontend fallback only fills in when the backend is unreachable.

### Text-to-Speech (7)

| id | Display name | Default model | Default voice | Base URL | Notes |
| --- | --- | --- | --- | --- | --- |
| `openai` | OpenAI Speech | `tts-1` | `alloy` | `https://api.openai.com/v1` | Models `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`. 11 voices. |
| `elevenlabs` | ElevenLabs | `eleven_turbo_v2_5` | `EXAVITQu4vr4xnSDxMaL` | `https://api.elevenlabs.io` | `eleven_multilingual_v2`, `eleven_flash_v2_5`. Live voice catalog. Live voice always uses ElevenLabs. |
| `deepgram` | Deepgram Aura | `aura-2-thalia-en` | `aura-2-thalia-en` | `https://api.deepgram.com` | Shares its key with Deepgram STT. |
| `fish-audio` | Fish Audio | `speech-1.5` | *(none; reference ID)* | `https://api.fish.audio` | Voice cloning reference IDs; live model list. |
| `xai` | xAI Grok Voice | `grok-tts` | `eve` | `https://api.x.ai` | Voices `eve`, `ara`, `rex`, `sal`, `leo`. |
| `custom-openai` | Custom OpenAI-Compatible (9Router / LiteLLM) | `tts-1` | `alloy` | `http://localhost:20128/v1` | `requiresBaseUrl`. Any `/v1/audio/speech` router. |
| `browser-native` | Browser Web Speech (Free / Offline) | `browser` | `default` | *(none)* | `keyless`; synthesized client-side via `window.speechSynthesis` (voice availability and offline support are browser/OS-dependent). |

The Rust catalog names the OpenAI voice list as `alloy, ash, ballad, coral,
echo, fable, onyx, nova, sage, shimmer, verse`; the static TS fallback lists the
classic six (`alloy, echo, fable, onyx, nova, shimmer`). Fish Audio's catalog
ships an empty `voices` array because its voices are reference IDs fetched from
the provider.

### Speech-to-Text (7)

| id | Display name | Default model | Models | Base URL | Notes |
| --- | --- | --- | --- | --- | --- |
| `deepgram` | Deepgram Nova | `nova-2` | `nova-2`, `nova-3`, `whisper-large` | `https://api.deepgram.com` | `smart_format=true`; optional language. |
| `openai` | OpenAI Whisper / GPT-4o Transcribe | `whisper-1` | `whisper-1`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` | `https://api.openai.com/v1` | `/v1/audio/transcriptions`. |
| `groq` | Groq Whisper | `whisper-large-v3-turbo` | `whisper-large-v3-turbo`, `whisper-large-v3`, `distil-whisper-large-v3-en` | `https://api.groq.com/openai/v1` | LPU-hosted Whisper. |
| `elevenlabs` | ElevenLabs Scribe | `scribe_v1` | `scribe_v1` | `https://api.elevenlabs.io` | `/v1/speech-to-text`. |
| `xai` | xAI Audio Transcription | `grok-stt` | `grok-stt`, `whisper-1` | `https://api.x.ai/v1` | |
| `custom-openai` | Custom OpenAI-Compatible (9Router / LiteLLM / Whisper.cpp) | `whisper-1` | `whisper-1`, `gpt-4o-mini-transcribe`, `whisper-large-v3` | `http://localhost:20128/v1` | `requiresBaseUrl`. |
| `browser-native` | Browser Web Speech Recognition | `browser` | `browser` | *(none)* | `keyless`; runs in the browser via `SpeechRecognition` / `webkitSpeechRecognition` (many browsers route recognition through vendor cloud services, so offline recognition is browser/platform-dependent). |

### Browser Native (`window.speechSynthesis` / `SpeechRecognition`)

Keyless (no server API key required; offline capability depends on the browser and OS). The server explicitly rejects `browser-native` for
`/api/tts/synthesize` and `/api/stt/transcribe` (400 + explanatory message),
because synthesis and recognition happen in the browser:

- **TTS**: `src/lib/ai/speech/read-aloud-store.ts` calls
  `window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))`, honouring
  the configured speed as `utterance.rate`.
- **STT**: dictation in `src/components/prompt-input.tsx` uses the browser's
  `SpeechRecognition` / `webkitSpeechRecognition` (continuous, final results
  only) when the provider is `browser-native`. It falls back to `MediaRecorder`
  and server transcription when the provider is anything else, or when
  recognition is unavailable or fails to start. Live voice does not use
  browser-native STT.

### OpenAI

- **TTS** posts to `{base}/v1/audio/speech` with
  `{model, input, voice, speed, response_format: "mp3"}` and
  `Authorization: Bearer <key>`.
- **STT** posts multipart form-data to `{base}/v1/audio/transcriptions` with a
  `file` part (extension derived from MIME type), `model`, and optional
  `language`.

### Custom OpenAI-Compatible / 9Router

This is the escape hatch for self-hosted or multi-provider reverse proxies
(9Router, LiteLLM, LocalAI, vLLM, Kokoro, local Whisper, etc.). It is the only
provider whose `baseUrl` is **required**.

**Base URL normalization.** `normalize_speech_url` /
`normalize_transcription_url` (Rust) and `normalizeSpeechUrl` /
`normalizeTranscriptionUrl` (Node) accept any of these and resolve to the exact
upstream endpoint:

| You enter | Speech resolves to | Transcription resolves to |
| --- | --- | --- |
| `http://localhost:20128` | `http://localhost:20128/v1/audio/speech` | `http://localhost:20128/v1/audio/transcriptions` |
| `http://localhost:20128/v1` | `http://localhost:20128/v1/audio/speech` | `http://localhost:20128/v1/audio/transcriptions` |
| `http://localhost:20128/v1/` (trailing slash) | `http://localhost:20128/v1/audio/speech` | `http://localhost:20128/v1/audio/transcriptions` |
| `https://router.example.com/v1/audio/speech` | unchanged (already full) | n/a |
| *(empty)* | `https://api.openai.com/v1/audio/speech` | `https://api.openai.com/v1/audio/transcriptions` |

Normalization rules: trim whitespace, strip trailing `/`; if the result ends
with `/audio/speech` (or `/audio/transcriptions`) use it verbatim; if it ends
with `/v1` append `/audio/speech` (or `/audio/transcriptions`); otherwise append
`/v1/audio/speech` (or `/v1/audio/transcriptions`). `openai` uses the same
normalizer, so an OpenAI base of `https://api.openai.com/v1` resolves the same
way.

**Custom model ID and custom voice ID.** The Admin UI exposes free-text `Model`
and `Voice / Reference ID` inputs for providers with
`supportsModelSelection` / `supportsVoiceSelection`, so any router model or
voice string can be entered directly.

**Live voice catalog discovery.** `POST /api/tts/voices {provider, baseUrl?,
apiKey?}` probes the provider and returns `{provider, voices: [{id, name,
previewUrl?, category?}]}`:

- **ElevenLabs** → `GET {base}/v1/voices` with `xi-api-key`; maps
  `voice_id`/`name`/`preview_url`/`category`.
- **Fish Audio** → `GET {base}/model?page_size=20&page_number=1` with
  `Authorization: Bearer`; maps `_id`/`title`.
- **Custom OpenAI / OpenAI** → `GET {base}/audio/voices` when the base already
  ends in `/v1`, else `GET {base}/v1/audio/voices` with `Authorization: Bearer`;
  accepts `{voices:[...]}`, `{data:[...]}`, or a bare array, with entries either
  strings or objects using `voice_id`/`id`/`name`.
- Any failure falls back to the provider's static catalog `voices` instead of
  erroring.

**Per-voice preview before saving.** In `/admin/voice`, each voice chip has an
inline play control (`tts-voice-preview-<id>`) and the entered voice has a
`Preview ID` button. Both call `useMessageReadAloudStore.playMessage` with the
test sentence `Hello! This is voice <id> on Amiro.` using the currently selected
provider/model/base URL. The `Test Voice` button uses the configured voice with
"Hello! I am your Amiro assistant." (`tts-test-button`).

**Encrypted API key storage.** Keys are never written to
`voice-settings.json`. On save, `collect_cred_ops` writes the key to the
namespaced slot `tts.<provider>/api_key` / `stt.<provider>/api_key`, and for
shared providers (`openai`, `deepgram`, `elevenlabs`, `xai`, `groq`,
`fish-audio`, `custom-openai`) also to the bare `<provider>/api_key` slot so it
is reused by the rest of the app. Clearing deletes both. The `GET` payload never
contains a key, only a masked `apiKeyHint` like `••••1234` and a `configured`
boolean. Key resolution order at synthesis/transcription time is: request key →
namespaced slot → shared bare slot.

## Live Voice Mode

Live voice replaced the earlier inline Expressive Voice Mode stage. The stage
files (`src/components/chat-bot-voice.tsx`, `src/components/voice/*`,
`src/lib/ai/speech/live-voice-store.ts`, `src/lib/ai/speech/live-voice-motion.ts`)
have been deleted. The current design is documented in
[LIVE-VOICE.md](LIVE-VOICE.md). In brief:

- **Hands-free, server-driven turns.** One WebSocket carries 16 kHz microphone
  audio up. The server runs voice activity detection, ElevenLabs Scribe for
  speech-to-text, and ElevenLabs streaming TTS for speech out. The agent's turn
  runs through the normal chat stream, so it appears in the thread with its
  tool calls and approvals.
- **Barge-in.** Speaking over a reply cancels the turn and stops playback.
- **Inline, not a takeover.** The room mounts above the composer
  (`src/components/voice-room/voice-room.tsx`). The sidebar, header and text
  input stay usable. Minimizing it leaves a dock above the composer.
- **ElevenLabs only.** Live voice always uses ElevenLabs, with one key for
  speech in and out. It does not use the STT or TTS provider chosen on this
  page.
- **Controls.** Cmd/Ctrl+Shift+I toggles the session. Space, M and Esc act
  within the room. The full list is in [LIVE-VOICE.md](LIVE-VOICE.md).

## API Endpoints

All routes require an authenticated user and read/write the encrypted credential
store for keys.

| Method & path | Handler | Behavior |
| --- | --- | --- |
| `GET /api/voice/settings` | `get_settings` | Returns `{ttsCatalog, sttCatalog, settings}`. Settings include per-provider `model`, `voiceId`/`language`, `baseUrl`, `speed`, `configured`, and a masked `apiKeyHint`. |
| `PUT /api/voice/settings` | `put_settings` | Updates `readAloudEnabled`, `autoReadAloud`, `ttsProvider`, `sttProvider`, `sttLanguage`, and per-provider `ttsProviderUpdate`/`sttProviderUpdate` (incl. `apiKey` / `clearApiKey`). Validates provider ids (400 on unknown). Returns the updated `GET` payload. |
| `POST /api/tts/voices` | `list_voices` | Live voice catalog; falls back to the static catalog. Accepts `{provider, baseUrl?, apiKey?}`. |
| `POST /api/tts/synthesize` | `synthesize` | Proxies text (max 8192 chars) to the provider and returns raw audio bytes with the upstream `Content-Type`. 400 on missing text/key or `browser-native`. |
| `POST /api/stt/transcribe` | `transcribe` | Decodes base64 audio (max 25 MB), proxies it, returns `{status:"ok", text, providerId}`. 400 on bad base64, missing key, or `browser-native`. |

Limits and timeouts: TTS 60 s, STT 120 s, `MAX_TTS_CHARS = 8192`,
`MAX_AUDIO_BYTES = 25 MB`. Upstream errors surface as `502` and any API key
echoed back in the upstream body is replaced with `[REDACTED]`.

Adapters: the Node mirror in `adapter/src/routes/voice.mjs` registers the same
four paths (five HTTP methods) against the same on-disk store.

## Tests

```bash
# Rust backend: provider catalogs, normalization, settings round-trip,
# credential masking, and the HTTP surface.
cargo test --manifest-path backend/Cargo.toml --test voice

# Rust live voice: VAD, segmenter, sanitizer, tickets, client frames.
# The ElevenLabs smoke test is #[ignore]d; run it with ELEVENLABS_API_KEY set.
cargo test --manifest-path backend/Cargo.toml live_voice

# Node adapter mirror.
node --test adapter/test/voice.test.mjs

# Frontend units: settings API, read-aloud store, and live voice.
npx vitest run \
  src/lib/backend/voice-api.test.ts \
  src/lib/ai/speech/read-aloud-store.test.ts \
  src/lib/voice
```

Coverage highlights: `backend/tests/voice.rs` asserts all four paths (five HTTP methods) are
auth-gated and round-trips a settings update with credential masking;
`adapter/test/voice.test.mjs` drives the real handlers through a fake app/ctx
and asserts URL normalization for 9Router/custom bases and streaming audio;
`src/lib/voice/voice-store.test.ts` and `src/lib/voice/use-voice-chat-bridge.test.ts`
cover the live voice phase machine, barge-in and the chat bridge.

## Current Limitations & Scope

- **Live voice is a separate path**: hands-free live voice ([LIVE-VOICE.md](LIVE-VOICE.md))
  uses server-side VAD over one WebSocket and ElevenLabs only. Dictation and
  read-aloud remain turn-based (record, transcribe, then send; or synthesize per
  message) and work with whichever providers are configured. Dictation and
  read-aloud are not full-duplex audio channels, and the live path does not use
  any provider's native realtime API.
- **Browser/OS speech & hardware capabilities**: `browser-native` TTS/STT relies on `window.speechSynthesis` and `SpeechRecognition`/`webkitSpeechRecognition`, whose offline availability, voice list, and error callbacks vary by browser and OS. Automated E2E verification runs in headless Chromium against mocked/local endpoints rather than physical microphone hardware or paid third-party cloud keys. Live voice was checked with a fake microphone and a real ElevenLabs key (see [LIVE-VOICE.md](LIVE-VOICE.md)).
- **Single-utterance TTS cap**: `/api/tts/synthesize` caps individual synthesis requests at `8,192` characters (`MAX_TTS_CHARS`) and `/api/stt/transcribe` caps audio uploads at `25 MB` (`MAX_AUDIO_BYTES`).
