"use client";

import { Mic, MicOff, Volume2, VolumeX, X, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toneForBg } from "@/lib/agent/character-catalog";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import {
  type LiveVoicePhase,
  liveVoicePhaseLabel,
} from "@/lib/ai/speech/live-voice-motion";
import {
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  useLiveVoiceStore,
} from "@/lib/ai/speech/live-voice-store";
import {
  BAND_VOICE,
  MESH_INLINE_TUNING,
  VoiceMeshWaves,
} from "./voice-waves";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface VoiceComposerBarProps {
  phase: LiveVoicePhase;
  muted: boolean;
  outputMuted: boolean;
  assistantAudioActive: boolean;
  onToggleMute: () => void;
  onToggleOutputMute: () => void;
  onEnd: () => void;
  onExpand?: () => void;
  accentHex?: string | null;
  className?: string;
}

export function VoiceComposerBar({
  phase,
  muted,
  outputMuted,
  assistantAudioActive,
  onToggleMute,
  onToggleOutputMute,
  onEnd,
  onExpand,
  accentHex,
  className,
}: VoiceComposerBarProps) {
  const bg = accentHex ?? "#1e293b";
  const tone = toneForBg(bg);

  const replying = assistantAudioActive || phase === "speaking";
  const micLive = phase === "listening" && !muted;
  const ink = replying ? BAND_VOICE.responding : BAND_VOICE.listening;

  const getBandAmplitude = replying
    ? getLiveVoiceOutputAmplitude
    : micLive
      ? getLiveVoiceInputAmplitude
      : () => 0;

  const label = liveVoicePhaseLabel(phase, muted, assistantAudioActive);

  return (
    <div
      role="group"
      aria-label="Live Voice Mode"
      data-testid="voice-composer-bar"
      className={cn(
        "relative flex h-10 w-full items-center justify-between gap-1 overflow-hidden rounded-xl px-2.5 shadow-sm transition-all duration-300 sm:h-11",
        className,
      )}
      style={{
        backgroundColor: bg,
        color: tone.fg,
      }}
    >
      {/* Background Mesh Wave Ribbon */}
      <div
        data-testid="voice-session-band"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden opacity-90"
      >
        <VoiceMeshWaves
          getAmplitude={getBandAmplitude}
          color={ink.color}
          peakOpacity={ink.peakOpacity}
          placement="inline"
          tuning={{ ...MESH_INLINE_TUNING, opacityKnee: ink.opacityKnee }}
        />
      </div>

      {/* Screen reader live region */}
      <span className="sr-only" aria-live="polite">
        {label}
      </span>

      {/* Left controls: Mic toggle */}
      <div className="relative z-10 flex shrink-0 items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="voice-mute-button"
              onClick={onToggleMute}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                muted
                  ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                  : "hover:bg-black/10 dark:hover:bg-white/10",
              )}
            >
              {muted ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {muted ? "Unmute mic" : "Mute mic"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Center expand tap target */}
      <button
        type="button"
        onClick={onExpand}
        className="relative z-10 mx-2 flex h-8 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium opacity-90 transition-all hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        title="Expand voice stage"
      >
        <span className="truncate">{label}</span>
        <Maximize2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>

      {/* Right controls: Output mute & End session */}
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="voice-output-mute-button"
              onClick={onToggleOutputMute}
              aria-label={outputMuted ? "Unmute assistant voice" : "Mute assistant voice"}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                outputMuted
                  ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                  : "hover:bg-black/10 dark:hover:bg-white/10",
              )}
            >
              {outputMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {outputMuted ? "Unmute assistant voice" : "Mute assistant voice"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="voice-end-button"
              onClick={onEnd}
              aria-label="End voice session"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/80 text-white transition-colors hover:bg-red-600"
            >
              <X className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">End voice session</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export interface VoiceSessionPillProps {
  active?: boolean;
  className?: string;
}

export function VoiceSessionPill({
  active: activeProp,
  className,
}: VoiceSessionPillProps) {
  const { data: identity } = useAgentIdentity();
  const storeActive = useLiveVoiceStore((s) => s.active);
  const active = activeProp ?? storeActive;
  const phase = useLiveVoiceStore((s) => s.phase);
  const muted = useLiveVoiceStore((s) => s.muted);
  const outputMuted = useLiveVoiceStore((s) => s.outputMuted);
  const assistantAudioActive = useLiveVoiceStore((s) => s.assistantAudioActive);
  const toggleMuted = useLiveVoiceStore((s) => s.toggleMuted);
  const toggleOutputMuted = useLiveVoiceStore((s) => s.toggleOutputMuted);
  const endSession = useLiveVoiceStore((s) => s.endSession);
  const restoreRoom = useLiveVoiceStore((s) => s.restoreRoom);

  if (!active) return null;

  const bg = identity?.accentHex ?? "#1e293b";
  const tone = toneForBg(bg);

  const replying = assistantAudioActive || phase === "speaking";
  const micLive = phase === "listening" && !muted;
  const ink = replying ? BAND_VOICE.responding : BAND_VOICE.listening;

  const getBandAmplitude = replying
    ? getLiveVoiceOutputAmplitude
    : micLive
      ? getLiveVoiceInputAmplitude
      : () => 0;

  const label = liveVoicePhaseLabel(phase, muted, assistantAudioActive);

  return (
    <div
      role="group"
      aria-label="Live Voice Status"
      data-testid="voice-session-pill"
      className={cn(
        "relative flex h-8 w-48 sm:w-56 items-center justify-between gap-1 overflow-hidden rounded-full px-1.5 shadow-sm transition-all duration-300",
        className,
      )}
      style={{
        backgroundColor: bg,
        color: tone.fg,
      }}
    >
      {/* Background Mesh Wave */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden opacity-90"
      >
        <VoiceMeshWaves
          getAmplitude={getBandAmplitude}
          color={ink.color}
          peakOpacity={ink.peakOpacity}
          placement="inline"
          tuning={{ ...MESH_INLINE_TUNING, opacityKnee: ink.opacityKnee }}
        />
      </div>

      {/* Mic toggle */}
      <button
        type="button"
        onClick={toggleMuted}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        className={cn(
          "relative z-10 flex h-6 w-6 items-center justify-center rounded-full transition-colors",
          muted
            ? "bg-red-500/20 text-red-300"
            : "hover:bg-black/10 dark:hover:bg-white/10",
        )}
      >
        {muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
      </button>

      {/* Center expand tap target */}
      <button
        type="button"
        onClick={restoreRoom}
        className="relative z-10 flex flex-1 items-center justify-center truncate px-1 text-[11px] font-medium opacity-90 hover:opacity-100"
        title="Expand voice stage"
      >
        <span className="truncate">{label}</span>
      </button>

      {/* Right controls: Output mute & End */}
      <div className="relative z-10 flex items-center gap-0.5">
        <button
          type="button"
          onClick={toggleOutputMuted}
          aria-label={outputMuted ? "Unmute assistant voice" : "Mute assistant voice"}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full transition-colors",
            outputMuted
              ? "bg-red-500/20 text-red-300"
              : "hover:bg-black/10 dark:hover:bg-white/10",
          )}
        >
          {outputMuted ? (
            <VolumeX className="h-3 w-3" />
          ) : (
            <Volume2 className="h-3 w-3" />
          )}
        </button>

        <button
          type="button"
          onClick={endSession}
          aria-label="End voice session"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500/80 text-white transition-colors hover:bg-red-600"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
