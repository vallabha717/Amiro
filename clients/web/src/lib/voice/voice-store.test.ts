import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "./protocol";

const h = vi.hoisted(() => {
  const state = {
    frameCb: null as null | ((f: unknown) => void),
    closeCb: null as null | ((e: unknown) => void),
    sent: [] as unknown[],
    audio: [] as ArrayBuffer[],
    closed: false,
    captureStopped: false,
    onFrameCapture: null as null | ((b: ArrayBuffer) => void),
    playing: false,
    stateCb: null as null | ((p: boolean) => void),
    segCb: null as null | ((t: string) => void),
    enqueued: [] as Array<[string, number, string | undefined]>,
    flushed: 0,
    muted: false,
    preflight: { ready: true } as Record<string, unknown>,
  };
  return state;
});

vi.mock("../backend/client", () => ({
  fetcher: vi.fn(async () => h.preflight),
}));
vi.mock("./live-voice-client", () => ({
  connectLiveVoice: vi.fn(async () => ({
    send: (f: unknown) => h.sent.push(f),
    sendAudio: (b: ArrayBuffer) => h.audio.push(b),
    close: () => {
      h.closed = true;
    },
    onFrame: (cb: (f: unknown) => void) => {
      h.frameCb = cb;
      return () => {};
    },
    onClose: (cb: (e: unknown) => void) => {
      h.closeCb = cb;
      return () => {};
    },
  })),
}));
vi.mock("./pcm-capture", () => ({
  getPcmInputLevel: () => 0.3,
  startPcmCapture: vi.fn(async (o: { onFrame: (b: ArrayBuffer) => void }) => {
    h.onFrameCapture = o.onFrame;
    return {
      context: {},
      stop: () => {
        h.captureStopped = true;
      },
    };
  }),
}));
vi.mock("./tts-playback", () => ({
  createPcmPlayer: () => ({
    unlock: () => {},
    enqueue: (b: string, r: number, t?: string) => {
      h.enqueued.push([b, r, t]);
      if (!h.playing) {
        h.playing = true;
        h.stateCb?.(true);
      }
    },
    flush: () => {
      h.flushed++;
      if (h.playing) {
        h.playing = false;
        h.stateCb?.(false);
      }
    },
    setMuted: (m: boolean) => {
      h.muted = m;
    },
    isPlaying: () => h.playing,
    onStateChange: (cb: (p: boolean) => void) => {
      h.stateCb = cb;
      return () => {};
    },
    onSegmentStart: (cb: (t: string) => void) => {
      h.segCb = cb;
      return () => {};
    },
    level: () => 0.5,
    close: () => {},
  }),
}));

import {
  formatVoiceLabel,
  getVoiceInputLevel,
  getVoiceOutputLevel,
  markThinking,
  onVoiceTurnCancelled,
  onVoiceUtterance,
  speakDelta,
  speakEnd,
  useVoiceStore,
} from "./voice-store";

let seq = 0;
const push = (f: Omit<ServerFrame, "seq"> | Record<string, unknown>) =>
  h.frameCb?.({ seq: ++seq, ...f });
const drain = () => {
  h.playing = false;
  h.stateCb?.(false);
};
const sentTypes = () => h.sent.map((f) => (f as ClientFrame).type);
const phase = () => useVoiceStore.getState().phase;

const READY = {
  type: "ready",
  sessionId: "s",
  turnDetection: "server_vad",
  tts: {
    provider: "elevenlabs",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    model: "m",
    sampleRate: 24000,
  },
  stt: { provider: "elevenlabs", model: "scribe" },
};

async function startSession() {
  await useVoiceStore.getState().start("thread-1");
  push(READY);
}

beforeEach(() => {
  useVoiceStore.getState().end();
  Object.assign(h, {
    frameCb: null,
    closeCb: null,
    sent: [],
    audio: [],
    closed: false,
    captureStopped: false,
    playing: false,
    enqueued: [],
    flushed: 0,
    preflight: { ready: true },
  });
  seq = 0;
});

describe("formatVoiceLabel", () => {
  it("maps known voices and falls back to the id", () => {
    expect(formatVoiceLabel("elevenlabs", "EXAVITQu4vr4xnSDxMaL")).toBe(
      "ElevenLabs · Sarah",
    );
    expect(formatVoiceLabel("elevenlabs", "JBFqnCBsd6RMkjVDRZzb")).toBe(
      "ElevenLabs · George",
    );
    expect(formatVoiceLabel("elevenlabs", "xyz")).toBe("ElevenLabs · xyz");
  });
});

describe("voice store phase machine", () => {
  it("connects, sends start, and reaches listening on ready", async () => {
    const p = useVoiceStore.getState().start("t");
    expect(phase()).toBe("connecting");
    await p;
    expect(h.sent[0]).toMatchObject({ type: "start", threadId: "t" });
    push(READY);
    const s = useVoiceStore.getState();
    expect(s.phase).toBe("listening");
    expect(s.active).toBe(true);
    expect(s.voiceLabel).toBe("ElevenLabs · Sarah");
  });

  it("does not connect when preflight is not ready", async () => {
    h.preflight = { ready: false, message: "No STT key" };
    await useVoiceStore.getState().start(null);
    expect(phase()).toBe("error");
    expect(useVoiceStore.getState().error).toBe("No STT key");
    expect(h.frameCb).toBeNull();
  });

  it("walks listening -> hearing -> transcribing -> thinking and emits utterance", async () => {
    await startSession();
    const heard: string[] = [];
    onVoiceUtterance((t) => heard.push(t));
    push({ type: "speech_started" });
    expect(phase()).toBe("hearing");
    push({ type: "utterance_end", reason: "silence" });
    expect(phase()).toBe("transcribing");
    push({ type: "stt_final", text: "hello there", durationMs: 900 });
    expect(phase()).toBe("thinking");
    expect(useVoiceStore.getState().userCaption).toBe("hello there");
    expect(heard).toEqual(["hello there"]);
    push({ type: "speech_started" });
    expect(useVoiceStore.getState().userCaption).toBe("");
  });

  it("ignores duplicate/out-of-order handling is client-level; discarded returns to listening", async () => {
    await startSession();
    push({ type: "speech_started" });
    push({ type: "utterance_discarded", reason: "short" });
    expect(phase()).toBe("listening");
  });

  it("speaks on first playback, returns to listening after tts_done and drain", async () => {
    await startSession();
    push({ type: "stt_final", text: "hi", durationMs: 1 });
    push({ type: "tts_segment", turnId: "m1", index: 0, text: "Hello." });
    expect(useVoiceStore.getState().assistantCaption).toBe("Hello.");
    push({
      type: "tts_audio",
      turnId: "m1",
      segment: 0,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAA=",
    });
    expect(phase()).toBe("speaking");
    expect(h.sent).toContainEqual({ type: "playback", active: true });
    push({ type: "tts_done", turnId: "m1" });
    expect(phase()).toBe("speaking");
    drain();
    expect(phase()).toBe("listening");
    expect(h.sent).toContainEqual({ type: "playback", active: false });
  });

  it("switches caption when the segment actually starts", async () => {
    await startSession();
    push({
      type: "tts_audio",
      turnId: "m1",
      segment: 0,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAA=",
    });
    push({ type: "tts_segment", turnId: "m1", index: 1, text: "Second." });
    expect(useVoiceStore.getState().assistantCaption).toBe("");
    h.segCb?.("m1:1");
    expect(useVoiceStore.getState().assistantCaption).toBe("Second.");
  });

  it("empty turn: tts_done with no audio returns thinking to listening", async () => {
    await startSession();
    push({ type: "stt_final", text: "hi", durationMs: 1 });
    push({ type: "tts_done", turnId: "m1" });
    expect(phase()).toBe("listening");
  });

  it("barge-in cancels: flushes, notifies listeners, goes to hearing; stale audio dropped", async () => {
    await startSession();
    const cancelled: Array<string | null> = [];
    onVoiceTurnCancelled((id) => cancelled.push(id));
    push({
      type: "tts_audio",
      turnId: "m1",
      segment: 0,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAA=",
    });
    push({ type: "turn_cancelled", turnId: "m1", reason: "barge_in" });
    expect(cancelled).toEqual(["m1"]);
    expect(h.flushed).toBe(1);
    expect(phase()).toBe("hearing");
    const n = h.enqueued.length;
    push({
      type: "tts_audio",
      turnId: "m1",
      segment: 1,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAA=",
    });
    expect(h.enqueued.length).toBe(n);
  });

  it("interrupt flushes, sends frame, notifies and returns to listening", async () => {
    await startSession();
    const cancelled: Array<string | null> = [];
    onVoiceTurnCancelled((id) => cancelled.push(id));
    speakDelta("m1", "Hello");
    push({
      type: "tts_audio",
      turnId: "m1",
      segment: 0,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAA=",
    });
    useVoiceStore.getState().interrupt();
    expect(sentTypes()).toContain("interrupt");
    expect(cancelled).toEqual(["m1"]);
    expect(phase()).toBe("listening");
  });

  it("non-recoverable error -> error phase and stops capture; recoverable keeps phase", async () => {
    await startSession();
    push({
      type: "error",
      code: "stt_failed",
      message: "blip",
      recoverable: true,
    });
    expect(phase()).toBe("listening");
    expect(useVoiceStore.getState().error).toBe("blip");
    push({
      type: "error",
      code: "internal",
      message: "dead",
      recoverable: false,
    });
    expect(phase()).toBe("error");
    expect(h.captureStopped).toBe(true);
  });

  it("unexpected close -> Voice connection lost", async () => {
    await startSession();
    h.closeCb?.({});
    expect(phase()).toBe("error");
    expect(useVoiceStore.getState().error).toBe("Voice connection lost");
  });

  it("mute sends frame and stops audio; unmuted forwards audio", async () => {
    await startSession();
    const buf = new ArrayBuffer(8);
    h.onFrameCapture?.(buf);
    expect(h.audio.length).toBe(1);
    useVoiceStore.getState().toggleMuted();
    expect(h.sent).toContainEqual({ type: "mute", muted: true });
    h.onFrameCapture?.(buf);
    expect(h.audio.length).toBe(1);
    expect(getVoiceInputLevel()).toBe(0);
    useVoiceStore.getState().toggleMuted();
    expect(getVoiceInputLevel()).toBe(0.3);
  });

  it("does not send audio before ready", async () => {
    await useVoiceStore.getState().start(null);
    h.onFrameCapture?.(new ArrayBuffer(8));
    expect(h.audio.length).toBe(0);
  });

  it("output mute is forwarded to the player", async () => {
    await startSession();
    useVoiceStore.getState().toggleOutputMuted();
    expect(h.muted).toBe(true);
    expect(getVoiceOutputLevel()).toBe(0.5);
  });

  it("speakDelta/speakEnd/ptt frames and markThinking", async () => {
    await startSession();
    speakDelta("m1", "Hi");
    speakEnd("m1");
    useVoiceStore.getState().pttRelease();
    expect(h.sent.slice(1)).toEqual([
      { type: "speak_delta", turnId: "m1", text: "Hi" },
      { type: "speak_end", turnId: "m1" },
      { type: "ptt_release" },
    ]);
    markThinking();
    expect(phase()).toBe("thinking");
  });

  it("end() sends end, closes, stops capture and resets", async () => {
    await startSession();
    useVoiceStore.getState().end();
    expect(sentTypes()).toContain("end");
    expect(h.closed).toBe(true);
    expect(h.captureStopped).toBe(true);
    const s = useVoiceStore.getState();
    expect(s.active).toBe(false);
    expect(s.phase).toBe("idle");
  });
});
