"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { openAgentPane } from "@/app/store/chat-ux-store";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { useAgentTheme } from "@/hooks/use-agent-theme";
import { DEFAULT_CHARACTER_TRAITS } from "@/lib/agent/character-catalog";
import { OPENDOTS_VARIANTS, openDotVariantForTraits } from "@/lib/agent/opendots-catalog";
import { memberName, swarmActivity, useSwarm } from "@/lib/backend/swarm-api";
import { type VoicePhase, getVoiceInputLevel, getVoiceOutputLevel, useVoiceStore } from "@/lib/voice/voice-store";
import { AnimatePresence, motion } from "framer-motion";
import { isShortcutEvent, Shortcuts } from "@/lib/keyboard-shortcuts";
import { cn } from "lib/utils";
import {
  CheckIcon,
  HandIcon,
  Maximize2Icon,
  Mic,
  MicOff,
  Minimize2Icon,
  PhoneOff,
  SquareIcon,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { VoiceMascot } from "./voice-mascot";
import { VOICE_ROOM_CSS } from "./voice-room-css";

/** What the agent is doing, in its own voice. */
export function phaseLine(phase: VoicePhase, name: string, muted: boolean): string {
  if (phase === "error") return "Something went wrong";
  if (muted && phase !== "speaking" && phase !== "thinking") return "Your mic is muted";
  switch (phase) {
    case "connecting":
      return "Putting on headphones…";
    case "listening":
      return "I'm all ears";
    case "hearing":
      return "Listening…";
    case "transcribing":
      return "Catching that…";
    case "thinking":
      return "Thinking it over…";
    case "speaking":
      return `${name} is talking`;
    default:
      return "Voice is off";
  }
}

function useMascotIdentity() {
  const { data: identity } = useAgentIdentity();
  const { accentHex } = useAgentTheme();
  return {
    name: identity?.name || "Amiro",
    traits: identity?.traits ?? DEFAULT_CHARACTER_TRAITS,
    customImageUrl: identity?.customImageUrl ?? null,
    accent: accentHex,
  };
}

function useVoiceKeys(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useVoiceStore.getState();
      if (!s.active) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (s.phase === "speaking" || s.phase === "thinking") s.interrupt();
        else if (s.phase === "hearing") s.pttRelease();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        s.toggleMuted();
      } else if (e.key === "Escape") {
        s.setMinimized(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

function RoundButton({
  label,
  hint,
  onClick,
  children,
  tone = "default",
  size = "md",
  testId,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "active" | "danger" | "accent";
  size?: "sm" | "md" | "lg";
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          onClick={onClick}
          className={cn(
            "grid place-items-center rounded-full transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            size === "sm" && "size-9",
            size === "md" && "size-12",
            size === "lg" && "size-14",
            tone === "default" && "bg-muted/80 text-foreground hover:bg-muted",
            tone === "active" && "bg-foreground text-background hover:opacity-90",
            tone === "danger" && "bg-red-500 text-white shadow-lg shadow-red-500/30 hover:bg-red-600",
            tone === "accent" && "text-white shadow-lg hover:brightness-110",
          )}
          style={tone === "accent" ? { background: "var(--accent)" } : undefined}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint ? <span className="ml-1.5 text-muted-foreground">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Swarm agents sit in the room as little plush companions. */
function Companions({ threadId, mainVariant }: { threadId: string; mainVariant: string }) {
  const { data } = useSwarm(threadId, true);
  const members = data?.members ?? [];
  const palette = useMemo(() => OPENDOTS_VARIANTS.filter((v) => v.id !== mainVariant), [mainVariant]);
  if (!members.length) return null;
  return (
    <div className="flex items-end justify-center gap-3" data-testid="voice-companions">
      {members.slice(0, 6).map((m, i) => {
        const v = palette[i % palette.length];
        const activity = swarmActivity(m);
        const shape = { blue: "blob", mint: "sprout", orange: "star", purple: "cloud" }[v.id];
        return (
          <Tooltip key={m.sessionId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => openAgentPane(threadId, m.sessionId)}
                className="group relative flex flex-col items-center gap-0.5"
                aria-label={`Open ${memberName(m)} beside the chat`}
              >
                <span className="relative">
                  <span className="vm-companion block" data-activity={activity}>
                    <AgentCharacterAvatar
                      traits={{ ...DEFAULT_CHARACTER_TRAITS, bodyShape: shape }}
                      size={40}
                      animated={false}
                      accentColor={v.baseColor}
                    />
                  </span>
                  {activity === "working" && (
                    <span className="vm-typing absolute -right-2 -top-1 rounded-full bg-background px-1 py-0.5 text-muted-foreground shadow-sm ring-1 ring-border">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                  {activity === "done" && (
                    <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-emerald-500 text-white">
                      <CheckIcon className="size-2.5" />
                    </span>
                  )}
                </span>
                <span className="max-w-16 truncate text-[10px] text-muted-foreground group-hover:text-foreground">
                  {memberName(m)}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {memberName(m)} · {activity} — click to open beside the chat
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Full voice room: covers the chat column (never the sidebar or the agent
 * panes), with the agent's plush front and centre.
 */
export function VoiceRoom({ threadId }: { threadId: string }) {
  const { phase, muted, outputMuted, userCaption, assistantCaption, error, voiceLabel } = useVoiceStore(
    useShallow((s) => ({
      phase: s.phase,
      muted: s.muted,
      outputMuted: s.outputMuted,
      userCaption: s.userCaption,
      assistantCaption: s.assistantCaption,
      error: s.error,
      voiceLabel: s.voiceLabel,
    })),
  );
  const { name, traits, customImageUrl, accent } = useMascotIdentity();
  const variant = openDotVariantForTraits(traits);
  useVoiceKeys(true);
  const s = useVoiceStore.getState;

  return (
    <motion.div
      data-testid="voice-room"
      data-phase={phase}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      className="absolute inset-0 z-50 flex flex-col overflow-hidden bg-background/92 backdrop-blur-xl"
      style={{ "--accent": accent } as CSSProperties}
    >
      <style href="amiro-voice-room" precedence="default">
        {VOICE_ROOM_CSS}
      </style>
      {/* Ambient wash in the agent's colour. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(60% 45% at 50% 38%, color-mix(in srgb, ${accent} 16%, transparent), transparent 70%), radial-gradient(40% 30% at 15% 90%, color-mix(in srgb, ${accent} 10%, transparent), transparent 70%)`,
        }}
      />

      <header className="relative flex items-center gap-2 px-4 pt-3">
        <span className="relative flex size-2">
          <span
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-75",
              phase !== "error" && "animate-ping",
            )}
            style={{ background: phase === "error" ? "#ef4444" : accent }}
          />
          <span className="relative inline-flex size-2 rounded-full" style={{ background: phase === "error" ? "#ef4444" : accent }} />
        </span>
        <span className="text-sm font-medium">Voice with {name}</span>
        {voiceLabel && <span className="text-xs text-muted-foreground">· {voiceLabel}</span>}
        <div className="ml-auto flex items-center gap-1">
          <RoundButton label="Minimize" hint="Esc" size="sm" onClick={() => s().setMinimized(true)} testId="voice-minimize">
            <Minimize2Icon className="size-4" />
          </RoundButton>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6">
        <VoiceMascot
          phase={phase}
          traits={traits}
          accent={accent}
          customImageUrl={customImageUrl}
          muted={muted}
          size={230}
        />

        <AnimatePresence mode="wait">
          <motion.p
            key={phaseLine(phase, name, muted)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            data-testid="voice-phase-line"
            className="text-sm font-medium text-muted-foreground"
          >
            {phaseLine(phase, name, muted)}
          </motion.p>
        </AnimatePresence>

        <div className="flex min-h-28 w-full max-w-xl flex-col items-center gap-3 text-center">
          <AnimatePresence>
            {userCaption && phase !== "hearing" && (
              <motion.div
                key={`u-${userCaption}`}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                data-testid="voice-user-caption"
                className="max-w-full self-end rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-left text-sm text-foreground/90 shadow-sm"
              >
                {userCaption}
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence mode="wait">
            {assistantCaption && (phase === "speaking" || phase === "thinking") && (
              <motion.p
                key={`a-${assistantCaption}`}
                initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                transition={{ duration: 0.25 }}
                data-testid="voice-assistant-caption"
                className="text-balance text-lg font-medium leading-snug text-foreground"
              >
                {assistantCaption}
              </motion.p>
            )}
          </AnimatePresence>
          {error && (
            <p data-testid="voice-error" className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <Companions threadId={threadId} mainVariant={variant.id} />
      </div>

      <footer className="relative flex items-center justify-center gap-3 pb-6 pt-2">
        <RoundButton
          label={outputMuted ? "Unmute speaker" : "Mute speaker"}
          onClick={() => s().toggleOutputMuted()}
          tone={outputMuted ? "active" : "default"}
          testId="voice-speaker"
        >
          {outputMuted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </RoundButton>
        <RoundButton
          label={muted ? "Unmute mic" : "Mute mic"}
          hint="M"
          size="lg"
          onClick={() => s().toggleMuted()}
          tone={muted ? "active" : "accent"}
          testId="voice-mic"
        >
          {muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
        </RoundButton>
        {phase === "speaking" || phase === "thinking" ? (
          <RoundButton label="Stop answer" hint="Space" onClick={() => s().interrupt()} testId="voice-interrupt">
            <SquareIcon className="size-4 fill-current" />
          </RoundButton>
        ) : (
          <RoundButton
            label="I'm done talking"
            hint="Space"
            onClick={() => s().pttRelease()}
            testId="voice-done-talking"
          >
            <HandIcon className="size-5" />
          </RoundButton>
        )}
        <RoundButton label="End voice" onClick={() => s().end()} tone="danger" testId="voice-end">
          <PhoneOff className="size-5" />
        </RoundButton>
      </footer>
    </motion.div>
  );
}

/** Tiny live level meter for the dock. */
function LevelBars({ count = 5 }: { count?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const lvl = Math.max(getVoiceInputLevel(), getVoiceOutputLevel());
        const t = performance.now() / 180;
        el.querySelectorAll("i").forEach((bar, i) => {
          const wobble = 0.55 + 0.45 * Math.sin(t + i * 1.3);
          (bar as HTMLElement).style.height = `${Math.round(18 + Math.min(1, lvl * 1.4) * 82 * wobble)}%`;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span ref={ref} className="vm-bars" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/** Minimized voice session: a pill above the composer with a mini plush. */
export function VoiceDock() {
  const { phase, muted, assistantCaption, userCaption } = useVoiceStore(
    useShallow((s) => ({
      phase: s.phase,
      muted: s.muted,
      assistantCaption: s.assistantCaption,
      userCaption: s.userCaption,
    })),
  );
  const { name, traits, customImageUrl, accent } = useMascotIdentity();
  useVoiceKeys(true);
  const s = useVoiceStore.getState;
  const caption = phase === "speaking" ? assistantCaption : phase === "thinking" ? userCaption : "";

  return (
    <motion.div
      data-testid="voice-dock"
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.97 }}
      className="mx-auto flex w-full max-w-3xl items-center gap-3 rounded-2xl border border-border bg-background/90 px-3 py-2 shadow-lg backdrop-blur"
      style={{ "--accent": accent } as CSSProperties}
    >
      <button type="button" onClick={() => s().setMinimized(false)} aria-label="Open voice room" className="shrink-0">
        <VoiceMascot phase={phase} traits={traits} accent={accent} customImageUrl={customImageUrl} muted={muted} size={44} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-xs font-medium">
          {phaseLine(phase, name, muted)}
          <LevelBars />
        </span>
        {caption && <span className="truncate text-xs text-muted-foreground">{caption}</span>}
      </div>
      <RoundButton label={muted ? "Unmute mic" : "Mute mic"} hint="M" size="sm" onClick={() => s().toggleMuted()} tone={muted ? "active" : "default"}>
        {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </RoundButton>
      {(phase === "speaking" || phase === "thinking") && (
        <RoundButton label="Stop answer" hint="Space" size="sm" onClick={() => s().interrupt()}>
          <SquareIcon className="size-3.5 fill-current" />
        </RoundButton>
      )}
      <RoundButton label="Expand" size="sm" onClick={() => s().setMinimized(false)} testId="voice-expand">
        <Maximize2Icon className="size-4" />
      </RoundButton>
      <RoundButton label="End voice" size="sm" tone="danger" onClick={() => s().end()}>
        <PhoneOff className="size-4" />
      </RoundButton>
    </motion.div>
  );
}

/** Global Ctrl+Space (jcode's voice key) toggles voice; mounted once in the popup provider. */
export function VoiceHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcutEvent(e, Shortcuts.toggleVoiceChat)) return;
      e.preventDefault();
      e.stopPropagation();
      const s = useVoiceStore.getState();
      if (s.active) s.end();
      else void s.start(new URLSearchParams(window.location.search).get("thread"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
