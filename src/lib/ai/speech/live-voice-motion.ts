/**
 * Motion + expression primitives for the Vellum-style live voice stage.
 *
 * This module is deliberately dependency-free (no React, no animation runtime)
 * so the expressive character surface, the amplitude visualisers, and the unit
 * tests can all share one source of truth. Ported from Vellum's
 * `voice-motion.ts`, `voice-amplitude-history.ts`, and `voice-avatar-state.ts`.
 */

/** Room entry spring: the avatar rises from a smaller, lower offset to center. */
export const AVATAR_ENTER_SPRING = {
  type: "spring" as const,
  stiffness: 200,
  damping: 18,
};

/**
 * Frame-rate-independent asymmetric exponential smoother for amplitude-driven
 * visuals (a VU-meter-style ballistic: fast attack, slower release).
 *
 * Speech RMS swings hard at millisecond scale, so writing it raw into a large
 * transform reads as chop. This smooths at the visual consumer instead of the
 * source, letting capture / barge-in thresholds keep the responsive signal.
 *
 * `step(target, dtMs)` advances toward `target` with time constants `attackMs`
 * (rising) / `releaseMs` (falling): time-based `1 - exp(-dt/τ)` blending, so
 * the feel is identical at 60 Hz, 120 Hz, or across dropped frames.
 */
export function createAmplitudeSmoother({
  attackMs,
  releaseMs,
}: {
  attackMs: number;
  releaseMs: number;
}): { step: (target: number, dtMs: number) => number } {
  let value = 0;
  return {
    step(target: number, dtMs: number): number {
      const tau = target > value ? attackMs : releaseMs;
      if (!(tau > 0)) {
        value = target;
        return value;
      }
      const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
      value += (target - value) * k;
      return value;
    },
  };
}

/** A fixed-size, time-paced ring buffer of amplitude samples. */
export interface AmplitudeHistory {
  /** Number of samples retained — the horizontal resolution of the terrain. */
  readonly size: number;
  /**
   * Advance by `dtMs`, appending `amp` once per elapsed sample period.
   *
   * A long frame gap (a backgrounded tab, a dropped frame) can span several
   * periods; appending all of them keeps the scroll honest to wall-clock time.
   * The catch-up is capped at one full buffer — past that the whole window is
   * the same value anyway.
   */
  push(amp: number, dtMs: number): void;
  /**
   * Read oldest-first into `out`, applying a centred moving average of width
   * `smooth` samples (1 = raw). `out` must be at least {@link size} long.
   */
  read(out: Float32Array, smooth?: number): void;
}

export function createAmplitudeHistory({
  size,
  periodMs,
}: {
  size: number;
  /** Milliseconds per sample — sets both scroll speed and window length. */
  periodMs: number;
}): AmplitudeHistory {
  const safeSize = Math.max(1, Math.floor(size));
  const safePeriod = Math.max(1, periodMs);
  const samples = new Float32Array(safeSize);
  // Index of the oldest sample, i.e. the left edge of the rendered terrain.
  let head = 0;
  let elapsed = 0;

  return {
    size: safeSize,

    push(amp: number, dtMs: number): void {
      elapsed += Math.max(0, dtMs);
      let pushes = Math.floor(elapsed / safePeriod);
      if (pushes <= 0) {
        return;
      }
      elapsed -= pushes * safePeriod;
      pushes = Math.min(pushes, safeSize);
      for (let i = 0; i < pushes; i++) {
        samples[head] = amp;
        head = (head + 1) % safeSize;
      }
    },

    read(out: Float32Array, smooth = 1): void {
      const half = Math.max(0, Math.floor(smooth / 2));
      for (let i = 0; i < safeSize; i++) {
        if (half === 0) {
          out[i] = samples[(head + i) % safeSize];
          continue;
        }
        let sum = 0;
        let count = 0;
        for (let k = -half; k <= half; k++) {
          const j = i + k;
          if (j < 0 || j >= safeSize) {
            continue;
          }
          sum += samples[(head + j) % safeSize];
          count++;
        }
        out[i] = count > 0 ? sum / count : 0;
      }
    },
  };
}

/** High-level session phase tracked by the live voice store. */
export type LiveVoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/**
 * Visual mode the expressive character renders, distilled from the richer
 * live-voice session phase. Several phases collapse to one visual
 * (`transcribing` and `thinking` both read as `"thinking"`), and `connecting`
 * promotes to `"reconnecting"`.
 */
export type VoiceAvatarVisual =
  | "idle"
  | "listening"
  | "thinking"
  | "responding"
  | "reconnecting";

/** Facial mood the avatar expression layer uses for eye / brow styling. */
export type VoiceExpressionMood =
  | "attentive"
  | "curious"
  | "speaking"
  | "happy"
  | "calm"
  | "focused";

/**
 * Pure mapping from a live-voice session phase (plus assistant audio activity
 * and the mic mute state) to the avatar's visual mode.
 */
export function toVoiceAvatarVisual(
  phase: LiveVoicePhase,
  assistantAudioActive: boolean,
  muted: boolean,
): VoiceAvatarVisual {
  if (assistantAudioActive || phase === "speaking") {
    return "responding";
  }
  if (phase === "thinking" || phase === "transcribing") {
    return "thinking";
  }
  if (phase === "listening" && !muted) {
    return "listening";
  }
  if (phase === "connecting") {
    return "reconnecting";
  }
  return "idle";
}

/**
 * Pure mapping from the avatar visual (plus mute state and current amplitude)
 * to the expression mood. Amplitude is the smoothed 0..1 mic/output level.
 */
export function toVoiceExpressionMood(
  visual: VoiceAvatarVisual,
  // Retained for API parity with the session phase: a muted mic already
  // collapses to the `idle` visual, so it never reaches the listening branch.
  _muted: boolean,
  amplitude: number,
): VoiceExpressionMood {
  switch (visual) {
    case "listening":
      return amplitude > 0.35 ? "curious" : "attentive";
    case "thinking":
      return "focused";
    case "responding":
      return amplitude > 0.4 ? "happy" : "speaking";
    case "idle":
    case "reconnecting":
      return "calm";
  }
}

/** Human-readable status line for the compact pill / stage caption. */
export function liveVoicePhaseLabel(
  phase: LiveVoicePhase,
  muted: boolean,
  assistantAudioActive: boolean,
): string {
  if (muted && phase !== "idle") {
    return "Mic muted";
  }
  if (assistantAudioActive || phase === "speaking") {
    return "Speaking…";
  }
  switch (phase) {
    case "transcribing":
      return "Transcribing…";
    case "thinking":
      return "Thinking…";
    case "listening":
      return "Listening…";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Voice error";
    default:
      return "Ready";
  }
}
