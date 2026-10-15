"use client";

import { useState, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  useAgentIdentity,
  updateAgentPersonality,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import {
  DEFAULT_CHARACTER_TRAITS,
  DEFAULT_PERSONALITY_SLIDERS,
  PERSONALITY_AXES,
  PERSONALITY_AXIS_DEFAULT,
  summarizePersonality,
  type AvatarTone,
  type PersonalityAxisDefinition,
} from "@/lib/agent/character-catalog";
import {
  AssistantStage,
  PersonalitySignature,
  useAssistantStage,
} from "./avatar-primitives";

const PRESET_PERSONAS: Array<{
  id: string;
  label: string;
  values: Record<string, number>;
}> = [
  {
    id: "operator",
    label: "Sharp Operator",
    values: {
      companionCoworker: 82,
      genzBoomer: 48,
      executeCollaborate: 20,
      playfulSerious: 72,
      politeUnfiltered: 76,
    },
  },
  {
    id: "companion",
    label: "Warm Companion",
    values: {
      companionCoworker: 22,
      genzBoomer: 35,
      executeCollaborate: 68,
      playfulSerious: 28,
      politeUnfiltered: 30,
    },
  },
  {
    id: "hacker",
    label: "Unfiltered Co-Founder",
    values: {
      companionCoworker: 65,
      genzBoomer: 24,
      executeCollaborate: 18,
      playfulSerious: 40,
      politeUnfiltered: 88,
    },
  },
  {
    id: "balanced",
    label: "Balanced Neutral",
    values: {
      companionCoworker: 50,
      genzBoomer: 50,
      executeCollaborate: 50,
      playfulSerious: 50,
      politeUnfiltered: 50,
    },
  },
];

// A deterministic illustration of the dial settings, written here in the page
// itself. It is NOT a recording of the agent and NOT a live model response, so
// the UI labels it as an illustrative sample rather than a "live voice".
function buildIllustrativeSample(
  name: string,
  values: Record<string, number>,
): string {
  const cw = values.companionCoworker ?? 50;
  const gb = values.genzBoomer ?? 50;
  const ec = values.executeCollaborate ?? 50;
  const ps = values.playfulSerious ?? 50;
  const pu = values.politeUnfiltered ?? 50;

  const opener =
    pu > 68
      ? "Skip the ceremony."
      : cw < 38
        ? `Hey, ${name} here with you.`
        : gb < 35
          ? "Locked in."
          : `Ready when you are.`;

  const actionClause =
    ec < 40
      ? "I’ll run the checks, wire the fix, and only ping you with verified proof."
      : "Let’s map out the trade-offs together before we touch the repo.";

  const toneClause =
    ps < 38
      ? "No stiff corporate prose, just fast momentum."
      : ps > 65
        ? "Every claim backed by measured numbers and exact file lines."
        : "Clear, direct, and calibrated to how you work.";

  return `“${opener} ${actionClause} ${toneClause}”`;
}

function BipolarSliderRow({
  axis,
  value,
  onValueChange,
  tone,
  disabled,
}: {
  axis: PersonalityAxisDefinition;
  value: number;
  onValueChange: (next: number) => void;
  tone: AvatarTone;
  disabled: boolean;
}) {
  const lean = value - 50;
  const isNeutral = Math.abs(lean) <= 5;
  const activePole = isNeutral ? null : lean < 0 ? "left" : "right";

  return (
    <div
      data-testid={`personality-slider-row-${axis.id}`}
      className="flex w-full shrink-0 flex-wrap items-center gap-x-5 gap-y-2 sm:flex-nowrap"
      style={{ opacity: disabled ? 0.7 : 1 }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onValueChange(Math.max(0, value - 15))}
        className="order-1 flex-1 cursor-pointer text-left text-sm transition-opacity sm:w-36 sm:flex-none sm:text-right sm:text-[16px]"
        style={{
          color: tone.fg,
          fontWeight: activePole === "left" ? 600 : 400,
          opacity: activePole === "right" ? 0.62 : 1,
        }}
      >
        {axis.leftLabel}
      </button>

      <div className="relative order-3 flex h-7 w-full items-center sm:order-2 sm:w-auto sm:flex-1">
        {/* Track background */}
        <div
          className="pointer-events-none relative h-2.5 w-full overflow-hidden rounded-full sm:h-3"
          style={{
            backgroundColor: tone.isLight
              ? "rgba(20, 20, 19, 0.18)"
              : "rgba(0, 0, 0, 0.28)",
          }}
        >
          {/* Center tick mark at 50 */}
          <div
            className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2"
            style={{
              backgroundColor: tone.isLight
                ? "rgba(20, 20, 19, 0.35)"
                : "rgba(255, 255, 255, 0.38)",
            }}
          />
          {/* Active bipolar fill from 50% toward thumb */}
          <div
            className="absolute top-0 bottom-0 rounded-full transition-all duration-75"
            style={{
              left: `${Math.min(50, value)}%`,
              width: `${Math.abs(value - 50)}%`,
              backgroundColor: tone.isLight
                ? "rgba(20, 20, 19, 0.65)"
                : "rgba(253, 253, 252, 0.78)",
            }}
          />
        </div>

        {/* Native range input for rock-solid keyboard + pointer + Playwright drag/fill */}
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          value={value}
          aria-label={`${axis.leftLabel} to ${axis.rightLabel}`}
          data-testid={`personality-slider-${axis.id}`}
          onChange={(e) =>
            onValueChange(Number(e.target.value ?? PERSONALITY_AXIS_DEFAULT))
          }
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />

        {/* Visual Thumb */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md transition-[left,transform] duration-75 sm:size-6"
          style={{
            left: `${value}%`,
            backgroundColor: "#FDFDFC",
            border: "2px solid rgba(20, 20, 19, 0.2)",
          }}
        />
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onValueChange(Math.min(100, value + 15))}
        className="order-2 flex-1 cursor-pointer text-right text-sm transition-opacity sm:order-3 sm:w-36 sm:flex-none sm:text-left sm:text-[16px]"
        style={{
          color: tone.fg,
          fontWeight: activePole === "right" ? 600 : 400,
          opacity: activePole === "left" ? 0.62 : 1,
        }}
      >
        {axis.rightLabel}
      </button>
    </div>
  );
}

function PersonalityStudioBody({
  assistantName,
  values,
  onValueChange,
  onApplyPreset,
  applying,
  onUpdate,
  onBack,
}: {
  assistantName: string;
  values: Record<string, number>;
  onValueChange: (axisId: string, next: number) => void;
  onApplyPreset: (presetValues: Record<string, number>) => void;
  applying: boolean;
  onUpdate: () => void;
  onBack: () => void;
}) {
  const { tone, bottomReserve } = useAssistantStage();
  const washClasses = tone.isLight
    ? "bg-black/10 hover:bg-black/20"
    : "bg-white/12 hover:bg-white/22";

  const summary = useMemo(() => summarizePersonality(values), [values]);
  const sampleVoice = useMemo(
    () => buildIllustrativeSample(assistantName, values),
    [assistantName, values],
  );

  return (
    <>
      <div className="flex items-center justify-between px-6 pt-5">
        <button
          type="button"
          onClick={onBack}
          data-testid="personality-back-button"
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full py-2 pr-4 pl-3 text-sm font-medium backdrop-blur-md transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 ${washClasses}`}
          style={{ color: tone.fg }}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to Agent
        </button>

        <button
          type="button"
          onClick={() =>
            onApplyPreset({
              companionCoworker: 50,
              genzBoomer: 50,
              executeCollaborate: 50,
              playfulSerious: 50,
              politeUnfiltered: 50,
            })
          }
          disabled={applying}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium backdrop-blur-md transition-transform duration-150 active:scale-95 ${washClasses}`}
          style={{ color: tone.fg }}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Center all dials
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-4"
        style={{ paddingBottom: Math.max(bottomReserve, 120) }}
      >
        {/* Title & Subtitle */}
        <div className="flex shrink-0 flex-col items-center gap-2 text-center">
          <h1
            data-testid="personality-studio-title"
            className="font-brand text-3xl leading-none font-semibold tracking-tight sm:text-[2.6rem]"
            style={{ color: tone.fg }}
          >
            Shape my personality
          </h1>
          <p
            className="max-w-lg text-sm sm:text-[15px]"
            style={{ color: tone.fgMuted }}
          >
            Slide the dials, then hit update. I’ll save your calibration and use
            it to shape how I write in chat.
          </p>
          <p
            data-testid="personality-permissions-note"
            className="max-w-lg text-xs sm:text-[13px]"
            style={{ color: tone.fgMuted }}
          >
            These dials change tone and style only. They never change tool
            permissions, approvals, or safety policy.
          </p>
        </div>

        {/* Archetype Preset Pills */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {PRESET_PERSONAS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={applying}
              data-testid={`personality-preset-${preset.id}`}
              onClick={() => onApplyPreset(preset.values)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium backdrop-blur-sm transition-transform active:scale-95 ${washClasses}`}
              style={{ color: tone.fg }}
            >
              <Wand2 className="size-3" aria-hidden="true" />
              {preset.label}
            </button>
          ))}
        </div>

        {/* Five Bipolar Sliders */}
        <div className="mt-7 flex w-full max-w-2xl shrink-0 flex-col">
          {PERSONALITY_AXES.map((axis, i) => (
            <Fragment key={axis.id}>
              {i > 0 && <div className="h-5 sm:h-7" />}
              <BipolarSliderRow
                axis={axis}
                value={values[axis.id] ?? PERSONALITY_AXIS_DEFAULT}
                onValueChange={(next) => onValueChange(axis.id, next)}
                tone={tone}
                disabled={applying}
              />
            </Fragment>
          ))}
        </div>

        {/* Live Voice Calibration & Compact Signature Preview */}
        <div
          data-testid="personality-live-preview"
          className="mt-7 grid w-full max-w-2xl grid-cols-1 items-center gap-4 rounded-2xl px-5 py-4 backdrop-blur-md sm:grid-cols-12"
          style={{
            backgroundColor: tone.isLight
              ? "rgba(20, 20, 19, 0.08)"
              : "rgba(0, 0, 0, 0.22)",
            border: `1px solid ${tone.border}`,
          }}
        >
          <div className="sm:col-span-7">
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] font-semibold tracking-wide uppercase"
                style={{ color: tone.fgMuted }}
              >
                Illustrative tone sample · {summary}
              </span>
            </div>
            <p
              className="mt-1.5 font-brand text-sm leading-relaxed italic"
              style={{ color: tone.fg }}
            >
              {sampleVoice}
            </p>
            <p
              className="mt-1.5 text-[11px]"
              style={{ color: tone.fgMuted }}
            >
              Written into this page from the dial settings, not recorded from or
              generated by your agent.
            </p>
          </div>
          <div
            className="sm:col-span-5"
            style={{ color: tone.fg }}
          >
            <PersonalitySignature
              values={values}
              compact
              accentColor={tone.fg}
              className="h-auto w-full"
            />
          </div>
        </div>

        {/* Primary CTA: Update personality */}
        <div className="mt-7 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onUpdate}
            disabled={applying}
            data-testid="personality-update-button"
            className="flex min-h-11 min-w-[250px] cursor-pointer items-center justify-center gap-2 rounded-xl px-7 py-2.5 text-sm font-semibold shadow-lg transition-transform duration-150 active:scale-[0.97] disabled:cursor-default disabled:opacity-80"
            style={{
              backgroundColor: tone.isLight ? "#141413" : "#FDFDFC",
              color: tone.isLight ? "#FDFDFC" : "#141413",
            }}
          >
            <Sparkles className="size-4" aria-hidden="true" />
            {applying
              ? `Updating ${assistantName}’s personality…`
              : "Update personality"}
          </button>
        </div>
      </div>
    </>
  );
}

export function AgentPersonalityStudio() {
  const router = useRouter();
  const { data: identity } = useAgentIdentity();
  const invalidate = useInvalidateAgentIdentity();

  const [edits, setEdits] = useState<Record<string, number> | null>(null);
  const [applying, setApplying] = useState(false);

  const values = edits ?? identity?.sliders ?? DEFAULT_PERSONALITY_SLIDERS;
  const assistantName = identity?.name || "Amiro";
  const traits = identity?.traits ?? DEFAULT_CHARACTER_TRAITS;
  const accentHex = identity?.accentHex || "#E9642F";

  const handleUpdate = async () => {
    setApplying(true);
    try {
      await updateAgentPersonality({
        sliders: values,
        name: assistantName,
      });
      await invalidate();
      toast.success("Personality updated. It applies to your next message.");
      router.push("/agent");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "The personality update didn’t go through. Please try again.",
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      data-testid="agent-personality-page"
      className="flex h-full min-h-0 w-full flex-1 flex-col p-3 sm:p-5"
    >
      <AssistantStage
        traits={traits}
        customImageUrl={identity?.customImageUrl ?? null}
        accentHex={accentHex}
        entrance
        className="rounded-3xl shadow-xl"
      >
        <PersonalityStudioBody
          assistantName={assistantName}
          values={values}
          onValueChange={(axisId, next) =>
            setEdits({ ...values, [axisId]: next })
          }
          onApplyPreset={(presetValues) => setEdits({ ...presetValues })}
          applying={applying}
          onUpdate={() => void handleUpdate()}
          onBack={() => router.push("/agent")}
        />
      </AssistantStage>
    </div>
  );
}
