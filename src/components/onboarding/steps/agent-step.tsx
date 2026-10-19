"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { AVATAR_COLORS } from "@/lib/agent/character-catalog";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useState } from "react";
import type { AgentDraft } from "../onboarding-wizard";
import {
  Actions,
  ConfigBadge,
  Eyebrow,
  FieldLabel,
  PrimaryButton,
  QuietButton,
  StepTitle,
  inputClass,
} from "./ui";

export const SHAPES = [
  { id: "blob", label: "Headphones" },
  { id: "sprout", label: "Sprout" },
  { id: "star", label: "Starfish" },
  { id: "cloud", label: "Dreamer" },
] as const;

export function AgentStep({
  draft,
  onChange,
  source,
  onSave,
  onSkip,
}: {
  draft: AgentDraft;
  onChange: (draft: AgentDraft) => void;
  source: string | null;
  onSave: () => Promise<void>;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = draft.name;
  const nameOk = name.trim().length > 0 && name.trim().length <= 32;

  const save = async () => {
    if (!nameOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setBusy(false);
    }
  };

  const setTraits = (patch: Partial<AgentDraft["traits"]>) =>
    onChange({ ...draft, traits: { ...draft.traits, ...patch } });

  return (
    <div>
      <Eyebrow>Your agent</Eyebrow>
      <StepTitle sub="Give it a name and a look. It lives in your sidebar and wears headphones when you talk to it.">
        Meet your agent.
      </StepTitle>
      <ConfigBadge source={source} />

      <div className="space-y-7">
        <div>
          <FieldLabel htmlFor="onb-agent-name">Name</FieldLabel>
          <input
            id="onb-agent-name"
            className={inputClass}
            value={name}
            maxLength={32}
            autoFocus
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && save()}
            data-testid="onboarding-agent-name"
          />
        </div>

        <fieldset>
          <legend className="mb-2.5 text-sm font-medium">Look</legend>
          <div className="grid grid-cols-4 gap-2" role="radiogroup">
            {SHAPES.map((shape) => {
              const active = (draft.traits.bodyShape ?? "blob") === shape.id;
              return (
                <button
                  key={shape.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTraits({ bodyShape: shape.id })}
                  className={cn(
                    "group flex flex-col items-center gap-1 rounded-2xl py-3 transition-all",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)]",
                    active
                      ? "bg-[color-mix(in_oklab,var(--onb-accent)_12%,transparent)] ring-1 ring-[var(--onb-accent)]"
                      : "hover:bg-foreground/[0.04]",
                  )}
                  data-testid={`onboarding-shape-${shape.id}`}
                >
                  <AgentCharacterAvatar
                    traits={{ ...draft.traits, bodyShape: shape.id }}
                    size={56}
                    animated={active}
                    accentColor={
                      AVATAR_COLORS.find((c) => c.id === draft.traits.color)
                        ?.hex
                    }
                  />
                  <span
                    className={cn(
                      "text-xs",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {shape.label}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2.5 text-sm font-medium">Colour</legend>
          <div className="flex flex-wrap gap-2.5" role="radiogroup">
            {AVATAR_COLORS.map((color) => {
              const active = (draft.traits.color ?? "orange") === color.id;
              return (
                <button
                  key={color.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={color.id}
                  title={color.id[0].toUpperCase() + color.id.slice(1)}
                  onClick={() => setTraits({ color: color.id })}
                  className={cn(
                    "grid size-9 place-items-center rounded-full transition-transform hover:scale-110",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-[var(--onb-accent)]",
                    active && "ring-2 ring-offset-2 ring-offset-background",
                  )}
                  style={{
                    background: color.hex,
                    ["--tw-ring-color" as string]: color.hex,
                  }}
                  data-testid={`onboarding-color-${color.id}`}
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

      {error && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {error}
        </p>
      )}

      <Actions>
        <PrimaryButton
          onClick={save}
          disabled={!nameOk}
          loading={busy}
          data-testid="onboarding-agent-continue"
        >
          Continue
        </PrimaryButton>
        <QuietButton onClick={onSkip} data-testid="onboarding-agent-skip">
          Skip for now
        </QuietButton>
      </Actions>
    </div>
  );
}
