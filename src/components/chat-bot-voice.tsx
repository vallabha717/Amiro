"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Mic,
  MicOff,
  Subtitles,
  Volume2,
  VolumeX,
  Waves,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { appStore } from "@/app/store";
import { useShallow } from "zustand/shallow";
import {
  getCharacterComponents,
  toneForBg,
} from "@/lib/agent/character-catalog";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import {
  type LiveVoicePhase,
  liveVoicePhaseLabel,
  toVoiceAvatarVisual,
  toVoiceExpressionMood,
} from "@/lib/ai/speech/live-voice-motion";
import {
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  useLiveVoiceController,
  useLiveVoiceStore,
} from "@/lib/ai/speech/live-voice-store";
import { cn } from "@/lib/utils";
import { isShortcutEvent, Shortcuts } from "@/lib/keyboard-shortcuts";
import {
  ExpressionSelectorPill,
  VoiceRoomEyes,
} from "./voice/voice-expressive-eyes";
import {
  BAND_VOICE,
  VoiceMeshWaves,
  VoiceReactiveWaves,
} from "./voice/voice-waves";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface LiveVoiceStageProps {
  phase?: LiveVoicePhase;
  partialTranscript?: string;
  finalTranscript?: string;
  assistantTranscript?: string;
  className?: string;
  onSendUtterance?: (text: string) => void;
}

/**
 * LiveVoiceStage
 *
 * The creative, expressive inline Voice Mode stage inspired by Vellum.
 * Renders directly above the composer without blocking the sidebar, header, or chat thread.
 */
export function LiveVoiceStage({
  phase: propPhase,
  partialTranscript: propPartial,
  finalTranscript: propFinal,
  assistantTranscript: propAssistant,
  className,
}: LiveVoiceStageProps) {
  const { data: identity } = useAgentIdentity();
  const storePhase = useLiveVoiceStore((s) => s.phase);
  const phase = propPhase ?? storePhase;
  const muted = useLiveVoiceStore((s) => s.muted);
  const outputMuted = useLiveVoiceStore((s) => s.outputMuted);
  const assistantAudioActive = useLiveVoiceStore((s) => s.assistantAudioActive);
  const storePartial = useLiveVoiceStore((s) => s.partialTranscript);
  const partialTranscript = propPartial ?? storePartial;
  const storeFinal = useLiveVoiceStore((s) => s.finalTranscript);
  const finalTranscript = propFinal ?? storeFinal;
  const storeAssistant = useLiveVoiceStore((s) => s.assistantTranscript);
  const assistantTranscript = propAssistant ?? storeAssistant;
  const waveEngine = useLiveVoiceStore((s) => s.waveEngine);
  const showCaptions = useLiveVoiceStore((s) => s.showCaptions);
  const eyeStyleOverride = useLiveVoiceStore((s) => s.eyeStyleOverride);

  const toggleMuted = useLiveVoiceStore((s) => s.toggleMuted);
  const toggleOutputMuted = useLiveVoiceStore((s) => s.toggleOutputMuted);
  const endSession = useLiveVoiceStore((s) => s.endSession);
  const minimizeRoom = useLiveVoiceStore((s) => s.minimizeRoom);
  const setWaveEngine = useLiveVoiceStore((s) => s.setWaveEngine);
  const setShowCaptions = useLiveVoiceStore((s) => s.setShowCaptions);
  const setEyeStyleOverride = useLiveVoiceStore((s) => s.setEyeStyleOverride);

  const components = useMemo(() => getCharacterComponents(), []);
  const traits =
    identity?.traits ??
    (components.bodyShapes[0] && components.eyeStyles[0] && components.colors[0]
      ? {
          bodyShape: components.bodyShapes[0].id,
          eyeStyle: components.eyeStyles[0].id,
          color: components.colors[0].id,
        }
      : { bodyShape: "classic", eyeStyle: "curious", color: "blue" });

  const bg = identity?.accentHex ?? "#1e293b";
  const tone = toneForBg(bg);

  const visual = toVoiceAvatarVisual(phase, assistantAudioActive, muted);

  const currentAmplitude = visual === "responding"
    ? getLiveVoiceOutputAmplitude()
    : getLiveVoiceInputAmplitude();

  const mood = eyeStyleOverride ?? toVoiceExpressionMood(visual, muted, currentAmplitude);

  const replying = assistantAudioActive || phase === "speaking";
  const micLive = phase === "listening" && !muted;
  const ink = replying ? BAND_VOICE.responding : BAND_VOICE.listening;

  const getBandAmplitude = replying
    ? getLiveVoiceOutputAmplitude
    : micLive
      ? getLiveVoiceInputAmplitude
      : () => 0;

  // Track word highlight index during assistant playback
  const [spokenWordIndex, setSpokenWordIndex] = useState(0);
  useEffect(() => {
    if (!replying || !assistantTranscript) {
      setSpokenWordIndex(0);
      return;
    }
    const words = assistantTranscript.trim().split(/\s+/);
    if (words.length === 0) return;

    // Approximate conversational pacing ~3.2 words / sec
    const interval = setInterval(() => {
      setSpokenWordIndex((prev) => {
        if (prev < words.length - 1) return prev + 1;
        return prev;
      });
    }, 310);

    return () => clearInterval(interval);
  }, [replying, assistantTranscript]);

  const assistantWords = useMemo(() => {
    if (!assistantTranscript) return [];
    return assistantTranscript.trim().split(/\s+/);
  }, [assistantTranscript]);

  const displayedUserSpeech = partialTranscript || finalTranscript;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      data-testid="voice-room"
      className={cn(
        "relative mb-3 flex w-full flex-col overflow-hidden rounded-2xl border border-black/10 shadow-xl transition-colors duration-300 dark:border-white/10",
        className,
      )}
      style={{
        backgroundColor: bg,
        color: tone.fg,
        minHeight: "360px",
        maxHeight: "440px",
      }}
    >
      {/* Wave band across the stage */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 overflow-hidden opacity-90">
        {waveEngine === "mesh" ? (
          <VoiceMeshWaves
            getAmplitude={getBandAmplitude}
            color={ink.color}
            peakOpacity={ink.peakOpacity}
            placement="bottom"
            tuning={{ opacityKnee: ink.opacityKnee }}
          />
        ) : (
          <VoiceReactiveWaves
            getAmplitude={getBandAmplitude}
            color={ink.color}
            peakOpacity={ink.peakOpacity}
            placement="bottom"
          />
        )}
      </div>

      {/* Top Bar: Agent Info + Expression Pill + Utility Toggles + Minimize & Close */}
      <div className="relative z-20 flex w-full flex-wrap items-center justify-between gap-2 p-3 sm:px-4">
        {/* Left: Agent chip & phase */}
        <div className="flex items-center gap-2">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold shadow-sm"
            style={{ backgroundColor: tone.wash, color: tone.fg }}
          >
            {identity?.name?.[0] ?? "A"}
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold leading-tight tracking-wide">
              {identity?.name ?? "Amiro"}
            </span>
            <span
              className="text-[10px] leading-tight opacity-75"
              style={{ color: tone.fgMuted }}
            >
              {liveVoicePhaseLabel(phase, muted, assistantAudioActive)}
            </span>
          </div>
        </div>

        {/* Center: Expression selector */}
        <div className="hidden sm:block">
          <ExpressionSelectorPill
            currentOverride={eyeStyleOverride}
            onSelect={setEyeStyleOverride}
          />
        </div>

        {/* Right: Wave toggle + Captions toggle + Minimize + End */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="voice-wave-toggle-button"
                onClick={() =>
                  setWaveEngine(waveEngine === "mesh" ? "reactive" : "mesh")
                }
                aria-label={`Switch to ${waveEngine === "mesh" ? "spline" : "mesh"} waves`}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/15 text-xs transition-colors hover:bg-black/25 dark:bg-white/10 dark:hover:bg-white/20"
              >
                <Waves className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Engine: {waveEngine === "mesh" ? "Oscilloscope Mesh" : "Spline Wave"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="voice-captions-toggle-button"
                onClick={() => setShowCaptions(!showCaptions)}
                aria-label={showCaptions ? "Hide captions" : "Show captions"}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-lg text-xs transition-colors",
                  showCaptions
                    ? "bg-white/25 text-white"
                    : "bg-black/15 opacity-60 hover:opacity-100 dark:bg-white/10",
                )}
              >
                <Subtitles className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showCaptions ? "Captions on" : "Captions off"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="voice-minimize-button"
                onClick={minimizeRoom}
                aria-label="Minimize to composer bar"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/15 transition-colors hover:bg-black/25 dark:bg-white/10 dark:hover:bg-white/20"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Minimize (Esc)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="voice-end-button"
                onClick={endSession}
                aria-label="End voice session"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-500/85 text-white transition-colors hover:bg-red-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">End Voice Mode</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Mobile-only expression selector row */}
      <div className="relative z-20 flex justify-center px-2 sm:hidden">
        <ExpressionSelectorPill
          currentOverride={eyeStyleOverride}
          onSelect={setEyeStyleOverride}
        />
      </div>

      {/* Upper Zone: User live speech pill */}
      <div className="relative z-10 flex min-h-[44px] items-center justify-center px-4 pt-1">
        {showCaptions && displayedUserSpeech && (
          <div
            data-testid="voice-ambient-user"
            className="max-w-[85%] rounded-full bg-black/25 px-4 py-1.5 text-center text-xs font-medium tracking-wide shadow-sm backdrop-blur-md dark:bg-black/40"
            style={{ color: tone.fg }}
          >
            <span className="opacity-90">{displayedUserSpeech}</span>
          </div>
        )}
      </div>

      {/* Center Zone: Character Eyes & Aura Avatar */}
      <div className="relative z-10 my-auto flex flex-1 items-center justify-center py-2">
        <VoiceRoomEyes
          visual={visual}
          mood={mood}
          tone={tone}
          components={components}
          traits={traits}
          customImageUrl={identity?.customImageUrl}
          getAmplitude={getBandAmplitude}
        />
      </div>

      {/* Lower Zone: Ambient word-by-word assistant response or status caption */}
      <div className="relative z-10 flex min-h-[48px] items-center justify-center px-6 pb-2 text-center">
        {showCaptions && assistantWords.length > 0 && replying ? (
          <div
            data-testid="voice-ambient-assistant"
            className="flex max-w-lg flex-wrap items-center justify-center gap-1 text-sm font-medium leading-relaxed drop-shadow-sm"
          >
            {assistantWords.map((word, index) => {
              const isSpoken = index <= spokenWordIndex;
              const isCurrent = index === spokenWordIndex;
              return (
                <span
                  key={`${word}-${index}`}
                  className={cn(
                    "transition-all duration-150",
                    isCurrent
                      ? "rounded bg-white/30 px-1 py-0.5 font-semibold text-white shadow-sm dark:bg-white/20"
                      : isSpoken
                        ? "opacity-95"
                        : "opacity-45",
                  )}
                >
                  {word}
                </span>
              );
            })}
          </div>
        ) : (
          <div
            data-testid="voice-ambient-assistant"
            className="text-xs font-medium tracking-wide opacity-80"
            style={{ color: tone.fgMuted }}
          >
            {liveVoicePhaseLabel(phase, muted, assistantAudioActive)}
          </div>
        )}
      </div>

      {/* Bottom Controls Row */}
      <div className="relative z-20 flex w-full items-center justify-between border-t border-black/5 bg-black/10 px-4 py-2 backdrop-blur-sm dark:border-white/5 dark:bg-black/20">
        <div className="flex items-center gap-2">
          {/* Mic Mute Button */}
          <button
            type="button"
            data-testid="voice-mute-button"
            onClick={toggleMuted}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
              muted
                ? "bg-red-500/25 text-red-200 hover:bg-red-500/35"
                : "bg-black/15 hover:bg-black/25 dark:bg-white/10 dark:hover:bg-white/20",
            )}
          >
            {muted ? (
              <MicOff className="h-3.5 w-3.5" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
            <span>{muted ? "Mic muted" : "Mute mic"}</span>
          </button>

          {/* Assistant Audio Mute Button */}
          <button
            type="button"
            data-testid="voice-output-mute-button"
            onClick={toggleOutputMuted}
            aria-label={outputMuted ? "Unmute speaker" : "Mute speaker"}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
              outputMuted
                ? "bg-red-500/25 text-red-200 hover:bg-red-500/35"
                : "bg-black/15 hover:bg-black/25 dark:bg-white/10 dark:hover:bg-white/20",
            )}
          >
            {outputMuted ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
            <span>{outputMuted ? "Speaker muted" : "Mute speaker"}</span>
          </button>
        </div>

        <div className="text-[11px] opacity-70">
          <span>Press Space to finalize turn • Esc to minimize</span>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ChatBotVoice
 *
 * The non-blocking controller and synchronizer for Amiro's Voice Mode.
 * NO FULL-PAGE BLOCKING DRAWER! Synchronizes appStore.voiceChat.isOpen with useLiveVoiceStore.
 */
export function ChatBotVoice() {
  const [appStoreMutate, voiceChatOpen] = appStore(
    useShallow((state) => [state.mutate, state.voiceChat.isOpen]),
  );

  const active = useLiveVoiceStore((s) => s.active);
  const startSession = useLiveVoiceStore((s) => s.startSession);
  const endSession = useLiveVoiceStore((s) => s.endSession);

  // Mount the live voice audio capture, RMS meters, VAD, STT, and read-aloud controller
  useLiveVoiceController();

  // Sync appStore.voiceChat.isOpen -> useLiveVoiceStore.active
  useEffect(() => {
    if (voiceChatOpen && !active) {
      startSession();
    } else if (!voiceChatOpen && active) {
      endSession();
    }
  }, [voiceChatOpen, active, startSession, endSession]);

  // Sync useLiveVoiceStore.active -> appStore.voiceChat.isOpen
  useEffect(() => {
    if (active !== voiceChatOpen) {
      appStoreMutate((prev) => ({
        voiceChat: {
          ...prev.voiceChat,
          isOpen: active,
        },
      }));
    }
  }, [active, voiceChatOpen, appStoreMutate]);

  // Keyboard shortcut listeners (toggle voice chat, Escape to minimize)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isShortcutEvent(e, Shortcuts.toggleVoiceChat)) {
        e.preventDefault();
        e.stopPropagation();
        const live = useLiveVoiceStore.getState();
        if (live.active) {
          live.endSession();
        } else {
          live.startSession();
        }
        return;
      }

      if (e.key === "Escape") {
        const live = useLiveVoiceStore.getState();
        if (live.active && !live.minimized) {
          e.preventDefault();
          live.minimizeRoom();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // No full page Drawer! Voice Stage renders inline above the composer in prompt-input.
  return null;
}
