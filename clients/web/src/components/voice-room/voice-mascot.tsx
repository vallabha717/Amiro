"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { CharacterTraits } from "@/lib/agent/character-catalog";
import { type OpenDotVariantId, openDotVariantForTraits } from "@/lib/agent/opendots-catalog";
import {
  type VoicePhase,
  getVoiceInputLevel,
  getVoiceOutputLevel,
} from "@/lib/voice/voice-store";
import { cn } from "lib/utils";
import { type CSSProperties, useEffect, useRef } from "react";
import { VOICE_ROOM_CSS } from "./voice-room-css";

/**
 * Where each plush's face sits on its 512x512 sprite: the mouth (for the
 * talking overlay) and ear height (where sound flows in while listening).
 * Measured from public/agent/opendots/*.png.
 */
const FACE: Record<OpenDotVariantId, { mouthX: number; mouthY: number; mouthW: number; earY: number }> = {
  blue: { mouthX: 256, mouthY: 266, mouthW: 46, earY: 236 },
  mint: { mouthX: 254, mouthY: 281, mouthW: 34, earY: 252 },
  orange: { mouthX: 264, mouthY: 226, mouthW: 42, earY: 214 },
  purple: { mouthX: 256, mouthY: 241, mouthW: 46, earY: 226 },
};

/**
 * Feed the live mic / speaker levels into CSS variables (--in, --out) on
 * `ref`, once per frame, without re-rendering React. Every animation that
 * reacts to sound reads these.
 */
export function useVoiceLevelVars(ref: React.RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let inS = 0;
    let outS = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const i = getVoiceInputLevel();
        const o = getVoiceOutputLevel();
        // Fast attack, slower release: reads as lively without flicker.
        inS += (i - inS) * (i > inS ? 0.5 : 0.12);
        outS += (o - outS) * (o > outS ? 0.6 : 0.18);
        el.style.setProperty("--in", inS.toFixed(3));
        el.style.setProperty("--out", outS.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ref, enabled]);
}

export interface VoiceMascotProps {
  phase: VoicePhase;
  traits: CharacterTraits;
  accent: string;
  customImageUrl?: string | null;
  muted?: boolean;
  size?: number;
  className?: string;
}

/**
 * The agent's plush, in a voice call. It puts its headphones on when the
 * call connects, sound flows into its ears while you talk, a thought orbit
 * circles it while it works, and its mouth opens with the real audio level
 * while it answers.
 */
export function VoiceMascot({
  phase,
  traits,
  accent,
  customImageUrl,
  muted,
  size = 240,
  className,
}: VoiceMascotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  useVoiceLevelVars(ref, !reduce);
  const variant = openDotVariantForTraits(traits);
  const face = FACE[variant.id];
  // The blue plush already wears headphones; everyone else gets a pair.
  const wearsOwn = variant.id === "blue" && !customImageUrl;
  const earPct = (face.earY / 512) * 100;

  return (
    <div
      ref={ref}
      data-testid="voice-mascot"
      data-phase={phase}
      data-muted={muted ? "true" : undefined}
      data-reduce={reduce ? "true" : undefined}
      className={cn("vm-root relative select-none", className)}
      style={{ width: size, height: size, "--accent": accent, "--ear-y": `${earPct}%` } as CSSProperties}
    >
      <style href="amiro-voice-room" precedence="default">
        {VOICE_ROOM_CSS}
      </style>

      {/* Aura that swells with whoever is talking. */}
      <div aria-hidden className="vm-aura" />

      {/* Speaking: rings radiate outward. */}
      <div aria-hidden className="vm-rings">
        <span />
        <span />
        <span />
      </div>

      {/* Hearing: sound waves travel in toward each ear, notes drift in. */}
      <div aria-hidden className="vm-inflow">
        <svg className="vm-waves vm-waves-l" viewBox="0 0 60 100">
          <path d="M20 20 Q40 50 20 80" />
          <path d="M30 10 Q55 50 30 90" />
          <path d="M40 0 Q70 50 40 100" />
        </svg>
        <svg className="vm-waves vm-waves-r" viewBox="0 0 60 100">
          <path d="M40 20 Q20 50 40 80" />
          <path d="M30 10 Q5 50 30 90" />
          <path d="M20 0 Q-10 50 20 100" />
        </svg>
        <span className="vm-note vm-note-1">♪</span>
        <span className="vm-note vm-note-2">♫</span>
        <span className="vm-note vm-note-3">♪</span>
      </div>

      {/* Thinking: a little orbit of thoughts above the head. */}
      <div aria-hidden className="vm-orbit">
        <span />
        <span />
        <span />
      </div>

      <div className="vm-react">
        <div className="vm-body">
          {/* Headband sits behind the plush so only the arc over the head shows. */}
          {!wearsOwn && (
            <svg aria-hidden className="vm-band" viewBox="0 0 512 512">
              <path
                d={`M70 ${face.earY + 10} C 70 ${face.earY - 250}, 442 ${face.earY - 250}, 442 ${face.earY + 10}`}
              />
            </svg>
          )}
          <AgentCharacterAvatar
            traits={traits}
            customImageUrl={customImageUrl}
            size={size}
            animated={false}
            accentColor={accent}
          />
          <svg aria-hidden className="vm-face" viewBox="0 0 512 512">
            {/* Ear cups: drawn for plushes without their own, a glow for the one with. */}
            {wearsOwn ? (
              <>
                <ellipse className="vm-cup-glow" cx={66} cy={238} rx={46} ry={70} />
                <ellipse className="vm-cup-glow" cx={446} cy={238} rx={46} ry={70} />
              </>
            ) : (
              <>
                <g className="vm-cup vm-cup-l">
                  <rect x={34} y={face.earY - 52} width={58} height={104} rx={28} />
                  <rect className="vm-cup-pad" x={74} y={face.earY - 40} width={20} height={80} rx={10} />
                </g>
                <g className="vm-cup vm-cup-r">
                  <rect x={420} y={face.earY - 52} width={58} height={104} rx={28} />
                  <rect className="vm-cup-pad" x={418} y={face.earY - 40} width={20} height={80} rx={10} />
                </g>
                <ellipse className="vm-cup-glow" cx={63} cy={face.earY} rx={40} ry={62} />
                <ellipse className="vm-cup-glow" cx={449} cy={face.earY} rx={40} ry={62} />
              </>
            )}
            {/* Talking mouth: opens with the speaker level, hides the painted smile. */}
            <g className="vm-mouth" style={{ transformOrigin: `${face.mouthX}px ${face.mouthY - 6}px` }}>
              <ellipse cx={face.mouthX} cy={face.mouthY + 4} rx={face.mouthW * 0.5} ry={16} fill="#2b0f14" />
              <ellipse cx={face.mouthX} cy={face.mouthY + 13} rx={face.mouthW * 0.3} ry={6} fill="#f07a8c" />
            </g>
          </svg>
        </div>
      </div>

      {muted && (
        <span aria-label="Microphone muted" className="vm-muted-badge">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M2 2l20 20M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .4-.03.8-.1 1.18M12 19v3" />
          </svg>
        </span>
      )}
    </div>
  );
}
