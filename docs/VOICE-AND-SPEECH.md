# Voice & Speech

Vellum-inspired Voice & Speech subsystem for Amiro: text-to-speech narration,
microphone dictation, and an expressive inline Voice Mode stage. This document
describes the shipped architecture, the seven TTS providers and seven STT
providers, the non-blocking inline UI, the HTTP surface, and how to test it.

## Overview & Architecture

The subsystem spans four user-visible surfaces, all driven by one settings file
and one encrypted credential store:

| Surface | Entry point | What it does |
| --- | --- | --- |
| Admin Settings | `/admin/voice` (`src/app/(chat)/(admin)/admin/voice/page.tsx`) | Pick providers, models, voices, base URLs; store API keys; fetch live voice catalogs; preview voices; toggle Read Aloud. |
| Composer Dictation | `src/components/prompt-input.tsx` | Mic button dictation using the configured STT provider (browser `SpeechRecognition` or server transcription). |
| Per-Message & Auto Read Aloud | `src/components/message-parts.tsx`, `src/components/chat-bot.tsx` | A speaker action on each assistant message, plus an optional "speak the reply when the turn finishes" mode. |
| Inline Expressive Voice Mode Stage | `src/components/chat-bot-voice.tsx`, `src/components/voice/*` | A live, hands-free voice conversation stage rendered inline above the composer. |

```
┌──────────────────────────────────────────────────────────────────────┐
│ AppHeader  ── VoiceSessionPill (status/controls while minimized)      │
│                                                                      │
│ Chat thread (sidebar + header + text input stay interactive)         │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ LiveVoiceStage  (src/components/chat-bot-voice.tsx)              │ │
│ │   ├─ VoiceRoomEyes        (expressive eyes + Aura Dots body)     │ │
│ │   ├─ VoiceMeshWaves / VoiceReactiveWaves (audio-reactive ribbon) │ │
│ │   └─ ExpressionSelectorPill + mic/output/end controls            │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ [ prompt-input.tsx composer ]  ← VoiceComposerBar when minimized     │
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
  - `src/lib/ai/speech/live-voice-store.ts` — the live session, phase machine,
    amplitude channel, and mic capture controller (`useLiveVoiceStore`,
    `useLiveVoiceController`).
- **Motion primitives** live in `src/lib/ai/speech/live-voice-motion.ts` and are
  deliberately React-free so the visuals and unit tests share one source of
  truth.

> Note on endpoint naming: the shipped routes are `GET/PUT /api/voice/settings`,
> `POST /api/tts/voices`, `POST /api/tts/synthesize`, and
> `POST /api/stt/transcribe` (see `routes()` in `backend/src/routes/voice.rs` and
> the Node mirror `adapter/src/routes/voice.mjs`). Older shorthand references to
> `/api/voice/voices`, `/api/voice/tts`, and `/api/voice/stt` map to those
> three POST routes.

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
| `elevenlabs` | ElevenLabs | `eleven_turbo_v2_5` | `21m00Tcm4TlvDq8ikWAM` | `https://api.elevenlabs.io` | `eleven_multilingual_v2`, `eleven_flash_v2_5`. Live voice catalog. |
| `deepgram` | Deepgram Aura | `aura-2-thalia-en` | `aura-2-thalia-en` | `https://api.deepgram.com` | Shares its key with Deepgram STT. |
| `fish-audio` | Fish Audio | `speech-1.5` | *(none; reference ID)* | `https://api.fish.audio` | Voice cloning reference IDs; live model list. |
| `xai` | xAI Grok Voice | `grok-tts` | `eve` | `https://api.x.ai` | Voices `eve`, `ara`, `rex`, `sal`, `leo`. |
| `custom-openai` | Custom OpenAI-Compatible (9Router / LiteLLM) | `tts-1` | `alloy` | `http://localhost:20128/v1` | `requiresBaseUrl`. Any `/v1/audio/speech` router. |
| `browser-native` | Browser Web Speech (Free / Offline) | `browser` | `default` | *(none)* | `keyless`; synthesized client-side, never on the server. |

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
| `browser-native` | Browser Web Speech Recognition | `browser` | `browser` | *(none)* | `keyless`; runs in the browser. |

### Browser Native (`window.speechSynthesis` / `SpeechRecognition`)

Keyless and offline. The server explicitly rejects `browser-native` for
`/api/tts/synthesize` and `/api/stt/transcribe` (400 + explanatory message),
because synthesis and recognition happen in the browser:

- **TTS**: `src/lib/ai/speech/read-aloud-store.ts` calls
  `window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))`, honouring
  the configured speed as `utterance.rate`.
- **STT**: `src/lib/ai/speech/live-voice-store.ts` prefers the browser's
  `SpeechRecognition` / `webkitSpeechRecognition` for continuous interim
  results, and only falls back to `MediaRecorder` + server transcription when
  the provider is not `browser-native`.

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

## Inline Expressive Voice Mode UI (No Full-Page Blocking Drawer)

Voice Mode is **inline**. `ChatBotVoice` renders `null`; the stage and bar mount
inside `src/components/prompt-input.tsx` directly above the composer
(`src/components/chat-bot-voice.tsx` comment: "NO FULL-PAGE BLOCKING DRAWER").
The sidebar, app header, chat thread, and text input remain fully interactive
while voice is active.

Session lifecycle:

- `ChatBotVoice` calls `useLiveVoiceController()` and bidirectionally syncs
  `appStore.voiceChat.isOpen` ↔ `useLiveVoiceStore.active`.
- Keyboard: the configured `Shortcuts.toggleVoiceChat` toggles the session;
  `Escape` minimizes an expanded stage (does not end it).
- `prompt-input.tsx` listens for `amiro:voice-utterance`
  (`LIVE_VOICE_UTTERANCE_EVENT`) and forwards to `sendMessage`; when a reply
  finishes it mirrors the assistant text into the stage and auto-speaks it
  (unless output is muted).

### `LiveVoiceStage` (`src/components/chat-bot-voice.tsx`)

Renders directly above the composer when `active && !minimized`. Structure:

- **Background**: a bottom wave band (mesh or reactive spline, toggled by the
  wave button) whose ink is `BAND_VOICE.listening` (white) while listening and
  `BAND_VOICE.responding` (black) while replying.
- **Top bar**: agent name + `liveVoicePhaseLabel`, the `ExpressionSelectorPill`
  (hidden on small screens, shown in a second row instead), the wave-engine
  toggle, captions toggle, minimize (chevron, `Esc`), and end (X).
- **User speech pill** (`voice-ambient-user`): the interim/final transcript.
- **Center**: `VoiceRoomEyes`.
- **Lower zone**: word-by-word assistant captions with a highlighted current
  word (~310 ms/word pacing), otherwise the phase caption.
- **Bottom controls**: mic mute, speaker mute, and the hint
  "Press Space to finalize turn • Esc to minimize".

Amplitudes come from the store's imperative channel
(`getLiveVoiceInputAmplitude` / `getLiveVoiceOutputAmplitude`) which are read
inside each visual's own `requestAnimationFrame` loop, so audio frames never
trigger React re-renders.

### `VoiceRoomEyes` (`src/components/voice/voice-expressive-eyes.tsx`)

The expressive character, built from the agent's Aura Dots identity:

- **Identity**: `useAgentIdentity()` supplies `traits`, `accentHex`, `name`, and
  `customImageUrl`; `toneForBg` derives foreground/wash tone. The body silhouette
  is drawn from `bodyShape.svgPath` plus a `bodyLattice` dot field and
  `bodyAccentDots`, giving each agent its own colour palette. When
  `customImageUrl` is set, the character renders as a circular avatar instead.
- **Phase-driven scaling** (`EYE_STATE_SCALE`): `idle` 0.9, `listening` 1.0,
  `thinking` 0.68, `responding` 0.85, `reconnecting` 0.9.
- **Thinking**: `VoiceThinkingIndicator` renders three pulsing dots
  (`thinking` visual).
- **Blinking**: an initial natural **double-blink** on entry, then random idle
  blinks every 2500–6000 ms (`2500 + Math.random()*3500`), 140 ms per blink.
- **Cursor parallax**: a `mousemove` listener translates the eyes by up to
  ±6 px X / ±4 px Y.
- **Poke to react**: clicking the character triggers a blink plus a wobble
  (`scaleX/scaleY/rotate` spring) and calls `onPoke`.
- **60 fps audio-reactive transforms**: `useReactiveEyes` runs the
  `createAmplitudeSmoother` ballistics (listening: 70 ms attack / 300 ms
  release; responding: 110 ms attack / 380 ms release) and writes `--eye-amp`
  plus a per-phase `transform` every frame.
- **Live expression pills** (`EXPRESSION_PRESETS`): `Auto`, `Attentive`,
  `Happy`, `Curious`, `Focused`, `Wink`, `Sparkle`, `Zen`. `Auto` (the default,
  `eyeStyleOverride === null`) lets the mood follow the phase/amplitude via
  `toVoiceExpressionMood` (e.g. listening+quiet → `attentive`, thinking →
  `focused`, responding+quiet → `speaking`); picking a preset pins the eye marks
  (`buildExpressionMarks`) regardless of state.

All motion respects `prefers-reduced-motion`.

### `VoiceMeshWaves` & `VoiceReactiveWaves` (`src/components/voice/voice-waves.tsx`)

Two interchangeable ribbon engines sharing the same `getAmplitude()` contract
and `BAND_VOICE` inks:

- **`VoiceMeshWaves`** — a woven oscilloscope filament ribbon drawn on **Canvas
  2D**: 84 lines × 96 samples by default, each line displaced by a two-component
  sine field (`meshDisplacement`) with time drift, wander, and a swirling warp
  driven by the rolling amplitude history. The inline variant
  (`MESH_INLINE_TUNING`) drops to 24 lines with wider spread for the compact bar
  and pill.
- **`VoiceReactiveWaves`** — a 3-layer **Catmull-Rom spline** wave (SVG paths).
  Layers are `back` (62 ms period, gain 0.42), `mid` (40 ms, 0.54), and `front`
  (24 ms, 0.36), each with its own sway. The `inline` placement multiplies gain
  ×1.6 and sway ×1.5.

Both use `createAmplitudeSmoother` (80 ms attack / 350 ms release) and a
time-paced ring buffer (`createAmplitudeHistory`) so scroll speed stays honest
to wall-clock time even across dropped frames, and both are dismissed under
reduced motion.

### `VoiceComposerBar` & `VoiceSessionPill` (`src/components/voice/voice-composer-bar.tsx`)

Minimizing (`Esc` or the chevron) flips `useLiveVoiceStore.minimized`:

- **`VoiceComposerBar`** replaces the stage with a 40–44 px (`h-10 sm:h-11`)
  rounded bar above the composer, carrying the same mesh ribbon, mic mute,
  output mute, end, and an expand tap target that calls `restoreRoom`. Current
  phase is announced via an `aria-live` region.
- **`VoiceSessionPill`** is rendered in `src/components/layouts/app-header.tsx`
  while a session is active (any state, expanded or minimized). It is a compact
  `h-8 w-48 sm:w-56` status pill with mic/output mute and end, and its center
  button restores the full stage. It returns `null` when inactive.

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
four routes against the same on-disk store.

## Tests

```bash
# Rust backend: provider catalogs, normalization, settings round-trip,
# credential masking, and the HTTP surface.
cargo test --manifest-path backend/Cargo.toml --test voice

# Node adapter mirror.
node --test adapter/test/voice.test.mjs

# Frontend units: settings API, read-aloud store, live-voice store, and UI.
npx vitest run \
  src/lib/backend/voice-api.test.ts \
  src/lib/ai/speech/read-aloud-store.test.ts \
  src/lib/ai/speech/live-voice-store.test.ts \
  src/components/voice/voice-ui.test.tsx
```

Coverage highlights: `backend/tests/voice.rs` asserts all four routes are
auth-gated and round-trips a settings update with credential masking;
`adapter/test/voice.test.mjs` drives the real handlers through a fake app/ctx
and asserts URL normalization for 9Router/custom bases and streaming audio;
`voice-ui.test.tsx` covers `VoiceComposerBar`/`VoiceSessionPill` rendering.

## Current Limitations & Scope

- **Turn-based STT/VAD -> Chat -> TTS pipeline**: Voice Mode runs a hands-free turn loop (browser `SpeechRecognition` or `MediaRecorder` + silence VAD + `/api/stt/transcribe` -> chat turn -> `/api/tts/synthesize` or `speechSynthesis`) so that all 7 TTS/STT providers and custom OpenAI/9Router endpoints work uniformly, rather than a provider-locked WebRTC full-duplex audio socket.
- **Simulated output amplitude envelope**: Because browser `<audio>` elements and `window.speechSynthesis` do not expose cross-origin PCM frames to an `AnalyserNode` across all providers, the assistant's `"responding"` wave/eye amplitude uses a synchronized multi-sine speech envelope while audio is playing, whereas microphone input uses a live Web Audio `AnalyserNode` RMS loop (falling back to a gentle breathing envelope if mic access is unavailable).
- **Single-utterance TTS cap**: `/api/tts/synthesize` caps individual synthesis requests at `8,192` characters (`MAX_TTS_CHARS`) and `/api/stt/transcribe` caps audio uploads at `25 MB` (`MAX_AUDIO_BYTES`).
