"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  createAmplitudeHistory,
  createAmplitudeSmoother,
} from "@/lib/ai/speech/live-voice-motion";
import { cn } from "@/lib/utils";

/**
 * Ink constants for the live voice surfaces (stage, bar, and pill).
 * User speech lifts a pale listening ribbon, assistant answers with a contrasting darker tone.
 */
export const BAND_VOICE = {
  listening: { color: "#FFFFFF", peakOpacity: 0.45, opacityKnee: 3 },
  responding: { color: "#000000", peakOpacity: 0.45, opacityKnee: 1.3 },
} as const;

export type VoiceWavePalette = "aurora" | "accent" | "tone";
export type VoiceWavePlacement = "bottom" | "top" | "center" | "inline";
export type VoiceWaveStyle = "fill" | "line";

export interface VoiceMeshTuning {
  lines: number;
  samples: number;
  spread: number;
  displace: number;
  depthPhase: number;
  cyclesA: number;
  cyclesB: number;
  driftSpeed: number;
  driftRatioB: number;
  swirl: number;
  wander: number;
  wanderHzA: number;
  wanderHzB: number;
  alphaFar: number;
  alphaNear: number;
  idleEnvelope: number;
  opacityKnee: number;
  historySize: number;
  historyPeriodMs: number;
}

export const DEFAULT_MESH_TUNING: VoiceMeshTuning = {
  lines: 84,
  samples: 96,
  spread: 0.08,
  displace: 0.42,
  depthPhase: Math.PI * 1.7,
  cyclesA: 1.6,
  cyclesB: 2.7,
  driftSpeed: 0.9,
  driftRatioB: 0.55,
  swirl: 5.5,
  wander: 0.9,
  wanderHzA: 0.037,
  wanderHzB: 0.023,
  alphaFar: 0.08,
  alphaNear: 0.42,
  idleEnvelope: 0,
  opacityKnee: 3,
  historySize: 96,
  historyPeriodMs: 34,
};

export const MESH_INLINE_TUNING: Partial<VoiceMeshTuning> = {
  lines: 24,
  spread: 0.18,
  displace: 0.6,
  alphaFar: 0.16,
  alphaNear: 0.62,
};

export function meshDisplacement(
  u: number,
  depth: number,
  timeSec: number,
  swirl: number,
  config: VoiceMeshTuning,
): number {
  const phase = timeSec * config.driftSpeed + depth * config.depthPhase;
  const wanderA =
    config.wander * Math.sin(timeSec * config.wanderHzA * Math.PI * 2);
  const wanderB =
    config.wander * Math.sin(timeSec * config.wanderHzB * Math.PI * 2 + 1.9);

  return (
    0.6 * Math.sin(u * Math.PI * 2 * config.cyclesA + phase + swirl + wanderA) +
    0.4 *
      Math.sin(
        u * Math.PI * 2 * config.cyclesB +
          phase * config.driftRatioB +
          swirl * 1.6 +
          wanderB,
      )
  );
}

const AURORA_HEX = "#22D3EE";

function toRgb(
  color: string,
  fallback: [number, number, number],
): [number, number, number] {
  const value = color.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return fallback;
}

function resolveStroke(
  node: HTMLElement,
  palette: VoiceWavePalette,
  color?: string,
): [number, number, number] {
  if (color) {
    return toRgb(color, [255, 255, 255]);
  }
  const styles = getComputedStyle(node);
  if (palette === "aurora") {
    return toRgb(AURORA_HEX, [34, 211, 238]);
  }
  const token =
    palette === "accent"
      ? styles.getPropertyValue("--room-accent") || styles.getPropertyValue("--primary")
      : styles.getPropertyValue("--room-fg") || styles.getPropertyValue("--foreground");
  return toRgb(token, palette === "accent" ? [99, 102, 241] : [255, 255, 255]);
}

function compositeFor(stroke: [number, number, number]): GlobalCompositeOperation {
  const [r, g, b] = stroke;
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma >= 0.5 ? "lighter" : "source-over";
}

export function VoiceMeshWaves({
  getAmplitude,
  palette = "tone",
  placement = "bottom",
  color,
  peakOpacity = 1,
  tuning,
  className,
}: {
  getAmplitude: () => number;
  palette?: VoiceWavePalette;
  placement?: VoiceWavePlacement;
  color?: string;
  peakOpacity?: number;
  tuning?: Partial<VoiceMeshTuning>;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);

  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  const tuningKey = JSON.stringify(tuning ?? {});
  const config = useMemo<VoiceMeshTuning>(
    () => ({
      ...DEFAULT_MESH_TUNING,
      ...(JSON.parse(tuningKey) as Partial<VoiceMeshTuning>),
    }),
    [tuningKey],
  );

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let stroke = resolveStroke(host, palette, color);
    let composite = compositeFor(stroke);

    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stroke = resolveStroke(host, palette, color);
      composite = compositeFor(stroke);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const smoother = createAmplitudeSmoother({ attackMs: 80, releaseMs: 350 });
    const history = createAmplitudeHistory({
      size: config.historySize,
      periodMs: config.historyPeriodMs,
    });
    const envelope = new Float32Array(config.historySize);
    const warp = new Float32Array(config.historySize);

    const draw = (timeSec: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = composite;
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";

      const centerY = height / 2;
      const spreadPx = height * config.spread;
      const displacePx = height * config.displace;
      const alphaSpan = config.alphaNear - config.alphaFar;
      const lastSample = config.historySize - 1;

      let running = 0;
      for (let i = 0; i < config.historySize; i++) {
        running += envelope[i];
        warp[i] = (running / config.historySize) * config.swirl;
      }
      const [r, g, b] = stroke;

      for (let line = 0; line < config.lines; line++) {
        const depth = config.lines > 1 ? line / (config.lines - 1) : 0.5;
        const baseY = centerY + (depth - 0.5) * spreadPx;
        const alpha = Math.min(
          1,
          Math.max(
            0,
            (config.alphaFar + depth * alphaSpan) * peakOpacity,
          ),
        );
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        ctx.beginPath();

        for (let i = 0; i < config.samples; i++) {
          const u = i / (config.samples - 1);
          const x = u * width;
          const sample = Math.min(lastSample, Math.round(u * lastSample));
          const amp = envelope[sample];
          const gain = config.idleEnvelope + amp * (1 - config.idleEnvelope);
          const wave = meshDisplacement(u, depth, timeSec, warp[sample], config);
          const y = baseY - gain * displacePx * wave;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    };

    if (reduce) {
      history.read(envelope, 3);
      draw(0);
      return () => observer.disconnect();
    }

    let raf = 0;
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      const target = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const amp = smoother.step(target, dt);

      history.push(amp, dt);
      history.read(envelope, 3);
      draw(now / 1000);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [palette, color, config, peakOpacity]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 w-full overflow-hidden",
        placement === "bottom" && "bottom-0 h-40",
        placement === "top" && "top-0 h-40",
        placement === "center" && "inset-y-0 my-auto h-52",
        placement === "inline" && "inset-0 h-full",
        className,
      )}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reactive Catmull-Rom Spline Waves
// ---------------------------------------------------------------------------

const VIEW_W = 1200;
const VIEW_H = 200;
const HISTORY = 64;

interface ReactiveWaveLayer {
  modifier: "back" | "mid" | "front";
  periodMs: number;
  gain: number;
  smooth: number;
  sway: number;
  swayHz: number;
  swayPhase: number;
  opacity: number;
}

const WAVE_LAYERS: ReactiveWaveLayer[] = [
  {
    modifier: "back",
    periodMs: 62,
    gain: 0.42,
    smooth: 5,
    sway: 0.05,
    swayHz: 0.05,
    swayPhase: 0,
    opacity: 0.35,
  },
  {
    modifier: "mid",
    periodMs: 40,
    gain: 0.54,
    smooth: 3,
    sway: 0.038,
    swayHz: 0.08,
    swayPhase: 1.1,
    opacity: 0.55,
  },
  {
    modifier: "front",
    periodMs: 24,
    gain: 0.36,
    smooth: 2,
    sway: 0.028,
    swayHz: 0.13,
    swayPhase: 2.3,
    opacity: 0.8,
  },
];

const WAVE_LAYERS_INLINE: ReactiveWaveLayer[] = WAVE_LAYERS.map((layer) => ({
  ...layer,
  gain: layer.gain * 1.6,
  sway: layer.sway * 1.5,
}));

function toViewBoxY(
  layer: ReactiveWaveLayer,
  timeSec: number,
  out: Float32Array,
): void {
  for (let i = 0; i < HISTORY; i++) {
    const sway =
      layer.sway *
      (0.5 +
        0.5 *
          Math.sin(
            timeSec * layer.swayHz * 2 * Math.PI +
              layer.swayPhase +
              (i / HISTORY) * Math.PI * 2,
          ));
    out[i] = VIEW_H - (out[i] * layer.gain + sway) * VIEW_H;
  }
}

function buildPath(ys: Float32Array, style: VoiceWaveStyle): string {
  const step = VIEW_W / (HISTORY - 1);
  const x = (i: number) => i * step;
  const y = (i: number) => ys[Math.min(HISTORY - 1, Math.max(0, i))];

  let d = `M0,${y(0).toFixed(1)}`;
  for (let i = 0; i < HISTORY - 1; i++) {
    const y0 = y(i - 1);
    const y1 = y(i);
    const y2 = y(i + 1);
    const y3 = y(i + 2);
    const c1x = x(i) + step / 3;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x(i + 1) - step / 3;
    const c2y = y2 - (y3 - y1) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x(i + 1).toFixed(1)},${y2.toFixed(1)}`;
  }
  if (style === "fill") {
    d += `L${VIEW_W},${VIEW_H}L0,${VIEW_H}Z`;
  }
  return d;
}

export function VoiceReactiveWaves({
  getAmplitude,
  waveStyle = "fill",
  palette = "tone",
  placement = "bottom",
  color,
  peakOpacity = 1,
  className,
}: {
  getAmplitude: () => number;
  waveStyle?: VoiceWaveStyle;
  palette?: VoiceWavePalette;
  placement?: VoiceWavePlacement;
  color?: string;
  peakOpacity?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);

  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  const inline = placement === "inline";
  const layers = inline ? WAVE_LAYERS_INLINE : WAVE_LAYERS;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const paths = Array.from(
      node.querySelectorAll<SVGPathElement>("path[data-reactive-wave]"),
    );
    if (paths.length === 0) return;

    const smoother = createAmplitudeSmoother({ attackMs: 80, releaseMs: 350 });
    const histories = layers.map((layer) =>
      createAmplitudeHistory({ size: HISTORY, periodMs: layer.periodMs }),
    );
    const scratch = new Float32Array(HISTORY);

    let raf = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      const target = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const amp = smoother.step(target, dt);

      for (let i = 0; i < layers.length; i++) {
        const hist = histories[i];
        hist.push(amp, dt);
        hist.read(scratch, layers[i].smooth);
        toViewBoxY(layers[i], now / 1000, scratch);
        const path = paths[i];
        if (path) {
          path.setAttribute("d", buildPath(scratch, waveStyle));
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layers, waveStyle]);

  const strokeColor = color ?? (palette === "aurora" ? AURORA_HEX : "currentColor");

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 w-full overflow-hidden",
        placement === "bottom" && "bottom-0 h-40",
        placement === "top" && "top-0 h-40",
        placement === "center" && "inset-y-0 my-auto h-52",
        placement === "inline" && "inset-0 h-full",
        className,
      )}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="block h-full w-full"
      >
        {layers.map((layer) => (
          <path
            key={layer.modifier}
            data-reactive-wave={layer.modifier}
            fill={waveStyle === "fill" ? strokeColor : "none"}
            stroke={waveStyle === "line" ? strokeColor : "none"}
            strokeWidth={waveStyle === "line" ? 2 : undefined}
            opacity={layer.opacity * peakOpacity}
          />
        ))}
      </svg>
    </div>
  );
}
