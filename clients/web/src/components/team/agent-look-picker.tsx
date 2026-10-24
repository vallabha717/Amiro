"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import {
  AVATAR_COLORS,
  type CharacterTraits,
} from "@/lib/agent/character-catalog";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

/** Body shapes the plush renders; labels live under `Team.shapes`. */
export const AGENT_SHAPES = ["blob", "sprout", "star", "cloud"] as const;

export function accentFor(colorId: string | undefined) {
  return (
    AVATAR_COLORS.find((c) => c.id === colorId)?.hex ??
    AVATAR_COLORS.find((c) => c.id === "orange")!.hex
  );
}

/** Shape and colour radio groups shared by the New agent wizard and the profile. */
export function AgentLookPicker({
  traits,
  onChange,
  disabled,
}: {
  traits: CharacterTraits;
  onChange: (traits: CharacterTraits) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Team");
  const accent = accentFor(traits.color);
  return (
    <div className="space-y-5">
      <fieldset disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">{t("look")}</legend>
        <div className="grid grid-cols-4 gap-2" role="radiogroup">
          {AGENT_SHAPES.map((shape) => {
            const active = traits.bodyShape === shape;
            return (
              <button
                key={shape}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange({ ...traits, bodyShape: shape })}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-2xl py-3 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-accent ring-1 ring-border"
                    : "hover:bg-accent/60",
                )}
                data-testid={`team-shape-${shape}`}
              >
                <AgentCharacterAvatar
                  traits={{ ...traits, bodyShape: shape }}
                  size={52}
                  animated={active}
                  accentColor={accent}
                />
                <span
                  className={cn(
                    "text-xs",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {t(`shapes.${shape}`)}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">{t("colour")}</legend>
        <div className="flex flex-wrap gap-2.5" role="radiogroup">
          {AVATAR_COLORS.map((color) => {
            const active = traits.color === color.id;
            return (
              <button
                key={color.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={t(`colours.${color.id}`)}
                title={t(`colours.${color.id}`)}
                onClick={() => onChange({ ...traits, color: color.id })}
                className={cn(
                  "grid size-8 place-items-center rounded-full transition-transform hover:scale-110",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  active && "ring-2 ring-offset-2 ring-offset-background",
                )}
                style={{
                  background: color.hex,
                  ["--tw-ring-color" as string]: color.hex,
                }}
                data-testid={`team-colour-${color.id}`}
              >
                {active && (
                  <Check className="size-4 text-white" strokeWidth={3} />
                )}
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
