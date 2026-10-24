/**
 * Streaming PCM microphone capture for live voice.
 *
 * getUserMedia -> AudioWorklet that downsamples to 16 kHz mono PCM16 LE and
 * posts 800-sample (50 ms) frames. The worklet source is an inline string
 * loaded through a Blob URL: the app is a static export, so there is no
 * separate public file to serve.
 */

import {
  LIVE_VOICE_FRAME_SAMPLES,
  LIVE_VOICE_INPUT_SAMPLE_RATE,
} from "./protocol";

const PROCESSOR_NAME = "amiro-pcm-downsample";

/** Matches Vellum's amplitude meter: EMA alpha 0.5, scaled by 14, clamped. */
export const LEVEL_SMOOTHING = 0.5;
export const LEVEL_SCALE = 14;

export const PCM_WORKLET_SOURCE = `
const TARGET_RATE = ${LIVE_VOICE_INPUT_SAMPLE_RATE};
const FRAME = ${LIVE_VOICE_FRAME_SAMPLES};
class AmiroPcmDownsample extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.readOffset = 0;
    this.batch = new Int16Array(FRAME);
    this.batchLen = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    let pos = this.readOffset;
    while (pos < ch.length) {
      const s = ch[Math.floor(pos)] || 0;
      const c = s < -1 ? -1 : s > 1 ? 1 : s;
      this.batch[this.batchLen++] = c < 0 ? c * 0x8000 : c * 0x7fff;
      if (this.batchLen === FRAME) {
        const out = this.batch.buffer;
        this.port.postMessage(out, [out]);
        this.batch = new Int16Array(FRAME);
        this.batchLen = 0;
      }
      pos += this.ratio;
    }
    this.readOffset = pos - ch.length;
    return true;
  }
}
registerProcessor("${PROCESSOR_NAME}", AmiroPcmDownsample);
`;

let inputLevel = 0;

/** Latest smoothed mic level in 0..1; safe to read from rAF loops. */
export function getPcmInputLevel(): number {
  return inputLevel;
}

/** RMS of a PCM16 frame mapped through the Vellum meter curve (unsmoothed). */
export function pcmFrameLevel(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length) * LEVEL_SCALE;
}

/** One EMA step, clamped to 0..1. */
export function smoothLevel(prev: number, raw: number): number {
  const next = prev * (1 - LEVEL_SMOOTHING) + raw * LEVEL_SMOOTHING;
  return Math.max(0, Math.min(1, next));
}

export interface PcmCaptureOptions {
  onFrame: (pcm: ArrayBuffer) => void;
  onLevel?: (level: number) => void;
}

export interface PcmCapture {
  stop(): void;
  context: AudioContext;
}

export async function startPcmCapture(
  opts: PcmCaptureOptions,
): Promise<PcmCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not available in this browser.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const stopTracks = () => {
    for (const t of stream.getTracks()) t.stop();
  };

  let context: AudioContext;
  let node: AudioWorkletNode;
  let source: MediaStreamAudioSourceNode;
  let blobUrl: string | null = null;
  try {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    context = new Ctor();
    blobUrl = URL.createObjectURL(
      new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }),
    );
    await context.audioWorklet.addModule(blobUrl);
    if (context.state === "suspended") await context.resume();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
  } catch (err) {
    stopTracks();
    throw err;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }

  inputLevel = 0;
  let stopped = false;
  node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    if (stopped) return;
    const buf = ev.data;
    inputLevel = smoothLevel(inputLevel, pcmFrameLevel(buf));
    opts.onLevel?.(inputLevel);
    opts.onFrame(buf);
  };
  source.connect(node);

  return {
    context,
    stop() {
      if (stopped) return;
      stopped = true;
      inputLevel = 0;
      try {
        source.disconnect();
        node.port.onmessage = null;
        node.disconnect();
      } catch {}
      stopTracks();
      void context.close().catch(() => {});
    },
  };
}
