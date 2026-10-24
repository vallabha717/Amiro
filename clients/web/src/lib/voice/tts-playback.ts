/**
 * Gapless PCM16 playback for streamed TTS chunks. Chunks are scheduled back to
 * back on a shared AudioContext via AudioBufferSourceNode.
 */

/** Decode base64 PCM16 little-endian into an Int16Array (odd trailing byte dropped). */
export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = Math.floor(bin.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    const v = (hi << 8) | lo;
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++)
    out[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

/** Output meter curve from the spec: 1 - exp(-rms * 40). */
export function outputLevelFromRms(rms: number): number {
  return Math.max(0, Math.min(1, 1 - Math.exp(-rms * 40)));
}

export interface PcmPlayer {
  /** Create/resume the AudioContext; call from a user gesture. */
  unlock(): void;
  /** `tag` identifies the segment so onSegmentStart can fire when it really starts. */
  enqueue(base64Pcm16: string, sampleRate: number, tag?: string): void;
  flush(): void;
  setMuted(muted: boolean): void;
  isPlaying(): boolean;
  onStateChange(cb: (playing: boolean) => void): () => void;
  /** Fired (approximately) when the first chunk of a tagged segment starts sounding. */
  onSegmentStart(cb: (tag: string) => void): () => void;
  /** 0..1 output level, sampled now. */
  level(): number;
  /** Stop everything and close the context. */
  close(): void;
}

export function createPcmPlayer(): PcmPlayer {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserBuf: Float32Array<ArrayBuffer> | null = null;
  let nextTime = 0;
  let muted = false;
  let playing = false;
  const sources = new Set<AudioBufferSourceNode>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const seenTags = new Set<string>();
  const stateCbs = new Set<(p: boolean) => void>();
  const segCbs = new Set<(tag: string) => void>();

  const setPlaying = (p: boolean) => {
    if (playing === p) return;
    playing = p;
    for (const cb of [...stateCbs]) cb(p);
  };

  const ensure = (): AudioContext => {
    if (ctx) return ctx;
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    ctx = new Ctor();
    gain = ctx.createGain();
    gain.gain.value = muted ? 0 : 1;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyserBuf = new Float32Array(analyser.fftSize);
    // Analyse pre-gain so levels stay meaningful; level() reports 0 when muted.
    gain.connect(ctx.destination);
    analyser.connect(gain);
    return ctx;
  };

  return {
    unlock() {
      const c = ensure();
      if (c.state === "suspended") void c.resume().catch(() => {});
    },
    enqueue(b64, sampleRate, tag) {
      const c = ensure();
      if (c.state === "suspended") void c.resume().catch(() => {});
      const samples = int16ToFloat32(base64ToInt16(b64));
      if (samples.length === 0 || !analyser) return;
      const buffer = c.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      const startAt = Math.max(nextTime, c.currentTime + 0.02);
      nextTime = startAt + buffer.duration;
      sources.add(src);
      src.onended = () => {
        sources.delete(src);
        if (sources.size === 0) setPlaying(false);
      };
      src.start(startAt);
      setPlaying(true);
      if (tag && !seenTags.has(tag)) {
        seenTags.add(tag);
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            for (const cb of [...segCbs]) cb(tag);
          },
          Math.max(0, (startAt - c.currentTime) * 1000),
        );
        timers.add(timer);
      }
    },
    flush() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      seenTags.clear();
      const old = [...sources];
      sources.clear();
      for (const s of old) {
        s.onended = null;
        try {
          s.stop();
        } catch {}
        try {
          s.disconnect();
        } catch {}
      }
      nextTime = 0;
      setPlaying(false);
    },
    setMuted(m) {
      muted = m;
      if (gain) gain.gain.value = m ? 0 : 1;
    },
    isPlaying: () => playing,
    onStateChange(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onSegmentStart(cb) {
      segCbs.add(cb);
      return () => segCbs.delete(cb);
    },
    level() {
      if (!analyser || !analyserBuf || !playing || muted) return 0;
      analyser.getFloatTimeDomainData(analyserBuf);
      let sum = 0;
      for (let i = 0; i < analyserBuf.length; i++)
        sum += analyserBuf[i] * analyserBuf[i];
      return outputLevelFromRms(Math.sqrt(sum / analyserBuf.length));
    },
    close() {
      this.flush();
      stateCbs.clear();
      segCbs.clear();
      const c = ctx;
      ctx = null;
      gain = null;
      analyser = null;
      if (c) void c.close().catch(() => {});
    },
  };
}
