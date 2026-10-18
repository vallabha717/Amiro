import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_ENTER_SPRING,
  createAmplitudeHistory,
  createAmplitudeSmoother,
  liveVoicePhaseLabel,
  toVoiceAvatarVisual,
  toVoiceExpressionMood,
} from "./live-voice-motion";
import {
  LIVE_VOICE_UTTERANCE_EVENT,
  _resetLiveVoiceForTesting,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  registerVoiceUtteranceHandler,
  setLiveVoiceInputAmplitude,
  setLiveVoiceOutputAmplitude,
  useLiveVoiceStore,
} from "./live-voice-store";

function expectApprox(actual: Float32Array, expected: number[], digits = 5) {
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, digits);
  });
}

function resetStoreState() {
  useLiveVoiceStore.setState({
    active: false,
    minimized: false,
    phase: "idle",
    muted: false,
    outputMuted: false,
    assistantAudioActive: false,
    partialTranscript: "",
    finalTranscript: "",
    assistantTranscript: "",
    error: null,
    threadId: null,
    eyeStyleOverride: null,
    waveEngine: "mesh",
    showCaptions: true,
  });
}

describe("live-voice-motion", () => {
  it("exposes the shared avatar entry spring", () => {
    expect(AVATAR_ENTER_SPRING).toEqual({
      type: "spring",
      stiffness: 200,
      damping: 18,
    });
  });

  describe("createAmplitudeSmoother", () => {
    it("uses time-based attack ballistics independent of frame rate", () => {
      const smoother = createAmplitudeSmoother({
        attackMs: 100,
        releaseMs: 200,
      });

      expect(smoother.step(1, 0)).toBe(0);
      // One attack time constant reaches 1 - e^-1.
      expect(smoother.step(1, 100)).toBeCloseTo(1 - Math.exp(-1), 5);
      // Two time constants: 1 - e^-2.
      expect(smoother.step(1, 100)).toBeCloseTo(1 - Math.exp(-2), 5);
    });

    it("is frame-rate independent: one 100ms step equals ten 10ms steps", () => {
      const coarse = createAmplitudeSmoother({ attackMs: 120, releaseMs: 300 });
      const fine = createAmplitudeSmoother({ attackMs: 120, releaseMs: 300 });

      const coarseValue = coarse.step(0.8, 100);
      let fineValue = 0;
      for (let i = 0; i < 10; i++) {
        fineValue = fine.step(0.8, 10);
      }

      expect(fineValue).toBeCloseTo(coarseValue, 6);
    });

    it("releases slower than it attacks", () => {
      const fastAttack = createAmplitudeSmoother({
        attackMs: 80,
        releaseMs: 800,
      });
      fastAttack.step(1, 80);
      const attackLevel = fastAttack.step(1, 0);

      const fresh = createAmplitudeSmoother({ attackMs: 80, releaseMs: 800 });
      fresh.step(1, 800);
      const releasedLevel = fresh.step(0, 80);

      expect(attackLevel).toBeGreaterThan(0.5);
      expect(releasedLevel).toBeGreaterThan(0.9);
    });

    it("decays toward zero on release without crossing below zero", () => {
      const smoother = createAmplitudeSmoother({
        attackMs: 10,
        releaseMs: 200,
      });
      smoother.step(1, 1000);
      const released = smoother.step(0, 200);
      expect(released).toBeCloseTo(Math.exp(-1), 3);
      expect(released).toBeGreaterThan(0);
    });

    it("ignores negative dt and snaps when the time constant is zero", () => {
      const smoother = createAmplitudeSmoother({
        attackMs: 100,
        releaseMs: 100,
      });
      expect(smoother.step(0.5, -50)).toBe(0);

      const instant = createAmplitudeSmoother({ attackMs: 0, releaseMs: 0 });
      expect(instant.step(0.42, 16)).toBe(0.42);
      expect(instant.step(0, 16)).toBe(0);
    });
  });

  describe("createAmplitudeHistory", () => {
    it("exposes its size and only advances on whole sample periods", () => {
      const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
      expect(history.size).toBe(4);

      history.push(0.5, 4);
      const out = new Float32Array(4);
      history.read(out);
      expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    });

    it("reads oldest-first once the ring is full", () => {
      const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
      history.push(0.2, 10);
      history.push(0.4, 10);
      history.push(0.6, 10);
      history.push(0.8, 10);

      const out = new Float32Array(4);
      history.read(out);
      expectApprox(out, [0.2, 0.4, 0.6, 0.8]);

      history.push(1.0, 10);
      history.read(out);
      expectApprox(out, [0.4, 0.6, 0.8, 1.0]);
    });

    it("catches up multiple periods but caps the catch-up at one buffer", () => {
      const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
      // 1000ms / 10ms = 100 periods, capped at size (4): whole buffer = 0.3.
      history.push(0.3, 1000);

      const out = new Float32Array(4);
      history.read(out);
      expectApprox(out, [0.3, 0.3, 0.3, 0.3]);
    });

    it("applies a centred moving average when smoothing is requested", () => {
      const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
      history.push(0.2, 10);
      history.push(0.4, 10);
      history.push(0.6, 10);
      history.push(0.8, 10);

      const raw = new Float32Array(4);
      history.read(raw, 1);
      expectApprox(raw, [0.2, 0.4, 0.6, 0.8]);

      const smoothed = new Float32Array(4);
      history.read(smoothed, 3);
      expect(smoothed[0]).toBeCloseTo((0.2 + 0.4) / 2, 6);
      expect(smoothed[1]).toBeCloseTo((0.2 + 0.4 + 0.6) / 3, 6);
      expect(smoothed[3]).toBeCloseTo((0.6 + 0.8) / 2, 6);
    });
  });

  describe("toVoiceAvatarVisual", () => {
    it("promotes speaking / active assistant audio to responding", () => {
      expect(toVoiceAvatarVisual("speaking", false, false)).toBe("responding");
      expect(toVoiceAvatarVisual("listening", true, false)).toBe("responding");
    });

    it("maps transcribing and thinking to thinking", () => {
      expect(toVoiceAvatarVisual("transcribing", false, false)).toBe(
        "thinking",
      );
      expect(toVoiceAvatarVisual("thinking", false, false)).toBe("thinking");
    });

    it("maps listening only when not muted", () => {
      expect(toVoiceAvatarVisual("listening", false, false)).toBe("listening");
      expect(toVoiceAvatarVisual("listening", false, true)).toBe("idle");
    });

    it("maps connecting to reconnecting and everything else to idle", () => {
      expect(toVoiceAvatarVisual("connecting", false, false)).toBe(
        "reconnecting",
      );
      expect(toVoiceAvatarVisual("idle", false, false)).toBe("idle");
      expect(toVoiceAvatarVisual("error", false, false)).toBe("idle");
    });
  });

  describe("toVoiceExpressionMood", () => {
    it("picks curious vs attentive from listening amplitude", () => {
      expect(toVoiceExpressionMood("listening", false, 0.5)).toBe("curious");
      expect(toVoiceExpressionMood("listening", false, 0.1)).toBe("attentive");
      expect(toVoiceExpressionMood("listening", false, 0.35)).toBe("attentive");
    });

    it("maps the remaining visuals", () => {
      expect(toVoiceExpressionMood("thinking", false, 0)).toBe("focused");
      expect(toVoiceExpressionMood("responding", false, 0.9)).toBe("happy");
      expect(toVoiceExpressionMood("responding", false, 0.2)).toBe("speaking");
      expect(toVoiceExpressionMood("idle", false, 0)).toBe("calm");
      expect(toVoiceExpressionMood("reconnecting", false, 0)).toBe("calm");
    });
  });

  describe("liveVoicePhaseLabel", () => {
    it("prioritises mute, then speaking, then the phase", () => {
      expect(liveVoicePhaseLabel("listening", true, false)).toBe("Mic muted");
      expect(liveVoicePhaseLabel("idle", true, false)).toBe("Ready");
      expect(liveVoicePhaseLabel("listening", false, true)).toBe("Speaking…");
      expect(liveVoicePhaseLabel("speaking", false, false)).toBe("Speaking…");
    });

    it("labels each remaining phase", () => {
      expect(liveVoicePhaseLabel("transcribing", false, false)).toBe(
        "Transcribing…",
      );
      expect(liveVoicePhaseLabel("thinking", false, false)).toBe("Thinking…");
      expect(liveVoicePhaseLabel("listening", false, false)).toBe("Listening…");
      expect(liveVoicePhaseLabel("connecting", false, false)).toBe(
        "Connecting…",
      );
      expect(liveVoicePhaseLabel("error", false, false)).toBe("Voice error");
      expect(liveVoicePhaseLabel("idle", false, false)).toBe("Ready");
    });
  });
});

describe("useLiveVoiceStore", () => {
  beforeEach(() => {
    _resetLiveVoiceForTesting();
    resetStoreState();
    const dispatchEvent = vi.fn();
    (globalThis as any).CustomEvent = class MockCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
    (globalThis as any).window = { dispatchEvent };
  });

  afterEach(() => {
    _resetLiveVoiceForTesting();
  });

  it("starts an inactive session with the documented defaults", () => {
    const state = useLiveVoiceStore.getState();
    expect(state.active).toBe(false);
    expect(state.phase).toBe("idle");
    expect(state.muted).toBe(false);
    expect(state.outputMuted).toBe(false);
    expect(state.waveEngine).toBe("mesh");
    expect(state.showCaptions).toBe(true);
  });

  it("startSession activates, resets transcripts, and records the thread", () => {
    useLiveVoiceStore.getState().setUserTranscript("partial", "final");
    useLiveVoiceStore.getState().setAssistantTranscript("hello");
    useLiveVoiceStore.getState().setError("boom");

    useLiveVoiceStore.getState().startSession({ threadId: "thread-7" });

    const state = useLiveVoiceStore.getState();
    expect(state.active).toBe(true);
    expect(state.phase).toBe("connecting");
    expect(state.threadId).toBe("thread-7");
    expect(state.minimized).toBe(false);
    expect(state.partialTranscript).toBe("");
    expect(state.finalTranscript).toBe("");
    expect(state.assistantTranscript).toBe("");
    expect(state.error).toBeNull();
  });

  it("honours the minimized option on startSession", () => {
    useLiveVoiceStore.getState().startSession({ minimized: true });
    expect(useLiveVoiceStore.getState().minimized).toBe(true);
  });

  it("minimize / restore / toggle minimize the room", () => {
    const store = useLiveVoiceStore.getState();
    store.minimizeRoom();
    expect(useLiveVoiceStore.getState().minimized).toBe(true);
    store.restoreRoom();
    expect(useLiveVoiceStore.getState().minimized).toBe(false);
    store.toggleMinimize();
    expect(useLiveVoiceStore.getState().minimized).toBe(true);
  });

  it("toggles mic and output mute independently", () => {
    const store = useLiveVoiceStore.getState();
    store.toggleMuted();
    expect(useLiveVoiceStore.getState().muted).toBe(true);
    expect(useLiveVoiceStore.getState().outputMuted).toBe(false);

    store.toggleOutputMuted();
    expect(useLiveVoiceStore.getState().outputMuted).toBe(true);

    store.setMuted(false);
    store.setOutputMuted(false);
    expect(useLiveVoiceStore.getState().muted).toBe(false);
    expect(useLiveVoiceStore.getState().outputMuted).toBe(false);
  });

  it("updates transcripts, phase, error, wave engine, captions and eye style", () => {
    const store = useLiveVoiceStore.getState();

    store.setUserTranscript("interim words");
    expect(useLiveVoiceStore.getState().partialTranscript).toBe(
      "interim words",
    );
    expect(useLiveVoiceStore.getState().finalTranscript).toBe("");

    store.setUserTranscript("", "final words");
    let state = useLiveVoiceStore.getState();
    expect(state.partialTranscript).toBe("");
    expect(state.finalTranscript).toBe("final words");

    store.setAssistantTranscript("agent reply");
    store.setPhase("speaking");
    store.setAssistantAudioActive(true);
    state = useLiveVoiceStore.getState();
    expect(state.assistantTranscript).toBe("agent reply");
    expect(state.phase).toBe("speaking");
    expect(state.assistantAudioActive).toBe(true);

    store.setError("mic denied");
    expect(useLiveVoiceStore.getState().error).toBe("mic denied");
    store.setPhase("listening");
    expect(useLiveVoiceStore.getState().error).toBeNull();

    store.setWaveEngine("reactive");
    store.setShowCaptions(false);
    store.setEyeStyleOverride("sparkle");
    state = useLiveVoiceStore.getState();
    expect(state.waveEngine).toBe("reactive");
    expect(state.showCaptions).toBe(false);
    expect(state.eyeStyleOverride).toBe("sparkle");
  });

  it("prefers a registered handler for spoken utterances", () => {
    const handler = vi.fn();
    const unsubscribe = registerVoiceUtteranceHandler(handler);

    useLiveVoiceStore.getState().startSession({ threadId: "t-1" });
    useLiveVoiceStore.getState().submitVoiceUtterance("  hello there  ");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      text: "hello there",
      threadId: "t-1",
    });
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().finalTranscript).toBe("hello there");
    expect(useLiveVoiceStore.getState().phase).toBe("thinking");

    unsubscribe();
  });

  it("dispatches a window event when no handler is registered", () => {
    useLiveVoiceStore.getState().startSession({ threadId: "t-2" });
    useLiveVoiceStore.getState().submitVoiceUtterance("what is the weather");

    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
    const event = (window.dispatchEvent as any).mock.calls[0][0];
    expect(event.type).toBe(LIVE_VOICE_UTTERANCE_EVENT);
    expect(event.detail).toEqual({
      text: "what is the weather",
      threadId: "t-2",
    });
  });

  it("stops routing to an unsubscribed handler", () => {
    const handler = vi.fn();
    const unsubscribe = registerVoiceUtteranceHandler(handler);
    unsubscribe();

    useLiveVoiceStore.getState().submitVoiceUtterance("fallback path");
    expect(handler).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores blank utterances", () => {
    const handler = vi.fn();
    registerVoiceUtteranceHandler(handler);
    useLiveVoiceStore.getState().submitVoiceUtterance("   ");
    expect(handler).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().phase).toBe("idle");
  });

  it("endSession tears the session down and clears state", () => {
    const store = useLiveVoiceStore.getState();
    store.startSession({ threadId: "t-9" });
    store.setPhase("listening");
    store.toggleMuted();
    store.setAssistantTranscript("bye");

    store.endSession();

    const state = useLiveVoiceStore.getState();
    expect(state.active).toBe(false);
    expect(state.phase).toBe("idle");
    expect(state.muted).toBe(false);
    expect(state.assistantTranscript).toBe("");
    expect(state.threadId).toBe("t-9");
  });
});

describe("live voice amplitude channel", () => {
  beforeEach(() => {
    _resetLiveVoiceForTesting();
  });

  it("clamps amplitudes into 0..1 and ignores non-finite values", () => {
    setLiveVoiceInputAmplitude(1.7);
    expect(getLiveVoiceInputAmplitude()).toBe(1);
    setLiveVoiceInputAmplitude(-3);
    expect(getLiveVoiceInputAmplitude()).toBe(0);
    setLiveVoiceInputAmplitude(Number.NaN);
    expect(getLiveVoiceInputAmplitude()).toBe(0);
    setLiveVoiceInputAmplitude(0.42);
    expect(getLiveVoiceInputAmplitude()).toBeCloseTo(0.42, 6);

    setLiveVoiceOutputAmplitude(2);
    expect(getLiveVoiceOutputAmplitude()).toBe(1);
    setLiveVoiceOutputAmplitude(0.25);
    expect(getLiveVoiceOutputAmplitude()).toBeCloseTo(0.25, 6);
  });

  it("resets amplitude on startSession and endSession", () => {
    setLiveVoiceInputAmplitude(0.8);
    setLiveVoiceOutputAmplitude(0.6);

    useLiveVoiceStore.setState({ active: false, phase: "idle" });
    useLiveVoiceStore.getState().startSession();
    expect(getLiveVoiceInputAmplitude()).toBe(0);
    expect(getLiveVoiceOutputAmplitude()).toBe(0);

    setLiveVoiceInputAmplitude(0.5);
    useLiveVoiceStore.getState().endSession();
    expect(getLiveVoiceInputAmplitude()).toBe(0);
    expect(getLiveVoiceOutputAmplitude()).toBe(0);
  });
});
