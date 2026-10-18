/**
 * Live voice wire protocol -- the contract between the browser and
 * backend/src/routes/live_voice.rs. Modeled on Vellum's live-voice protocol
 * (one WebSocket, binary PCM up, JSON frames down, monotonic `seq`).
 *
 * Division of labour (same as Vellum):
 *   browser  -- mic capture (PCM16 LE, 16 kHz mono, 50 ms binary frames),
 *               gapless playback of `tts_audio`, amplitude metering.
 *   server   -- energy VAD + room noise floor, turn detection, barge-in,
 *               ElevenLabs Scribe STT, sentence chunking + markdown
 *               sanitizing, ElevenLabs streaming TTS (pcm_24000).
 *
 * One difference: the agent turn itself runs through the normal chat stream
 * (useChat -> /api/chat) so it shows up live in the thread with tool calls
 * and approvals. The browser forwards the assistant's text to the server as
 * `speak_delta` frames and the server speaks it.
 *
 * Endpoints:
 *   POST /api/live-voice/ticket     -> { ticket: string, expiresInMs: number }
 *   GET  /api/live-voice/preflight  -> LiveVoicePreflight
 *   GET  /api/live-voice?ticket=..&token=<sidecar secret>   (WebSocket)
 */

export const LIVE_VOICE_INPUT_SAMPLE_RATE = 16000;
/** 50 ms of 16 kHz audio. */
export const LIVE_VOICE_FRAME_SAMPLES = 800;

export interface LiveVoicePreflight {
  ready: boolean;
  stt: { provider: string; configured: boolean; model: string };
  tts: {
    provider: string;
    configured: boolean;
    model: string;
    voiceId: string;
  };
  /** Human readable reason when not ready. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Client -> server (JSON text frames). Audio goes as raw binary frames.
// ---------------------------------------------------------------------------

export interface StartFrame {
  type: "start";
  /** Thread the session belongs to (informational, for logs). */
  threadId?: string;
  audio: { mimeType: "audio/pcm"; sampleRate: 16000; channels: 1 };
  /** "server_vad" (default) ends turns on silence; "manual" waits for ptt_release. */
  turnDetection?: "server_vad" | "manual";
  /** 100..5000, default 1200. */
  silenceThresholdMs?: number;
  /** 0..3000, default 250. */
  bargeInMinSpeechMs?: number;
  /** Override the configured ElevenLabs voice. */
  voiceId?: string;
}

export type ClientFrame =
  | StartFrame
  /** Force-end the current utterance (push-to-talk release / tap). */
  | { type: "ptt_release" }
  /** User stopped the reply: cancel synthesis of the current turn. */
  | { type: "interrupt" }
  /** Mic muted: server drops audio and never starts an utterance. */
  | { type: "mute"; muted: boolean }
  /** Assistant text for `turnId`, in order, as it streams. */
  | { type: "speak_delta"; turnId: string; text: string }
  /** No more text for `turnId`: flush the remainder, then send tts_done. */
  | { type: "speak_end"; turnId: string }
  /** Browser playback started/drained; feeds the server's echo estimate. */
  | { type: "playback"; active: boolean }
  | { type: "end" };

// ---------------------------------------------------------------------------
// Server -> client (JSON text frames, every one with a monotonic seq)
// ---------------------------------------------------------------------------

interface Base {
  seq: number;
}

export type ServerFrame = Base &
  (
    | {
        type: "ready";
        sessionId: string;
        turnDetection: "server_vad" | "manual";
        tts: {
          provider: string;
          voiceId: string;
          model: string;
          sampleRate: number;
        };
        stt: { provider: string; model: string };
      }
    /** VAD saw sustained speech (the user started talking). */
    | { type: "speech_started" }
    /** Utterance closed; STT is running. */
    | { type: "utterance_end"; reason: "silence" | "max-duration" | "ptt" }
    /** Too short / empty transcript: nothing to send. */
    | { type: "utterance_discarded"; reason: string }
    | { type: "stt_final"; text: string; durationMs: number }
    /**
     * Speech over the assistant (barge-in). The browser must stop the chat
     * stream for that turn and flush queued audio.
     */
    | {
        type: "turn_cancelled";
        turnId: string | null;
        reason: "barge_in" | "interrupt";
      }
    /** The sentence the next tts_audio chunks belong to (for captions). */
    | { type: "tts_segment"; turnId: string; index: number; text: string }
    /** Raw PCM16 LE mono at sampleRate, base64. */
    | {
        type: "tts_audio";
        turnId: string;
        segment: number;
        mimeType: "audio/pcm";
        sampleRate: number;
        dataBase64: string;
      }
    /** All audio for the turn has been sent. */
    | { type: "tts_done"; turnId: string }
    | {
        type: "metrics";
        turnId?: string;
        sttMs?: number;
        ttsFirstAudioMs?: number;
      }
    | {
        type: "error";
        code:
          | "invalid_json"
          | "invalid_frame"
          | "credentials_unavailable"
          | "stt_failed"
          | "tts_failed"
          | "internal";
        message: string;
        recoverable: boolean;
      }
  );

export type ServerFrameType = ServerFrame["type"];
