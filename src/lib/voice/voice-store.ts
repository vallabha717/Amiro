import { create } from "zustand";
import { fetcher } from "../backend/client";
import {
  type LiveVoiceConnection,
  connectLiveVoice,
} from "./live-voice-client";
import {
  type PcmCapture,
  getPcmInputLevel,
  startPcmCapture,
} from "./pcm-capture";
import type { LiveVoicePreflight, ServerFrame } from "./protocol";
import { type PcmPlayer, createPcmPlayer } from "./tts-playback";

export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export interface VoiceState {
  active: boolean;
  phase: VoicePhase;
  muted: boolean;
  outputMuted: boolean;
  minimized: boolean;
  threadId: string | null;
  userCaption: string;
  assistantCaption: string;
  error: string | null;
  voiceLabel: string | null;
  start: (threadId: string | null) => Promise<void>;
  end: () => void;
  toggleMuted: () => void;
  toggleOutputMuted: () => void;
  setMinimized: (v: boolean) => void;
  interrupt: () => void;
  pttRelease: () => void;
}

const VOICE_NAMES: Record<string, string> = {
  EXAVITQu4vr4xnSDxMaL: "Sarah",
  JBFqnCBsd6RMkjVDRZzb: "George",
};

const PROVIDER_NAMES: Record<string, string> = {
  elevenlabs: "ElevenLabs",
};

export function formatVoiceLabel(provider: string, voiceId: string): string {
  const p = PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
  return `${p} · ${VOICE_NAMES[voiceId] ?? voiceId}`;
}

const ERROR_CLEAR_MS = 4000;

const initial = {
  active: false,
  phase: "idle" as VoicePhase,
  muted: false,
  outputMuted: false,
  minimized: false,
  threadId: null as string | null,
  userCaption: "",
  assistantCaption: "",
  error: null as string | null,
  voiceLabel: null as string | null,
};

// ---- session-scoped mutable state (outside zustand: never drives renders) ----
let conn: LiveVoiceConnection | null = null;
let capture: PcmCapture | null = null;
let player: PcmPlayer | null = null;
let unsubs: Array<() => void> = [];
let sessionSeq = 0;
let ready = false;
let ending = false;
let ttsDonePending = false;
let activeTurnId: string | null = null;
const cancelledTurns = new Set<string>();
const segmentText = new Map<string, string>();
let errorTimer: ReturnType<typeof setTimeout> | null = null;

const utteranceListeners = new Set<(text: string) => void>();
const cancelListeners = new Set<(turnId: string | null) => void>();

export function onVoiceUtterance(cb: (text: string) => void): () => void {
  utteranceListeners.add(cb);
  return () => utteranceListeners.delete(cb);
}
export function onVoiceTurnCancelled(
  cb: (turnId: string | null) => void,
): () => void {
  cancelListeners.add(cb);
  return () => cancelListeners.delete(cb);
}

export function getVoiceInputLevel(): number {
  const s = useVoiceStore.getState();
  if (!s.active || s.muted) return 0;
  return getPcmInputLevel();
}
export function getVoiceOutputLevel(): number {
  return player?.level() ?? 0;
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  const setError = (message: string, phase?: VoicePhase) => {
    if (errorTimer) clearTimeout(errorTimer);
    set(phase ? { error: message, phase } : { error: message });
    if (!phase) {
      errorTimer = setTimeout(() => {
        errorTimer = null;
        if (get().phase !== "error") set({ error: null });
      }, ERROR_CLEAR_MS);
    }
  };

  const setPhase = (phase: VoicePhase) => {
    if (get().phase !== phase) set({ phase });
  };

  const teardownTransport = () => {
    for (const u of unsubs) u();
    unsubs = [];
    const c = conn;
    conn = null;
    ready = false;
    try {
      c?.close();
    } catch {}
    capture?.stop();
    capture = null;
  };

  const resetTurnState = () => {
    ttsDonePending = false;
    activeTurnId = null;
    cancelledTurns.clear();
    segmentText.clear();
  };

  const fail = (message: string) => {
    ending = true;
    teardownTransport();
    player?.flush();
    setError(message, "error");
  };

  const returnToListeningIfDone = () => {
    const phase = get().phase;
    if (
      ttsDonePending &&
      !player?.isPlaying() &&
      (phase === "speaking" || phase === "thinking")
    ) {
      ttsDonePending = false;
      set({ phase: "listening", assistantCaption: "" });
    }
  };

  const cancelTurn = (turnId: string | null) => {
    if (turnId) cancelledTurns.add(turnId);
    if (activeTurnId) cancelledTurns.add(activeTurnId);
    ttsDonePending = false;
    segmentText.clear();
    player?.flush();
    for (const cb of [...cancelListeners]) cb(turnId ?? activeTurnId);
  };

  const handleFrame = (frame: ServerFrame) => {
    switch (frame.type) {
      case "ready": {
        ready = true;
        set({
          phase: "listening",
          voiceLabel: formatVoiceLabel(frame.tts.provider, frame.tts.voiceId),
          error: null,
        });
        break;
      }
      case "speech_started":
        set({ phase: "hearing", userCaption: "" });
        break;
      case "utterance_end":
        setPhase("transcribing");
        break;
      case "utterance_discarded":
        setPhase(player?.isPlaying() ? "speaking" : "listening");
        break;
      case "stt_final": {
        set({
          userCaption: frame.text,
          phase: "thinking",
          assistantCaption: "",
        });
        for (const cb of [...utteranceListeners]) cb(frame.text);
        break;
      }
      case "turn_cancelled": {
        cancelTurn(frame.turnId);
        set({
          phase: frame.reason === "barge_in" ? "hearing" : "listening",
          assistantCaption: "",
        });
        break;
      }
      case "tts_segment": {
        if (cancelledTurns.has(frame.turnId)) break;
        const tag = `${frame.turnId}:${frame.index}`;
        segmentText.set(tag, frame.text);
        if (!player?.isPlaying()) set({ assistantCaption: frame.text });
        break;
      }
      case "tts_audio": {
        if (cancelledTurns.has(frame.turnId) || !player) break;
        if (activeTurnId !== frame.turnId) ttsDonePending = false;
        activeTurnId = frame.turnId;
        player.enqueue(
          frame.dataBase64,
          frame.sampleRate,
          `${frame.turnId}:${frame.segment}`,
        );
        break;
      }
      case "tts_done": {
        if (cancelledTurns.has(frame.turnId)) break;
        ttsDonePending = true;
        returnToListeningIfDone();
        break;
      }
      case "error": {
        if (frame.recoverable) setError(frame.message);
        else fail(frame.message);
        break;
      }
      default:
        break;
    }
  };

  return {
    ...initial,

    async start(threadId) {
      if (get().active) return;
      const id = ++sessionSeq;
      ending = false;
      resetTurnState();
      if (errorTimer) clearTimeout(errorTimer);
      set({
        ...initial,
        minimized: get().minimized,
        active: true,
        phase: "connecting",
        threadId,
      });
      const stale = () => id !== sessionSeq;

      // Unlock audio synchronously inside the click handler.
      const p = createPcmPlayer();
      p.setMuted(get().outputMuted);
      p.unlock();
      player = p;
      p.onStateChange((playing) => {
        conn?.send({ type: "playback", active: playing });
        if (playing) {
          const phase = get().phase;
          if (
            phase === "listening" ||
            phase === "thinking" ||
            phase === "speaking"
          ) {
            setPhase("speaking");
          }
        } else {
          returnToListeningIfDone();
        }
      });
      p.onSegmentStart((tag) => {
        const text = segmentText.get(tag);
        if (text !== undefined) set({ assistantCaption: text });
      });

      try {
        const pre = await fetcher("/api/live-voice/preflight").catch(
          (e: unknown) => {
            throw new Error(
              e instanceof Error ? e.message : "Voice preflight failed",
            );
          },
        );
        if (stale()) return;
        const preflight = pre as LiveVoicePreflight;
        if (!preflight.ready) {
          fail(preflight.message || "Live voice is not configured");
          return;
        }

        const cap = await startPcmCapture({
          onFrame: (pcm) => {
            if (ready && !get().muted) conn?.sendAudio(pcm);
          },
        });
        if (stale()) {
          cap.stop();
          return;
        }
        capture = cap;

        const c = await connectLiveVoice();
        if (stale()) {
          c.close();
          return;
        }
        conn = c;
        unsubs.push(c.onFrame(handleFrame));
        unsubs.push(
          c.onClose(() => {
            if (ending || stale()) return;
            fail("Voice connection lost");
          }),
        );
        c.send({
          type: "start",
          ...(threadId ? { threadId } : {}),
          audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
        });
      } catch (err) {
        if (stale()) return;
        fail(err instanceof Error ? err.message : "Could not start voice");
      }
    },

    end() {
      sessionSeq++;
      ending = true;
      try {
        conn?.send({ type: "end" });
      } catch {}
      teardownTransport();
      player?.close();
      player = null;
      resetTurnState();
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = null;
      set({ ...initial, minimized: get().minimized });
    },

    toggleMuted() {
      const muted = !get().muted;
      set({ muted });
      conn?.send({ type: "mute", muted });
    },

    toggleOutputMuted() {
      const outputMuted = !get().outputMuted;
      set({ outputMuted });
      player?.setMuted(outputMuted);
    },

    setMinimized(v) {
      set({ minimized: v });
    },

    interrupt() {
      if (!get().active) return;
      const turn = activeTurnId;
      cancelTurn(turn);
      conn?.send({ type: "interrupt" });
      const phase = get().phase;
      if (phase === "speaking" || phase === "thinking") {
        set({ phase: "listening", assistantCaption: "" });
      }
    },

    pttRelease() {
      conn?.send({ type: "ptt_release" });
    },
  };
});

/** Bridge -> store: speak assistant text for a turn. */
export function speakDelta(turnId: string, text: string): void {
  if (!conn || !text || cancelledTurns.has(turnId)) return;
  activeTurnId = turnId;
  conn.send({ type: "speak_delta", turnId, text });
}

export function speakEnd(turnId: string): void {
  if (!conn || cancelledTurns.has(turnId)) return;
  conn.send({ type: "speak_end", turnId });
}

/** Bridge -> store: the agent is working on the last utterance. */
export function markThinking(): void {
  const { phase } = useVoiceStore.getState();
  if (
    phase === "listening" ||
    phase === "hearing" ||
    phase === "transcribing"
  ) {
    useVoiceStore.setState({ phase: "thinking" });
  }
}
