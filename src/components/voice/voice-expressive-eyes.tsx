"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { motion, useAnimationControls, useReducedMotion } from "framer-motion";
import {
  type AvatarTone,
  type CharacterComponents,
  type CharacterTraits,
  type EyePathDefinition,
  type EyeStyleDefinition,
  bodyAccentDots,
  bodyLattice,
  eyeMarkColor,
} from "@/lib/agent/character-catalog";
import {
  type VoiceAvatarVisual,
  type VoiceExpressionMood,
  createAmplitudeSmoother,
} from "@/lib/ai/speech/live-voice-motion";
import { cn } from "@/lib/utils";

const CURSOR_MAX_X = 6;
const CURSOR_MAX_Y = 4;

const EYE_STATE_SCALE: Record<VoiceAvatarVisual, number> = {
  idle: 0.9,
  listening: 1.0,
  thinking: 0.68,
  responding: 0.85,
  reconnecting: 0.9,
};

export type VoiceEyeReaction = "listening" | "responding" | null;

const BALLISTICS: Record<
  NonNullable<VoiceEyeReaction>,
  { attackMs: number; releaseMs: number }
> = {
  listening: { attackMs: 70, releaseMs: 300 },
  responding: { attackMs: 110, releaseMs: 380 },
};

export function useReactiveEyes(
  reaction: VoiceEyeReaction,
  getAmplitude?: () => number,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);

  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (
      !reaction ||
      !getAmplitudeRef.current ||
      (typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      node.style.setProperty("--eye-amp", "0");
      return;
    }

    const smoother = createAmplitudeSmoother(BALLISTICS[reaction]);
    let raf = 0;
    let lastTime = performance.now();
    let lastWritten = "";

    const tick = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      const source = getAmplitudeRef.current;
      const target = source ? Math.min(1, Math.max(0, source())) : 0;
      const next = smoother.step(target, dt).toFixed(3);
      if (next !== lastWritten) {
        lastWritten = next;
        node.style.setProperty("--eye-amp", next);
        const ampNum = parseFloat(next);
        if (reaction === "listening") {
          node.style.transform = `scale(${1 + ampNum * 0.05}, ${1 + ampNum * 0.14}) translateY(${-ampNum * 3}px)`;
        } else if (reaction === "responding") {
          node.style.transform = `scale(${1 + ampNum * 0.08}) translateY(${Math.sin(now / 120) * ampNum * 2}px)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      node.style.setProperty("--eye-amp", "0");
      node.style.transform = "none";
    };
  }, [reaction]);

  return ref;
}

export function VoiceThinkingIndicator({ tone }: { tone: AvatarTone }) {
  const reduce = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none mt-3 flex items-center justify-center gap-1.5"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-2 w-2 rounded-full"
          style={{ backgroundColor: tone.fg }}
          initial={reduce ? false : { opacity: 0.3, scale: 0.75 }}
          animate={
            reduce
              ? { opacity: 0.7 }
              : { opacity: [0.3, 1, 0.3], scale: [0.75, 1.15, 0.75] }
          }
          transition={
            reduce
              ? { duration: 0 }
              : {
                  duration: 1.1,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.18,
                }
          }
        />
      ))}
    </div>
  );
}

// Canonical eye positions in 1000x1000 space
const LEFT_CX = 340;
const RIGHT_CX = 660;
const EYE_CY = 500;

function buildExpressionMarks(
  mood: VoiceExpressionMood | string,
  baseEyeStyle: EyeStyleDefinition | undefined,
): EyePathDefinition[] {
  switch (mood) {
    case "happy":
      // Smiling crescent curves (^_^)
      return [
        {
          svgPath: `M${LEFT_CX - 50},${EYE_CY + 15} Q${LEFT_CX},${EYE_CY - 40} ${LEFT_CX + 50},${EYE_CY + 15}`,
          color: "fg",
          strokeWidth: 26,
        },
        {
          svgPath: `M${RIGHT_CX - 50},${EYE_CY + 15} Q${RIGHT_CX},${EYE_CY - 40} ${RIGHT_CX + 50},${EYE_CY + 15}`,
          color: "fg",
          strokeWidth: 26,
        },
      ];
    case "wink":
      // Left eye open curious, right eye winking curve
      return [
        {
          svgPath: `M${LEFT_CX},${EYE_CY} m-46,0 a46,46 0 1,0 92,0 a46,46 0 1,0 -92,0`,
          color: "fg",
        },
        {
          svgPath: `M${LEFT_CX + 14},${EYE_CY - 14} m-16,0 a16,16 0 1,0 32,0 a16,16 0 1,0 -32,0`,
          color: "bg",
        },
        {
          svgPath: `M${RIGHT_CX - 45},${EYE_CY + 10} Q${RIGHT_CX},${EYE_CY - 30} ${RIGHT_CX + 45},${EYE_CY + 10}`,
          color: "fg",
          strokeWidth: 24,
        },
      ];
    case "sparkle":
      // Starry sparkling eyes
      return [
        {
          svgPath: `M${LEFT_CX},${EYE_CY - 48} Q${LEFT_CX},${EYE_CY} ${LEFT_CX + 48},${EYE_CY} Q${LEFT_CX},${EYE_CY} ${LEFT_CX},${EYE_CY + 48} Q${LEFT_CX},${EYE_CY} ${LEFT_CX - 48},${EYE_CY} Q${LEFT_CX},${EYE_CY} ${LEFT_CX},${EYE_CY - 48} Z`,
          color: "fg",
        },
        {
          svgPath: `M${RIGHT_CX},${EYE_CY - 48} Q${RIGHT_CX},${EYE_CY} ${RIGHT_CX + 48},${EYE_CY} Q${RIGHT_CX},${EYE_CY} ${RIGHT_CX},${EYE_CY + 48} Q${RIGHT_CX},${EYE_CY} ${RIGHT_CX - 48},${EYE_CY} Q${RIGHT_CX},${EYE_CY} ${RIGHT_CX},${EYE_CY - 48} Z`,
          color: "fg",
        },
      ];
    case "focused":
      // Focused horizontal bars
      return [
        {
          svgPath: `M${LEFT_CX - 50},${EYE_CY} L${LEFT_CX + 50},${EYE_CY}`,
          color: "fg",
          strokeWidth: 28,
        },
        {
          svgPath: `M${RIGHT_CX - 50},${EYE_CY} L${RIGHT_CX + 50},${EYE_CY}`,
          color: "fg",
          strokeWidth: 28,
        },
      ];
    case "curious":
      // Large round attentive eyes with offset shine
      return [
        {
          svgPath: `M${LEFT_CX},${EYE_CY} m-52,0 a52,52 0 1,0 104,0 a52,52 0 1,0 -104,0`,
          color: "fg",
        },
        {
          svgPath: `M${LEFT_CX + 16},${EYE_CY - 16} m-22,0 a22,22 0 1,0 44,0 a22,22 0 1,0 -44,0`,
          color: "bg",
        },
        {
          svgPath: `M${RIGHT_CX},${EYE_CY} m-52,0 a52,52 0 1,0 104,0 a52,52 0 1,0 -104,0`,
          color: "fg",
        },
        {
          svgPath: `M${RIGHT_CX + 16},${EYE_CY - 16} m-22,0 a22,22 0 1,0 44,0 a22,22 0 1,0 -44,0`,
          color: "bg",
        },
      ];
    case "zen":
    case "calm":
      // Gentle soft resting curves
      return [
        {
          svgPath: `M${LEFT_CX - 46},${EYE_CY - 10} Q${LEFT_CX},${EYE_CY + 26} ${LEFT_CX + 46},${EYE_CY - 10}`,
          color: "fg",
          strokeWidth: 20,
        },
        {
          svgPath: `M${RIGHT_CX - 46},${EYE_CY - 10} Q${RIGHT_CX},${EYE_CY + 26} ${RIGHT_CX + 46},${EYE_CY - 10}`,
          color: "fg",
          strokeWidth: 20,
        },
      ];
    case "wide":
    case "attentive":
      // Alert open rings
      return [
        {
          svgPath: `M${LEFT_CX},${EYE_CY} m-54,0 a54,54 0 1,0 108,0 a54,54 0 1,0 -108,0`,
          color: "fg",
        },
        {
          svgPath: `M${LEFT_CX},${EYE_CY} m-26,0 a26,26 0 1,0 52,0 a26,26 0 1,0 -52,0`,
          color: "bg",
        },
        {
          svgPath: `M${RIGHT_CX},${EYE_CY} m-54,0 a54,54 0 1,0 108,0 a54,54 0 1,0 -108,0`,
          color: "fg",
        },
        {
          svgPath: `M${RIGHT_CX},${EYE_CY} m-26,0 a26,26 0 1,0 52,0 a26,26 0 1,0 -52,0`,
          color: "bg",
        },
      ];
    default:
      if (baseEyeStyle && baseEyeStyle.paths.length > 0) {
        return baseEyeStyle.paths;
      }
      return [
        {
          svgPath: `M${LEFT_CX},${EYE_CY} m-44,0 a44,44 0 1,0 88,0 a44,44 0 1,0 -88,0`,
          color: "fg",
        },
        {
          svgPath: `M${RIGHT_CX},${EYE_CY} m-44,0 a44,44 0 1,0 88,0 a44,44 0 1,0 -88,0`,
          color: "fg",
        },
      ];
  }
}

export function VoiceRoomEyes({
  visual,
  mood,
  tone,
  components,
  traits,
  customImageUrl,
  getAmplitude,
  onPoke,
  className,
}: {
  visual: VoiceAvatarVisual;
  mood: VoiceExpressionMood | string;
  tone: AvatarTone;
  components: CharacterComponents;
  traits: CharacterTraits;
  customImageUrl?: string | null;
  getAmplitude: () => number;
  onPoke?: () => void;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const wobble = useAnimationControls();

  const eyeReaction: VoiceEyeReaction =
    visual === "listening"
      ? "listening"
      : visual === "responding"
        ? "responding"
        : null;

  const reactiveRef = useReactiveEyes(eyeReaction, getAmplitude);

  // Parallax ref
  const parallaxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reduce) return;
    const onMove = (e: MouseEvent) => {
      const node = parallaxRef.current;
      if (!node) return;
      const x = (e.clientX / window.innerWidth - 0.5) * 2;
      const y = (e.clientY / window.innerHeight - 0.5) * 2;
      node.style.transform = `translate(${x * CURSOR_MAX_X}px, ${y * CURSOR_MAX_Y}px)`;
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [reduce]);

  // Eyelids blinking
  const eyelidsRef = useRef<SVGGElement | null>(null);
  const setBlink = useCallback((closed: boolean) => {
    const node = eyelidsRef.current;
    if (node) {
      node.style.transform = closed ? "scaleY(0.1)" : "scaleY(1)";
    }
  }, []);

  const manualBlinkTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (manualBlinkTimeout.current) clearTimeout(manualBlinkTimeout.current);
    },
    [],
  );

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;

    const blink = (next: () => void) => {
      if (cancelled) return;
      setBlink(true);
      t = setTimeout(() => {
        if (cancelled) return;
        setBlink(false);
        t = setTimeout(next, 140);
      }, 140);
    };

    const idle = () => {
      t = setTimeout(() => blink(idle), 2500 + Math.random() * 3500);
    };

    // Initial natural double-blink
    blink(() => blink(idle));

    return () => {
      cancelled = true;
      clearTimeout(t);
      setBlink(false);
    };
  }, [reduce, setBlink]);

  const reactToPoke = useCallback(() => {
    setBlink(true);
    if (manualBlinkTimeout.current) clearTimeout(manualBlinkTimeout.current);
    manualBlinkTimeout.current = setTimeout(() => setBlink(false), 140);

    onPoke?.();

    if (!reduce) {
      void wobble.start({
        scaleX: [1, 1.08, 0.94, 1.02, 1],
        scaleY: [1, 0.9, 1.06, 0.98, 1],
        rotate: [0, -3, 2, -1, 0],
        transition: { duration: 0.5, ease: "easeOut" },
      });
    }
  }, [reduce, wobble, setBlink, onPoke]);

  const baseEyeStyle = useMemo(() => {
    return (
      components.eyeStyles.find((e) => e.id === traits.eyeStyle) ??
      components.eyeStyles[0]
    );
  }, [components.eyeStyles, traits.eyeStyle]);

  const bodyShape = useMemo(() => {
    return (
      components.bodyShapes.find((b) => b.id === traits.bodyShape) ??
      components.bodyShapes[0]
    );
  }, [components.bodyShapes, traits.bodyShape]);

  const marks = useMemo(() => {
    return buildExpressionMarks(mood, baseEyeStyle);
  }, [mood, baseEyeStyle]);

  const lattice = useMemo(() => {
    if (!bodyShape) return [];
    return bodyLattice(bodyShape, 2);
  }, [bodyShape]);

  const accentDots = useMemo(() => {
    if (!bodyShape) return [];
    return bodyAccentDots(bodyShape);
  }, [bodyShape]);

  const sizeScale = EYE_STATE_SCALE[visual] ?? 1;

  if (customImageUrl) {
    return (
      <div
        data-testid="voice-room-eyes"
        onClick={reactToPoke}
        className={cn(
          "relative flex cursor-pointer flex-col items-center justify-center select-none",
          className,
        )}
      >
        <motion.div
          animate={wobble}
          className="relative flex items-center justify-center"
        >
          <div
            ref={parallaxRef}
            className="transition-transform duration-100 ease-out"
          >
            <div
              ref={reactiveRef}
              className="relative flex items-center justify-center"
            >
              <div
                className="overflow-hidden rounded-full border-2 shadow-xl transition-all duration-300"
                style={{
                  borderColor: tone.fgMuted,
                  width: 140 * sizeScale,
                  height: 140 * sizeScale,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={customImageUrl}
                  alt="Agent avatar"
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
          </div>
        </motion.div>
        {visual === "thinking" && <VoiceThinkingIndicator tone={tone} />}
      </div>
    );
  }

  return (
    <div
      data-testid="voice-room-eyes"
      onClick={reactToPoke}
      className={cn(
        "relative flex cursor-pointer flex-col items-center justify-center select-none",
        className,
      )}
    >
      <motion.div
        animate={wobble}
        className="relative flex items-center justify-center"
      >
        {/* Subtle breathing Aura Dots body silhouette */}
        {bodyShape && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-16 flex items-center justify-center opacity-30 transition-opacity duration-300 hover:opacity-40"
          >
            <svg
              viewBox={`0 0 ${bodyShape.viewBox.width} ${bodyShape.viewBox.height}`}
              className="h-full w-full"
            >
              {/* Closed silhouette contour */}
              <path
                d={bodyShape.svgPath}
                fill={tone.wash}
                opacity={0.35}
              />
              {/* Dot lattice */}
              {lattice.map((dot, index) => (
                <circle
                  key={index}
                  cx={dot.cx}
                  cy={dot.cy}
                  r={dot.r}
                  fill={tone.fgMuted}
                  opacity={dot.opacity * 0.4}
                />
              ))}
              {/* Orbiting accent dots */}
              {accentDots.map((dot, index) => (
                <circle
                  key={`accent-${index}`}
                  cx={dot.cx}
                  cy={dot.cy}
                  r={dot.r * 1.4}
                  fill={tone.fg}
                  opacity={0.65}
                />
              ))}
            </svg>
          </div>
        )}

        {/* Cursor parallax wrapper */}
        <div
          ref={parallaxRef}
          className="relative z-10 transition-transform duration-100 ease-out"
        >
          {/* Audio reactive scale wrapper */}
          <div
            ref={reactiveRef}
            className="relative flex items-center justify-center transition-all duration-300"
          >
            <motion.div
              animate={{ scale: sizeScale }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="relative flex items-center justify-center"
            >
              <svg
                viewBox="0 0 1000 1000"
                width={220}
                height={220}
                className="overflow-visible"
              >
                <g
                  ref={eyelidsRef}
                  style={{
                    transformOrigin: `${500}px ${EYE_CY}px`,
                    transition: "transform 110ms ease-out",
                  }}
                >
                  {marks.map((mark, i) => {
                    const resolvedColor = eyeMarkColor(mark.color, tone);
                    if (mark.strokeWidth) {
                      return (
                        <path
                          key={i}
                          d={mark.svgPath}
                          fill="none"
                          stroke={resolvedColor}
                          strokeWidth={mark.strokeWidth}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      );
                    }
                    return (
                      <path
                        key={i}
                        d={mark.svgPath}
                        fill={resolvedColor}
                      />
                    );
                  })}
                </g>
              </svg>
            </motion.div>
          </div>
        </div>
      </motion.div>

      {/* Thinking triad dots */}
      {visual === "thinking" && <VoiceThinkingIndicator tone={tone} />}
    </div>
  );
}

export const EXPRESSION_PRESETS = [
  { id: "auto", label: "Auto" },
  { id: "attentive", label: "Attentive" },
  { id: "happy", label: "Happy" },
  { id: "curious", label: "Curious" },
  { id: "focused", label: "Focused" },
  { id: "wink", label: "Wink" },
  { id: "sparkle", label: "Sparkle" },
  { id: "zen", label: "Zen" },
] as const;

export function ExpressionSelectorPill({
  currentOverride,
  onSelect,
  className,
}: {
  currentOverride: string | null;
  onSelect: (presetId: string | null) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-1 rounded-full bg-black/20 p-1 backdrop-blur-md",
        className,
      )}
    >
      {EXPRESSION_PRESETS.map((preset) => {
        const isSelected =
          preset.id === "auto" ? currentOverride === null : currentOverride === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onSelect(preset.id === "auto" ? null : preset.id)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium transition-all duration-150",
              isSelected
                ? "bg-white text-black shadow-sm"
                : "text-white/70 hover:bg-white/10 hover:text-white",
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
