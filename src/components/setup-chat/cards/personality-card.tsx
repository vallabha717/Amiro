"use client";

import { PRESET_PERSONAS } from "@/components/agent/agent-personality-studio";
import {
  updateAgentPersonality,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import {
  DEFAULT_PERSONALITY_SLIDERS,
  PERSONALITY_AXES,
  PERSONALITY_AXIS_DEFAULT,
} from "@/lib/agent/character-catalog";
import { cn } from "@/lib/utils";
import { Wand2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "ui/button";
import { CardActions, ErrorLine, SetupCard, errorText } from "../card-ui";

/** The dials from the Personality page, saved to the same place. */
export function PersonalityCard({
  agentName,
  onSaved,
  onSkip,
}: {
  agentName: string;
  onSaved: (summary: string) => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const invalidate = useInvalidateAgentIdentity();
  const [values, setValues] = useState<Record<string, number>>({
    ...DEFAULT_PERSONALITY_SLIDERS,
  });
  const [preset, setPreset] = useState<string | null>("balanced");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const identity = await updateAgentPersonality({
        sliders: values,
        name: agentName,
      });
      await invalidate();
      onSaved(
        preset ? t(`presets.${preset}`) : identity.personalitySummary || "",
      );
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(false);
    }
  };

  return (
    <SetupCard testId="setup-personality-card">
      <div className="flex flex-wrap gap-1.5">
        {PRESET_PERSONAS.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={busy}
            onClick={() => {
              setValues({ ...p.values });
              setPreset(p.id);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors",
              preset === p.id
                ? "border-ring bg-accent font-medium"
                : "hover:bg-accent/60",
            )}
            aria-pressed={preset === p.id}
            data-testid={`setup-preset-${p.id}`}
          >
            <Wand2 className="size-3" aria-hidden />
            {t(`presets.${p.id}`)}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        {PERSONALITY_AXES.map((axis) => {
          const value = values[axis.id] ?? PERSONALITY_AXIS_DEFAULT;
          const left = t(`axes.${axis.id}.left`);
          const right = t(`axes.${axis.id}.right`);
          return (
            <div
              key={axis.id}
              className="grid grid-cols-[6.5rem_1fr_6.5rem] items-center gap-3 text-xs sm:text-sm"
            >
              <span className={cn("text-right", value < 45 && "font-semibold")}>
                {left}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={value}
                disabled={busy}
                onChange={(e) => {
                  setValues({ ...values, [axis.id]: Number(e.target.value) });
                  setPreset(null);
                }}
                aria-label={t("axisLabel", { left, right })}
                className="w-full accent-[var(--setup-accent)]"
                data-testid={`setup-slider-${axis.id}`}
              />
              <span className={cn(value > 55 && "font-semibold")}>{right}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        {t("personalityNote")}
      </p>
      <ErrorLine error={error} />
      <CardActions onSkip={onSkip} skipLabel={t("keepDefault")} busy={busy}>
        <Button
          onClick={save}
          disabled={busy}
          data-testid="setup-personality-save"
        >
          {busy ? t("saving") : t("savePersonality")}
        </Button>
      </CardActions>
    </SetupCard>
  );
}
