"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Pause, Play, Sparkles } from "lucide-react";
import { useState } from "react";
import { AgentCharacterAvatar } from "./avatar-primitives";
import type { CharacterTraits } from "@/lib/agent/character-catalog";

/** A little habitat, not an activity indicator. All movement is decorative. */
export function AgentSidebarHabitat({
  name,
  traits,
  customImageUrl,
  accent,
}: {
  name: string;
  traits: CharacterTraits;
  customImageUrl?: string | null;
  accent: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const reduceMotion = prefersReducedMotion || paused;
  const [greeting, setGreeting] = useState(false);
  return (
    <div className="relative">
      <Link
        href="/agent?customize=1"
        aria-label={`Customize ${name}`}
        data-testid="sidebar-agent-habitat"
        onPointerEnter={() => setGreeting(true)}
        onPointerLeave={() => setGreeting(false)}
        onFocus={() => setGreeting(true)}
        onBlur={() => setGreeting(false)}
        className="group/habitat relative mx-2 mt-1 mb-2 block aspect-square overflow-hidden rounded-[24px] border border-border/70 bg-background outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        style={{
          backgroundImage: `radial-gradient(ellipse at 65% 20%, ${accent}18, transparent 65%)`,
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
          animate={
            reduceMotion
              ? { x: 0, y: 0, rotate: 0 }
              : greeting
                ? { x: 0, y: -8, rotate: [-7, 7, -7, 0] }
                : {
                    x: [-35, 24, 36, -12, -35],
                    y: [0, -9, 1, -4, 0],
                    rotate: [-8, 7, 0, -6, -8],
                  }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : greeting
                ? { duration: 0.7 }
                : { duration: 13, repeat: Infinity, ease: "easeInOut" }
          }
        >
          <AgentCharacterAvatar
            traits={traits}
            customImageUrl={customImageUrl}
            size={82}
            interactive={false}
            animated={!reduceMotion}
          />
        </motion.div>
        <motion.span
          aria-hidden="true"
          className="absolute right-[19%] bottom-[29%] size-3 rounded-[4px] border"
          style={{ borderColor: accent, backgroundColor: `${accent}24` }}
          animate={
            reduceMotion
              ? { rotate: 0, y: 0 }
              : {
                  rotate: [0, 0, 90, 180, 180, 270, 360],
                  y: [0, 0, -14, 0, 0, -8, 0],
                }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 13, repeat: Infinity, ease: "easeInOut" }
          }
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
          onClick={() => setPaused((value) => !value)}
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
