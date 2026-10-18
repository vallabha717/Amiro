"use client";

import {
  getCachedVoiceSettings,
  transcribeSpeech,
} from "@/lib/backend/voice-api";
import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import type { LiveVoicePhase } from "./live-voice-motion";
import { useMessageReadAloudStore } from "./read-aloud-store";

/** Window event the chat composer listens for when voice submits an utterance. */
export const LIVE_VOICE_UTTERANCE_EVENT = "amiro:voice-utterance";

export interface LiveVoiceUtterance {
  text: string;
  threadId: string | null;
}

export type VoiceUtteranceHandler = (utterance: LiveVoiceUtterance) => void;

export type LiveVoiceWaveEngine = "mesh" | "reactive";

let utteranceHandler: VoiceUtteranceHandler | null = null;

/**
 * Register the active composer / chat surface as the consumer of spoken
 * utterances. Returns an unsubscribe function. When no handler is registered,
 * utterances are dispatched on `window` as `LIVE_VOICE_UTTERANCE_EVENT`.
 */
export function registerVoiceUtteranceHandler(
  handler: VoiceUtteranceHandler | null,
): () => void {
  utteranceHandler = handler;
  return () => {
    if (utteranceHandler === handler) {
      utteranceHandler = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Imperative amplitude channel
//
// Visuals read these at 60 fps inside their own animation loop. Keeping them
// out of Zustand avoids a React re-render per audio frame. Values are 0..1.
// ---------------------------------------------------------------------------

let inputAmplitude = 0;
let outputAmplitude = 0;

function clampAmplitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function getLiveVoiceInputAmplitude(): number {
  return inputAmplitude;
}

export function getLiveVoiceOutputAmplitude(): number {
  return outputAmplitude;
}

export function setLiveVoiceInputAmplitude(amplitude: number): void {
  inputAmplitude = clampAmplitude(amplitude);
}

export function setLiveVoiceOutputAmplitude(amplitude: number): void {
  outputAmplitude = clampAmplitude(amplitude);
}

export interface StartLiveVoiceOptions {
  threadId?: string | null;
  minimized?: boolean;
}

export interface LiveVoiceState {
  /** Whether a live voice session is running. */
  active: boolean;
  /**
   * `false` shows the expressive character stage above the composer; `true`
   * collapses to Vellum's compact composer bar + header pill.
   */
  minimized: boolean;
  phase: LiveVoicePhase;
  /** Microphone muted. */
  muted: boolean;
  /** Assistant voice muted. */
  outputMuted: boolean;
  assistantAudioActive: boolean;
  /** Live (interim) user speech transcript. */
  partialTranscript: string;
  /** Last finalized user utterance. */
  finalTranscript: string;
  /** Current / last assistant response being spoken. */
  assistantTranscript: string;
  error: string | null;
  threadId: string | null;
  /** Optional eye/expression style override; `null` lets the agent express. */
  eyeStyleOverride: string | null;
  waveEngine: LiveVoiceWaveEngine;
  showCaptions: boolean;

  startSession: (opts?: StartLiveVoiceOptions) => void;
  endSession: () => void;
  minimizeRoom: () => void;
  restoreRoom: () => void;
  toggleMinimize: () => void;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  setOutputMuted: (outputMuted: boolean) => void;
  toggleOutputMuted: () => void;
  setPhase: (phase: LiveVoicePhase) => void;
  setAssistantAudioActive: (active: boolean) => void;
  setUserTranscript: (partial: string, final?: string) => void;
  setAssistantTranscript: (text: string) => void;
  setError: (error: string | null) => void;
  setWaveEngine: (engine: LiveVoiceWaveEngine) => void;
  setShowCaptions: (show: boolean) => void;
  setEyeStyleOverride: (eyeStyle: string | null) => void;
  /** Send a spoken (or typed test) utterance to the active chat thread. */
  submitVoiceUtterance: (text: string) => void;
}

const INITIAL_TRANSCRIPTS = {
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
};

export const useLiveVoiceStore = create<LiveVoiceState>()((set, get) => ({
  active: false,
  minimized: false,
  phase: "idle",
  muted: false,
  outputMuted: false,
  assistantAudioActive: false,
  ...INITIAL_TRANSCRIPTS,
  error: null,
  threadId: null,
  eyeStyleOverride: null,
  waveEngine: "mesh",
  showCaptions: true,

  startSession: (opts) => {
    setLiveVoiceInputAmplitude(0);
    setLiveVoiceOutputAmplitude(0);
    set({
      active: true,
      minimized: opts?.minimized ?? false,
      phase: "connecting",
      muted: false,
      outputMuted: false,
      assistantAudioActive: false,
      ...INITIAL_TRANSCRIPTS,
      error: null,
      threadId: opts?.threadId ?? null,
    });
  },

  endSession: () => {
    setLiveVoiceInputAmplitude(0);
    setLiveVoiceOutputAmplitude(0);
    set({
      active: false,
      phase: "idle",
      minimized: false,
      muted: false,
      outputMuted: false,
      assistantAudioActive: false,
      ...INITIAL_TRANSCRIPTS,
      error: null,
    });
  },

  minimizeRoom: () => set({ minimized: true }),
  restoreRoom: () => set({ minimized: false }),
  toggleMinimize: () => set((state) => ({ minimized: !state.minimized })),

  setMuted: (muted) => set({ muted }),
  toggleMuted: () => set((state) => ({ muted: !state.muted })),

  setOutputMuted: (outputMuted) => set({ outputMuted }),
  toggleOutputMuted: () =>
    set((state) => ({ outputMuted: !state.outputMuted })),

  setPhase: (phase) =>
    set((state) => ({
      phase,
      error: phase === "error" ? state.error : null,
    })),

  setAssistantAudioActive: (assistantAudioActive) =>
    set({ assistantAudioActive }),

  setUserTranscript: (partial, final) =>
    set((state) => ({
      partialTranscript: partial,
      finalTranscript: final === undefined ? state.finalTranscript : final,
    })),

  setAssistantTranscript: (assistantTranscript) => set({ assistantTranscript }),

  setError: (error) => set({ error }),

  setWaveEngine: (waveEngine) => set({ waveEngine }),

  setShowCaptions: (showCaptions) => set({ showCaptions }),

  setEyeStyleOverride: (eyeStyleOverride) => set({ eyeStyleOverride }),

  submitVoiceUtterance: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { threadId } = get();
    set({
      partialTranscript: "",
      finalTranscript: trimmed,
      assistantTranscript: "",
      error: null,
      phase: "thinking",
    });
    const payload: LiveVoiceUtterance = { text: trimmed, threadId };
    if (utteranceHandler) {
      utteranceHandler(payload);
      return;
    }
    if (
      typeof window !== "undefined" &&
      typeof window.dispatchEvent === "function"
    ) {
      const event =
        typeof CustomEvent === "function"
          ? new CustomEvent<LiveVoiceUtterance>(LIVE_VOICE_UTTERANCE_EVENT, {
              detail: payload,
            })
          : new Event(LIVE_VOICE_UTTERANCE_EVENT);
      if (!("detail" in event)) {
        Object.assign(event, { detail: payload });
      }
      window.dispatchEvent(event);
    }
  },
}));

/** Reset module-level voice plumbing between tests. */
export function _resetLiveVoiceForTesting(): void {
  utteranceHandler = null;
  inputAmplitude = 0;
  outputAmplitude = 0;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function getAudioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/** Runs `cb` on the next animation frame, returning a cancel function. */
function scheduleFrame(cb: () => void): () => void {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    const id = window.requestAnimationFrame(cb);
    return () => window.cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 33);
  return () => clearTimeout(id);
}

function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
      reader.readAsDataURL(blob);
    });
  }
  return blob
    .arrayBuffer()
    .then((buffer) => Buffer.from(buffer).toString("base64"));
}

export interface LiveVoiceController {
  /** Submit an utterance immediately (used by Send / quick prompts). */
  submitUtterance: (text: string) => void;
  /** Finalize the in-flight utterance (spacebar / "Done speaking"). */
  finishListening: () => void;
}

/**
 * Hands-free voice conversation controller.
 *
 * - Mirrors `useMessageReadAloudStore` into the live phase / amplitude channel,
 *   so any configured TTS provider (not just OpenAI Realtime) drives the
 *   expressive character.
 * - Captures the mic while `active && !muted && phase === "listening"` using an
 *   AnalyserNode for real-time amplitude, plus SpeechRecognition when available
 *   or MediaRecorder + `transcribeSpeech` VAD when it is not.
 * - Degrades gracefully: denied / missing getUserMedia, SpeechRecognition, or
 *   MediaRecorder keeps the session alive in `"listening"` with a gentle
 *   simulated breathing amplitude. Typed / quick-prompt utterances still flow
 *   through `submitVoiceUtterance`.
 */
export function useLiveVoiceController(): LiveVoiceController {
  const finalizeRef = useRef<(() => void) | null>(null);

  // Track the read-aloud player (any TTS provider) and mirror it into the
  // live-voice phase / amplitude channel.
  useEffect(() => {
    const applyReadAloudState = () => {
      const readAloud = useMessageReadAloudStore.getState();
      const live = useLiveVoiceStore.getState();
      if (!live.active) return;

      const speaking =
        readAloud.status === "playing" || readAloud.status === "loading";
      if (speaking) {
        if (live.outputMuted) {
          readAloud.stop();
          return;
        }
        if (!live.assistantAudioActive) live.setAssistantAudioActive(true);
        if (live.phase !== "speaking") live.setPhase("speaking");
        return;
      }

      if (live.assistantAudioActive) live.setAssistantAudioActive(false);
      if (live.phase === "speaking") {
        live.setPhase(live.muted ? "idle" : "listening");
      }
    };

    applyReadAloudState();
    const unsubscribeReadAloud =
      useMessageReadAloudStore.subscribe(applyReadAloudState);
    const unsubscribeLive = useLiveVoiceStore.subscribe((state, previous) => {
      if (state.active !== previous.active) {
        if (!state.active && previous.active) {
          useMessageReadAloudStore.getState().stop();
        }
        applyReadAloudState();
      }
    });
    return () => {
      unsubscribeReadAloud();
      unsubscribeLive();
    };
  }, []);

  // Stop assistant playback immediately when output mute is toggled on.
  useEffect(() => {
    return useLiveVoiceStore.subscribe((state, previous) => {
      if (state.outputMuted && !previous.outputMuted && state.active) {
        const readAloud = useMessageReadAloudStore.getState();
        if (readAloud.status !== "idle") readAloud.stop();
      }
    });
  }, []);

  // Drive a plausible output envelope while assistant audio is active. TTS
  // playback may be an <audio> element or browser speechSynthesis, neither of
  // which exposes a reliable analyser, so the visual layer uses a breathing
  // envelope in sync with the playing state.
  const active = useLiveVoiceStore((state) => state.active);
  const assistantAudioActive = useLiveVoiceStore(
    (state) => state.assistantAudioActive,
  );
  useEffect(() => {
    if (!active || !assistantAudioActive) {
      setLiveVoiceOutputAmplitude(0);
      return;
    }
    const startedAt = Date.now();
    let cancel = () => {};
    const tick = () => {
      const t = (Date.now() - startedAt) / 1000;
      const envelope =
        0.42 +
        0.2 * Math.sin(t * 5.3) +
        0.12 * Math.sin(t * 8.9 + 1.7) +
        0.06 * Math.sin(t * 13.1 + 0.4);
      setLiveVoiceOutputAmplitude(envelope);
      cancel = scheduleFrame(tick);
    };
    tick();
    return () => {
      cancel();
      setLiveVoiceOutputAmplitude(0);
    };
  }, [active, assistantAudioActive]);

  // Give the "connecting" phase a brief settle, then open the mic.
  const phase = useLiveVoiceStore((state) => state.phase);
  useEffect(() => {
    if (!active || phase !== "connecting") return;
    const timer = setTimeout(() => {
      const live = useLiveVoiceStore.getState();
      if (live.active && live.phase === "connecting") {
        live.setPhase("listening");
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [active, phase]);

  const muted = useLiveVoiceStore((state) => state.muted);

  // Microphone capture. Re-runs whenever the session enters / leaves listening.
  useEffect(() => {
    if (!active || muted || phase !== "listening") {
      finalizeRef.current = null;
      return;
    }

    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const addCleanup = (fn: () => void) => cleanups.push(fn);

    const startSimulation = () => {
      const startedAt = Date.now();
      let cancel = () => {};
      const tick = () => {
        if (cancelled) return;
        const t = (Date.now() - startedAt) / 1000;
        const breathing =
          0.07 + 0.04 * Math.sin(t * 1.9) + 0.018 * Math.sin(t * 3.7 + 1.1);
        setLiveVoiceInputAmplitude(breathing);
        cancel = scheduleFrame(tick);
      };
      tick();
      addCleanup(() => {
        cancel();
        setLiveVoiceInputAmplitude(0);
      });
    };

    const begin = async () => {
      const navigatorLike = typeof navigator !== "undefined" ? navigator : null;
      const canCapture = Boolean(navigatorLike?.mediaDevices?.getUserMedia);
      if (!canCapture) {
        startSimulation();
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigatorLike!.mediaDevices.getUserMedia({
          audio: true,
        });
      } catch {
        if (!cancelled) startSimulation();
        return;
      }

      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      addCleanup(() => {
        for (const track of stream.getTracks()) track.stop();
      });

      const AudioContextCtor = getAudioContextCtor();
      let analyser: AnalyserNode | null = null;
      let audioContext: AudioContext | null = null;

      if (AudioContextCtor) {
        try {
          audioContext = new AudioContextCtor();
          const source = audioContext.createMediaStreamSource(stream);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.25;
          source.connect(analyser);
          addCleanup(() => {
            void audioContext?.close().catch(() => {});
          });
        } catch {
          analyser = null;
        }
      }

      const analyserData = analyser ? new Float32Array(analyser.fftSize) : null;

      const readRms = (): number => {
        if (!analyser || !analyserData) return 0;
        analyser.getFloatTimeDomainData(
          analyserData as Float32Array<ArrayBuffer>,
        );
        let sum = 0;
        for (let i = 0; i < analyserData.length; i++) {
          const sample = analyserData[i];
          sum += sample * sample;
        }
        return clampAmplitude(Math.sqrt(sum / analyserData.length) * 3.2);
      };

      let amplitudeCancel = () => {};
      const amplitudeLoop = () => {
        if (cancelled) return;
        setLiveVoiceInputAmplitude(readRms());
        amplitudeCancel = scheduleFrame(amplitudeLoop);
      };
      amplitudeCancel = scheduleFrame(amplitudeLoop);
      addCleanup(() => {
        amplitudeCancel();
        setLiveVoiceInputAmplitude(0);
      });

      const settings = getCachedVoiceSettings();
      const provider = settings.sttProvider || "browser-native";
      const providerState = settings.sttProviders[provider];

      const submitTranscript = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const live = useLiveVoiceStore.getState();
        if (!live.active) return;
        live.setUserTranscript("", trimmed);
        live.submitVoiceUtterance(trimmed);
      };

      // Preferred: browser SpeechRecognition gives us interim results.
      const RecognitionCtor = getSpeechRecognitionCtor();
      if (RecognitionCtor) {
        try {
          const recognition = new RecognitionCtor();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang =
            providerState?.language || settings.sttLanguage || "en";
          let finalText = "";
          let interimText = "";

          recognition.onresult = (event) => {
            interimText = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const result = event.results[i];
              if (!result) continue;
              const transcript = result[0]?.transcript ?? "";
              if (result.isFinal) finalText += transcript;
              else interimText += transcript;
            }
            const live = useLiveVoiceStore.getState();
            if (!live.active) return;
            live.setUserTranscript(`${finalText}${interimText}`.trim());
            if (finalText.trim() && !interimText.trim()) {
              const text = finalText.trim();
              finalText = "";
              submitTranscript(text);
            }
          };

          recognition.onerror = () => {
            // Permission denied / no speech service: keep the session alive in
            // listening so typed and quick-prompt utterances still work.
            if (!cancelled) {
              useLiveVoiceStore.getState().setError(null);
            }
          };

          recognition.start();
          addCleanup(() => {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
              recognition.abort();
            } catch {
              // already stopped
            }
          });
          return;
        } catch {
          // Fall through to MediaRecorder / ambient capture.
        }
      }

      // Fallback: MediaRecorder + silence VAD + server transcription.
      const MediaRecorderCtor =
        typeof window !== "undefined" ? window.MediaRecorder : undefined;
      if (MediaRecorderCtor && provider !== "browser-native") {
        try {
          const mimeType = MediaRecorderCtor.isTypeSupported?.("audio/webm")
            ? "audio/webm"
            : undefined;
          const recorder = mimeType
            ? new MediaRecorderCtor(stream, { mimeType })
            : new MediaRecorderCtor(stream);
          const chunks: BlobPart[] = [];
          let finishing = false;
          let sawSpeech = false;
          let silenceStartedAt = 0;
          let speechStartedAt = 0;

          const transcribeBlob = async () => {
            const blob = new Blob(chunks, {
              type: recorder.mimeType || "audio/webm",
            });
            const live = useLiveVoiceStore.getState();
            if (!live.active || blob.size === 0) return;
            live.setPhase("transcribing");
            try {
              const audio = await blobToBase64(blob);
              const result = await transcribeSpeech({
                audio,
                mimeType: blob.type || "audio/webm",
                provider,
                model: providerState?.model,
                language: providerState?.language || settings.sttLanguage,
                baseUrl: providerState?.baseUrl,
              });
              const text = (result?.text || "").trim();
              const current = useLiveVoiceStore.getState();
              if (!current.active) return;
              if (text) {
                submitTranscript(text);
              } else {
                current.setPhase(current.muted ? "idle" : "listening");
              }
            } catch (error) {
              const current = useLiveVoiceStore.getState();
              if (!current.active) return;
              current.setError(
                error instanceof Error
                  ? error.message
                  : "Voice transcription failed",
              );
              current.setPhase(current.muted ? "idle" : "listening");
            }
          };

          const finishRecording = () => {
            if (finishing) return;
            finishing = true;
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {
              // ignore
            }
          };
          finalizeRef.current = finishRecording;

          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
          };
          recorder.onstop = () => {
            void transcribeBlob();
          };
          recorder.start();

          let vadCancel = () => {};
          const vadLoop = () => {
            if (cancelled) return;
            const now = Date.now();
            const rms = readRms();
            setLiveVoiceInputAmplitude(rms);
            if (rms > 0.05) {
              sawSpeech = true;
              silenceStartedAt = 0;
              if (speechStartedAt === 0) speechStartedAt = now;
            } else if (sawSpeech) {
              if (silenceStartedAt === 0) {
                silenceStartedAt = now;
              } else if (now - silenceStartedAt > 1100) {
                finishRecording();
                return;
              }
            }
            // Hard cap so a noisy room cannot record forever.
            if (speechStartedAt > 0 && now - speechStartedAt > 30000) {
              finishRecording();
              return;
            }
            vadCancel = scheduleFrame(vadLoop);
          };
          vadCancel = scheduleFrame(vadLoop);

          addCleanup(() => {
            vadCancel();
            finalizeRef.current = null;
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {
              // ignore
            }
          });
          return;
        } catch {
          // Fall through to ambient analyser capture.
        }
      }

      // Last resort: keep the analyser-driven visual alive with no STT.
      let ambientCancel = () => {};
      const ambientLoop = () => {
        if (cancelled) return;
        setLiveVoiceInputAmplitude(readRms());
        ambientCancel = scheduleFrame(ambientLoop);
      };
      ambientCancel = scheduleFrame(ambientLoop);
      addCleanup(() => {
        ambientCancel();
        setLiveVoiceInputAmplitude(0);
      });
    };

    void begin();

    return () => {
      cancelled = true;
      finalizeRef.current = null;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // best-effort teardown
        }
      }
    };
  }, [active, muted, phase]);

  // Spacebar finalizes the in-flight utterance when focus is not in an input.
  const finishListening = useCallback(() => {
    const live = useLiveVoiceStore.getState();
    if (!live.active) return;
    const spoken = live.partialTranscript.trim();
    if (spoken) {
      live.submitVoiceUtterance(spoken);
      return;
    }
    finalizeRef.current?.();
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const live = useLiveVoiceStore.getState();
      if (!live.active || live.phase !== "listening") return;
      event.preventDefault();
      finishListening();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, finishListening]);

  const submitUtterance = useCallback((text: string) => {
    useLiveVoiceStore.getState().submitVoiceUtterance(text);
  }, []);

  return { submitUtterance, finishListening };
}
