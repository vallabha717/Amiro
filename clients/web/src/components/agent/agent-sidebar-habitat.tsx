"use client";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { CharacterTraits } from "@/lib/agent/character-catalog";
import { motion } from "framer-motion";
import { ArrowUpRight, Pause, Play, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AgentCharacterAvatar } from "./avatar-primitives";

export type HabitatShape = "blob" | "sprout" | "star" | "cloud";
export type MascotMotion = "dance" | "swim" | "sway" | "drift" | "none";

function normalizeShape(shape: string): HabitatShape {
  if (shape === "ghost" || shape === "urchin") return "blob";
  if (shape === "sprout" || shape === "star" || shape === "cloud" || shape === "blob") return shape;
  return "blob";
}

export function getMascotMotion(shape: string): "dance" | "swim" | "sway" | "drift" {
  const normalized = normalizeShape(shape);
  switch (normalized) {
    case "blob":
      return "dance";
    case "star":
      return "swim";
    case "sprout":
      return "sway";
    case "cloud":
      return "drift";
  }
}

/** A little habitat, not an activity indicator. All movement is decorative. */
export function AgentSidebarHabitat({
  name,
  traits,
  customImageUrl,
  accent,
  paused: controlledPaused,
  prefersReducedMotion: forcedReducedMotion,
}: {
  name: string;
  traits: CharacterTraits;
  customImageUrl?: string | null;
  accent: string;
  paused?: boolean;
  prefersReducedMotion?: boolean;
}) {
  const systemPrefersReducedMotion = usePrefersReducedMotion();
  const prefersReducedMotion =
    forcedReducedMotion !== undefined
      ? forcedReducedMotion
      : systemPrefersReducedMotion;
  const [internalPaused, setInternalPaused] = useState(false);
  const paused =
    controlledPaused !== undefined ? controlledPaused : internalPaused;
  const reduceMotion = prefersReducedMotion || paused;
  const [greeting, setGreeting] = useState(false);

  const shape = normalizeShape(traits.bodyShape);
  const mascotMotion: MascotMotion = reduceMotion ? "none" : getMascotMotion(shape);

  const avatarAnim = useMemo(() => {
    if (reduceMotion) return { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
    if (greeting) return { x: 0, y: -8, rotate: [-7, 7, -7, 0] as unknown as number, scaleX: 1, scaleY: 1 };
    switch (shape) {
      case "blob":
        return {
          y: [0, -10, 0, -6, 0],
          x: [0, -8, 8, -4, 0],
          rotate: [-2.5, 2.5, -2, 2.5, -2.5],
          scaleX: [1.08, 0.94, 1.08, 0.96, 1.08],
          scaleY: [0.92, 1.06, 0.92, 1.04, 0.92],
        };
      case "sprout":
        return {
          rotate: [-5, 5, -5],
          y: [0, -3, 0],
          x: 0,
        };
      case "star":
        return {
          x: [-24, 24, -24],
          y: [0, -4, 0, -4, 0],
          rotate: [-6, 6, -6],
        };
      case "cloud":
        return {
          x: [-30, 30, -30],
          y: [0, -5, 0, 4, 0],
          rotate: [-1.5, 1.5, -1, 1, -1.5],
        };
      default:
        return { x: 0, y: 0, rotate: 0 };
    }
  }, [reduceMotion, greeting, shape]);

  const avatarTransition = useMemo(() => {
    if (reduceMotion) return { duration: 0 };
    if (greeting) return { duration: 0.7 } as const;
    switch (shape) {
      case "blob":
        return { duration: 1.6, repeat: Infinity, ease: "easeInOut" } as const;
      case "sprout":
        return { duration: 3.5, repeat: Infinity, ease: "easeInOut" } as const;
      case "star":
        return { duration: 4, repeat: Infinity, ease: "easeInOut" } as const;
      case "cloud":
        return { duration: 6, repeat: Infinity, ease: "easeInOut" } as const;
      default:
        return { duration: 13, repeat: Infinity, ease: "easeInOut" } as const;
    }
  }, [reduceMotion, greeting, shape]);

  const cubeAnim = useMemo(() => {
    if (reduceMotion) return { rotate: 0, y: 0, x: 0, scale: 1 };
    if (greeting) return { rotate: [-4, 4, -4, 0] as unknown as number, y: -6, x: 0 };
    switch (shape) {
      case "blob":
        return {
          y: [0, -6, 0, -4, 0],
          rotate: [0, 12, -10, 6, 0],
          scale: [1, 1.06, 1, 1.04, 1],
        };
      case "sprout":
        return {
          rotate: [-4, 4, -4],
          y: [0, -2, 0],
          x: 0,
        };
      case "star":
        return {
          x: [-12, 12, -12],
          y: [0, -3, 0, -3, 0],
          rotate: [-8, 8, -8],
        };
      case "cloud":
        return {
          x: [-10, 10, -10],
          y: [0, -4, 0, 3, 0],
          rotate: [-6, 6, -6],
        };
      default:
        return { rotate: 0, y: 0 };
    }
  }, [reduceMotion, greeting, shape]);

  const cubeTransition = useMemo(() => {
    if (reduceMotion) return { duration: 0 };
    if (greeting) return { duration: 0.7 } as const;
    switch (shape) {
      case "blob":
        return { duration: 1.6, repeat: Infinity, ease: "easeInOut" } as const;
      case "sprout":
        return { duration: 3.5, repeat: Infinity, ease: "easeInOut" } as const;
      case "star":
        return { duration: 4, repeat: Infinity, ease: "easeInOut" } as const;
      case "cloud":
        return { duration: 6, repeat: Infinity, ease: "easeInOut" } as const;
      default:
        return { duration: 13, repeat: Infinity, ease: "easeInOut" } as const;
    }
  }, [reduceMotion, greeting, shape]);

  return (
    <div className="relative">
      <Link
        href="/agent"
        aria-label={`Customize ${name}`}
        data-testid="sidebar-agent-habitat"
        onPointerEnter={() => setGreeting(true)}
        onPointerLeave={() => setGreeting(false)}
        onFocus={() => setGreeting(true)}
        onBlur={() => setGreeting(false)}
        className="group/habitat relative mx-2 mt-1 mb-2 block aspect-square overflow-hidden rounded-[24px] border border-border/70 bg-background outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        style={{
          backgroundImage: `radial-gradient(ellipse at 65% 20%, color-mix(in srgb, ${accent} 18%, transparent) 0%, transparent 65%)`,
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[.12]"
          style={{
            backgroundImage:
              "radial-gradient(currentColor .7px, transparent .7px)",
            backgroundSize: "14px 14px",
          }}
        />
        <span className="absolute top-4 left-4 flex items-center gap-1.5 text-[9px] font-medium tracking-[.13em] text-muted-foreground uppercase">
          <Sparkles className="size-3" aria-hidden="true" /> A little
          imagination
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="absolute top-3.5 right-3.5 size-4 text-muted-foreground transition-transform group-hover/habitat:translate-x-0.5 group-hover/habitat:-translate-y-0.5"
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-5 bottom-11 h-px bg-border/70"
        />
        <motion.div
          aria-hidden="true"
          className="absolute top-[34%] left-[33%]"
          data-motion={mascotMotion}
          animate={avatarAnim}
          transition={avatarTransition}
        >
          <AgentCharacterAvatar
            traits={traits}
            customImageUrl={customImageUrl}
            size={82}
            interactive={false}
            animated={!reduceMotion}
            accentColor={accent}
          />
        </motion.div>
        <motion.span
          aria-hidden="true"
          className="absolute right-[19%] bottom-[29%] size-3 rounded-[4px] border"
          style={{
            borderColor: accent,
            backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
          }}
          animate={cubeAnim}
          transition={cubeTransition}
        />
        <div className="absolute inset-x-4 bottom-3 flex items-center justify-between gap-2 pr-6">
          <span className="truncate text-[10px] text-muted-foreground">
            {greeting ? "Oh, hello you!" : "A small world. Your agent."}
          </span>
        </div>
      </Link>
      {!prefersReducedMotion && (
        <button
          type="button"
          aria-label={paused ? "Play agent animation" : "Pause agent animation"}
          aria-pressed={paused}
          onClick={() => setInternalPaused((value) => !value)}
          className="absolute right-5 bottom-4 flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {paused ? (
            <Play className="size-3" aria-hidden="true" />
          ) : (
            <Pause className="size-3" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}
