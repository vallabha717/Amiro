# Live Voice Mode

Live voice is Amiro's hands-free voice conversation. You talk, the server finds
the end of your sentence, the agent answers through the normal chat stream, and
the answer is spoken back as it is written. It follows the architecture of
Vellum's live-voice protocol: one WebSocket, binary PCM up, JSON frames down,
and a monotonic `seq` on every server frame.

This guide describes the code as of 2026-10-18. The work is uncommitted at the
time of writing (see [session-2026-10-18.md](session-2026-10-18.md)). It
replaces the earlier inline stage described in
[VOICE-AND-SPEECH.md](VOICE-AND-SPEECH.md).

Scope: **any keyed speech provider.** Live voice listens with the
speech-to-text provider and speaks with the text-to-speech provider chosen in
Admin → Voice, when they have an API key: OpenAI, Deepgram, Groq, xAI, Fish
Audio, ElevenLabs or an OpenAI-compatible server. The browser's built-in voice
(`browser-native`) never counts: it runs in the page, and live voice runs on
the server. With no keyed provider chosen, a saved ElevenLabs key still works,
as before.

How each side runs:

- **ElevenLabs** keeps its streaming text-to-speech (`pcm_24000`) and Scribe
  speech-to-text.
- **Every other provider** is asked for a 16-bit WAV per sentence (`wav` /
  `linear16` at 24 kHz where the API takes a rate). `wav_to_pcm16_mono` turns it
  into the 24 kHz mono PCM the client plays, mixing stereo down and resampling
  other rates, and it is sent in ~100 ms chunks like the stream. Listening
  sends each utterance as a 16 kHz WAV to the provider's transcription API.
- The requests themselves are the ones Admin → Voice uses
  (`voice.rs` `tts_request` / `stt_request`), so keys, models, voices and base
  URLs come from the same settings and the vault.

`GET /api/live-voice/preflight` and `settings.liveVoice` report which
providers live voice will use (`sttProvider`, `ttsProvider`, display names)
and, when it cannot start, say what is missing.

## Architecture

```
 Browser                                          Backend (live_voice.rs)
 -------                                          -----------------------
 mic -> getUserMedia -> AudioWorklet
        16 kHz PCM16, 800-sample (50 ms) frames
                       -- binary WS frames -->    energy VAD + room noise floor
                                                    | utterance (<= 30 s, WAV)
                                                    v
                                                  ElevenLabs Scribe (scribe_v1)
                       <-- stt_final ------------    |
 useChat.sendMessage -> /api/chat
   (agent turn: tools, approvals, persistence)
        | assistant text, as it streams
        v
 speak_delta / speak_end  -- JSON WS frames -->  sentence segmenter
                                                  + markdown sanitizer
                                                    | segments
                                                    v
                                                  ElevenLabs streaming TTS
                                                  (eleven_flash_v2_5, pcm_24000)
                       <-- tts_segment, tts_audio (base64 PCM), tts_done
 gapless AudioContext playback -> speakers

 barge-in: sustained speech over playback
                       <-- turn_cancelled --    browser stops the chat stream
                                                and flushes queued audio
```

Division of labour (from the header of `src/lib/voice/protocol.ts`):

- **Browser:** mic capture, gapless playback of `tts_audio`, amplitude metering,
  and bridging the assistant's text into the chat stream.
- **Server:** VAD, turn detection, barge-in, STT, sentence chunking, markdown
  sanitising, and TTS.

The one deliberate difference from Vellum: the agent turn itself runs through
the normal chat stream (`useChat` -> `/api/chat`), not a server-side turn. The
protocol header gives the reason: the turn then shows up live in the thread with
its tool calls and approvals. The server only does speech.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /api/live-voice/ticket` | Issues a one-time ticket: `{ticket, expiresInMs}`. Tickets live 60 s and are kept in memory. |
| `GET /api/live-voice/preflight` | Reports whether STT and TTS both have an ElevenLabs key, with the voice and model. Returns a human-readable `message` when not ready. |
| `GET /api/live-voice?ticket=...&token=...` | WebSocket. The ticket is consumed on upgrade. `token` is the backend sidecar secret, which the sidecar middleware in `backend/src/main.rs` checks for every API call. |

Routes are merged in `backend/src/routes.rs` and defined in
`backend/src/routes/live_voice.rs`.

The key is resolved as `stt` and `tts` slots for `elevenlabs`, the same
namespaced-then-shared lookup as the rest of voice. The shared slot is
`elevenlabs/api_key` in the credential vault (see
[CREDENTIAL-VAULT.md](CREDENTIAL-VAULT.md)).

## Wire protocol

Audio is sent as raw binary frames. Everything else is JSON text. Frame types
are defined in `src/lib/voice/protocol.ts` and parsed in
`backend/src/routes/live_voice.rs`.

### Client to server

| Frame | Meaning |
| --- | --- |
| binary | PCM16 little-endian, 16 kHz, mono, 800 samples (50 ms). Dropped while muted. |
| `start` | Opens the session. `audio` must be `audio/pcm`, 16000 Hz, 1 channel. Optional: `threadId`, `turnDetection` (`server_vad` or `manual`), `silenceThresholdMs` (100 to 5000, default 1200), `bargeInMinSpeechMs` (0 to 3000, default 250), `voiceId`. One start per socket. |
| `ptt_release` | Closes the open utterance now. |
| `interrupt` | Cancels the current turn's speech. |
| `mute` | `{muted}`. Muting drops in-flight audio and the server starts no utterance. |
| `speak_delta` | `{turnId, text}`: assistant text to speak, in order. |
| `speak_end` | `{turnId}`: no more text, so flush the remainder. |
| `playback` | `{active}`: browser playback state, used for the echo estimate. |
| `end` | Closes the session. |

### Server to client

Every server frame carries a monotonic `seq`. The browser drops duplicate or
out-of-order frames (`createSeqFilter`).

| Frame | Meaning |
| --- | --- |
| `ready` | Session id, turn detection mode, TTS settings (`sampleRate: 24000`), STT settings. |
| `speech_started` | VAD saw sustained speech. |
| `utterance_end` | `reason`: `silence`, `max-duration` or `ptt`. STT is running. |
| `utterance_discarded` | `reason`: `too_short` (under 300 ms voiced) or `empty` (blank transcript). |
| `stt_final` | `{text, durationMs}`: the transcript. |
| `turn_cancelled` | `{turnId, reason}`, `barge_in` or `interrupt`. The browser must stop the chat stream for that turn. |
| `tts_segment` | `{turnId, index, text}`: the sentence the next audio belongs to, for captions. |
| `tts_audio` | `{turnId, segment, sampleRate, dataBase64}`: PCM16 LE mono at 24 kHz. |
| `tts_done` | All audio for the turn has been sent. |
| `metrics` | `sttMs` or `ttsFirstAudioMs`. |
| `error` | `{code, message, recoverable}`. Codes are `invalid_json`, `invalid_frame`, `credentials_unavailable`, `stt_failed`, `tts_failed`, `internal`. The browser treats a non-recoverable error as fatal and tears the session down. The server closes the socket after `credentials_unavailable`. |

## One turn, end to end

1. The VAD closes an utterance and sends `utterance_end`, then `stt_final`.
2. The browser's `stt_final` handler calls the chat bridge
   (`src/lib/voice/use-voice-chat-bridge.ts`). The bridge sends the transcript
   with `sendMessage`, so it becomes a normal user message.
3. The chat streams the assistant reply. The bridge sends each new text suffix
   as `speak_delta`, keyed by the assistant message id, and sends `speak_end`
   when the stream stops.
4. The server splits the text into speakable segments, strips markdown and
   fenced code, and streams each segment to ElevenLabs.
5. Audio comes back as `tts_audio`. The browser schedules each chunk back to
   back on one `AudioContext` (`src/lib/voice/tts-playback.ts`).
6. `tts_done` arrives. When playback drains, the phase returns to `listening`.

**Barge-in.** While the assistant is active (audio playing or a turn running),
sustained speech of at least `bargeInMinSpeechMs` cancels it. The server sends
`turn_cancelled` with `reason: "barge_in"` and then `speech_started`. The browser
flushes its audio queue and stops the chat stream. Later deltas for that turn
are ignored on both sides. An explicit stop sends `interrupt` and gets the same
treatment with `reason: "interrupt"`.

## Server voice activity detection

The VAD in `live_voice.rs` is a port of Vellum's `speech-energy` and
`room-noise-floor`.

| Behaviour | Value |
| --- | --- |
| Frame | 50 ms (800 samples), energy = mean absolute amplitude |
| Speech onset | 150 ms above threshold. While the assistant is active, onset instead needs `bargeInMinSpeechMs` (default 250 ms) above the higher of the threshold and 1.5 x the echo estimate. |
| Threshold | max(3 x noise floor, 800), capped at 3200 |
| Noise floor | Minimum of the last 10 one-second block means. Learned only while the assistant is silent. |
| Echo estimate | While the assistant is active and the user is not speaking, an exponential average (alpha 0.083) of the level. Barge-in must also exceed 1.5 x this estimate. Cleared when playback stops. |
| Pre-roll | Up to 25 frames (1.25 s) are kept and prepended at onset. |
| End of speech | `silenceThresholdMs` of quiet (default 1200 ms). Trailing silence beyond 300 ms is trimmed. |
| Too short | Under 300 ms of voiced audio: `utterance_discarded`, `too_short`. |
| Max utterance | 30 s, then `utterance_end` with `max-duration`. |
| Manual mode | Buffers up to 30 s until `ptt_release`. |

## Phase machine

The phase lives in `src/lib/voice/voice-store.ts` (`VoicePhase`).

| Phase | Entered when | Caption shown |
| --- | --- | --- |
| `idle` | Session not active (default) | "Voice is off" |
| `connecting` | `start()` runs: preflight, mic, ticket, socket | "Putting on headphones..." |
| `listening` | `ready`; `tts_done` plus playback drained; a discarded utterance with nothing playing; `interrupt` | "I'm all ears" |
| `hearing` | `speech_started`, or barge-in | "Listening..." |
| `transcribing` | `utterance_end` | "Catching that..." |
| `thinking` | `stt_final`, and when the transcript is sent to the chat | "Thinking it over..." |
| `speaking` | Audio starts playing while `listening`, `thinking` or `speaking` | "<agent> is talking" |
| `error` | Non-recoverable `error`, or the socket closes unexpectedly ("Voice connection lost") | "Something went wrong" |

A recoverable error keeps the current phase and shows its message for 4 s. While
the mic is muted, the caption reads "Your mic is muted" unless the agent is
speaking or thinking.

## Defaults

| Setting | Default | Notes |
| --- | --- | --- |
| Silence threshold | 1200 ms | `start.silenceThresholdMs`, clamped to 100 to 5000 |
| Barge-in minimum speech | 250 ms | `start.bargeInMinSpeechMs`, capped at 3000 |
| Max utterance | 30 s | Fixed |
| Voice | `EXAVITQu4vr4xnSDxMaL` ("Sarah" in the UI) | ElevenLabs voice in voice settings, or a valid `start.voiceId` override. Also the Rust catalog default (`backend/src/routes/voice.rs`). |
| TTS model | `eleven_flash_v2_5` | Fixed in `live_voice.rs` |
| TTS output | `pcm_24000` | Requested from ElevenLabs streaming TTS |
| STT model | `scribe_v1` | Language from `sttLanguage`; `multi` means auto-detect |
| Segment size | Default 180 characters | The first segment of a turn is cut early, at 60 characters on a clause boundary, so speech starts sooner |
| Open TTS requests | 2 per turn | Later segments wait for a slot |
| TTS timeout | 45 s | |
| STT timeout | 60 s | |

Free-tier ElevenLabs keys receive HTTP 402 for library voices. Premade voices
such as Sarah and George work on the free tier. Upstream errors reach the
browser as recoverable `tts_failed` or `stt_failed` messages, with the key
redacted.

## Browser side

| File | Role |
| --- | --- |
| `src/lib/voice/protocol.ts` | Wire contract and constants (`LIVE_VOICE_FRAME_SAMPLES = 800`). |
| `src/lib/voice/pcm-capture.ts` | `getUserMedia` with echo cancellation, noise suppression and auto gain. An inline AudioWorklet downsamples to 16 kHz and posts 50 ms frames. It also computes a smoothed input level. |
| `src/lib/voice/tts-playback.ts` | Decodes base64 PCM16 and schedules chunks gaplessly. Exposes a smoothed output level from an analyser. Mute sets the gain to zero. |
| `src/lib/voice/live-voice-client.ts` | Fetches a ticket, opens the socket, filters `seq`, and wraps send and close. |
| `src/lib/voice/voice-store.ts` | Zustand store with the phase machine, captions, mute flags, and session lifecycle. Amplitudes are read imperatively so audio does not re-render React. |
| `src/lib/voice/use-voice-chat-bridge.ts` | `VoiceBridgeController` (pure) and the hook. Turns transcripts into chat messages and streams assistant text back to the server. |

Wiring in the app:

- `src/components/chat-bot.tsx` calls `useVoiceChatBridge` with the chat's
  `messages`, `status`, `sendMessage` and `stop`. It renders `VoiceRoom` above
  the composer and `VoiceDock` when minimized.
- `src/components/prompt-input.tsx` has the composer voice button
  (`composer-voice-mode-button`). When voice is active it toggles minimize,
  otherwise it starts a session.
- `src/components/layouts/app-header.tsx` has the header button
  (`header-voice-mode-button`) with the same behaviour.
- `src/components/layouts/app-popup-provider.tsx` mounts `VoiceHotkeys`, which
  handles the global shortcut.

The thread id comes from the `thread` query parameter when a session starts.

## Voice room (UI)

Source: `src/components/voice-room/voice-room.tsx`, `voice-mascot.tsx`,
`voice-room-css.ts`.

The agent appears as its plush mascot, the same avatar as in the sidebar. The
mascot reads the agent's identity through `useAgentIdentity`. Four plush
variants exist. The blue plush wears real headphones and gets ear-cup glow.
The others get drawn headphones. A custom avatar image is shown as a circular
avatar instead.

| Phase or state | What the mascot does |
| --- | --- |
| `connecting` | Headphones drop onto the head and the body wiggles. |
| `listening` | Breathes gently. Ear-cup glow pulses. |
| `hearing` | Nods. Sound waves and notes flow into both ears, driven by the mic level. The ear cups scale with the level. |
| `transcribing`, `thinking` | Aura pulses. A thought orbit circles above the head. |
| `speaking` | Sways. The mouth opens with the real output level, and rings radiate outward. |
| `error` | Red aura and a shake. |
| Muted (any phase) | A red mute badge, and the ear-cup glow turns off. |

The mascot's motion is pure CSS driven by `data-phase`, plus two CSS variables
(`--in` for mic level and `--out` for speaker level) that a per-frame hook
writes. Reduced-motion users get static frames.

**Full room.** Shown above the composer when active and not minimized. It has a
top bar with the agent name, voice label, minimize and end. Below the mascot are
the user's caption and the agent's caption. Controls: speaker mute, mic mute,
and End voice. The centre button is "Stop answer" while `thinking` or `speaking`,
and "I'm done talking" in every other phase.

**Companions.** Swarm members in the thread appear as small plush companions
beside the mascot (`useSwarm`). Clicking one calls `openAgentPane`, which opens
that agent beside the chat. See [CHAT-UX-AND-SWARM.md](CHAT-UX-AND-SWARM.md).

**Minimized dock.** `VoiceDock` sits above the composer. It shows a 44 px plush,
the phase line, the latest caption, and mute, stop, expand and end buttons.

### Controls and shortcuts

| Input | Action |
| --- | --- |
| Cmd+Shift+I or Ctrl+Shift+I | Start or end voice. Handled in `VoiceHotkeys`. |
| Space | While `hearing`: finish the turn (`ptt_release`). While `thinking` or `speaking`: stop the answer (`interrupt`). |
| M | Toggle mic mute. |
| Esc | Minimize the room. This does not end the call. |

The Space, M and Esc keys are ignored while focus is in an input, textarea,
select or contenteditable element, and when Ctrl, Meta or Alt is held.

Auto read-aloud is suppressed during a voice call. In `chat-bot.tsx`, the
"speak the reply when the turn finishes" setting is skipped while
`useVoiceStore.getState().active` is true, because the live session already
speaks each answer.

## Verification

These are dated observations from 2026-10-18. They are not release invariants.

- Rust: `cargo test live_voice` passed 23 tests. One ignored live smoke test
  (`live_smoke_elevenlabs_tts_then_stt`) passed against real ElevenLabs, as a TTS
  to STT round trip. It needs `ELEVENLABS_API_KEY`.
- Frontend: `pnpm vitest run src/lib/voice` passed 32 tests.
- Protocol end to end against an isolated backend with real ElevenLabs:
  `speech_started` arrived about 0.65 s after speech onset, STT took 289 ms, and
  first TTS audio arrived in 137 to 198 ms. Markdown was stripped. Barge-in
  cancelled the turn and later deltas were ignored. Sequence numbers were
  contiguous.
- Chromium end to end with a fake microphone: the phases ran connecting, hearing,
  transcribing, thinking, speaking and back to listening. The user caption
  matched the spoken text exactly and the reply appeared in the transcript.
  Minimize, expand, mute and end all worked, with zero console errors.
- That Chromium run used the repo's stub LLM provider
  (`scripts/native-stub-provider.py`). The model itself was not a real provider.

## Limitations

- Not the browser's built-in voice: live voice needs a keyed provider for
  both listening and speaking.
- Providers other than ElevenLabs speak one sentence at a time (whole WAV per
  sentence), so the first words take a little longer than ElevenLabs' stream.
  Only ElevenLabs and the OpenAI-compatible path are exercised in tests
  (the latter against a mock server); the others follow their documented APIs.
- STT is per utterance. There are no partial transcripts while you speak.
- Echo handling relies on browser echo cancellation plus the server's echo
  estimate. Loud speakers or a noisy room can still cause false barge-in.
- One session per socket. The browser store also holds one active session per
  tab.
- Tickets are held in process memory, so a backend restart invalidates any
  unused ticket.
- The browser must stay connected for speech to flow. The agent turn still runs
  through the chat stream, so a dropped chat connection stops the reply.

## Source map

| Area | Files |
| --- | --- |
| Server | `backend/src/routes/live_voice.rs`, `backend/src/routes.rs` |
| Protocol | `src/lib/voice/protocol.ts` |
| Browser engine | `src/lib/voice/voice-store.ts`, `pcm-capture.ts`, `tts-playback.ts`, `live-voice-client.ts`, `use-voice-chat-bridge.ts` |
| UI | `src/components/voice-room/voice-room.tsx`, `voice-mascot.tsx`, `voice-room-css.ts` |
| Wiring | `src/components/chat-bot.tsx`, `src/components/prompt-input.tsx`, `src/components/layouts/app-header.tsx`, `src/components/layouts/app-popup-provider.tsx`, `src/lib/keyboard-shortcuts.ts` |
| Tests | `src/lib/voice/voice-store.test.ts`, `src/lib/voice/use-voice-chat-bridge.test.ts`, Rust `live_voice` unit tests |
