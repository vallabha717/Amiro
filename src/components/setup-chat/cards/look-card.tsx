"use client";

import { AgentLookPicker } from "@/components/team/agent-look-picker";
import type { CharacterTraits } from "@/lib/agent/character-catalog";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";
import { CardActions, ErrorLine, SetupCard, errorText } from "../card-ui";

const NAME_MAX = 32;

export interface TeamAgentDraft {
  name: string;
  role: string;
  instructions: string;
  brain: "copy" | "empty";
}

/**
 * Colour and shape. During onboarding the agent is Amiro and keeps that name;
 * a new Team agent also gets a name, a role, instructions and a brain choice.
 */
export function LookCard({
  mode,
  traits,
  onTraits,
  onSubmit,
}: {
  mode: "onboarding" | "team";
  traits: CharacterTraits;
  onTraits: (traits: CharacterTraits) => void;
  onSubmit: (team: TeamAgentDraft | null) => Promise<void>;
}) {
  const t = useTranslations("SetupChat");
  const [draft, setDraft] = useState<TeamAgentDraft>({
    name: "",
    role: "",
    instructions: "",
    brain: "copy",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = mode === "team";
  const name = draft.name.trim();
  const ready = !team || (name.length > 0 && name.length <= NAME_MAX);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(team ? { ...draft, name } : null);
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(false);
    }
  };

  return (
    <SetupCard testId="setup-look-card">
      <div className="space-y-5">
        {team && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="setup-agent-name">{t("agentName")}</Label>
              <Input
                id="setup-agent-name"
                value={draft.name}
                maxLength={NAME_MAX}
                placeholder={t("agentNamePlaceholder")}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                data-testid="setup-agent-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-agent-role">{t("agentRole")}</Label>
              <Input
                id="setup-agent-role"
                value={draft.role}
                maxLength={80}
                placeholder={t("agentRolePlaceholder")}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                data-testid="setup-agent-role"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="setup-agent-instructions">
                {t("agentInstructions")}
              </Label>
              <Textarea
                id="setup-agent-instructions"
                value={draft.instructions}
                maxLength={4000}
                rows={3}
                placeholder={t("agentInstructionsPlaceholder")}
                onChange={(e) =>
                  setDraft({ ...draft, instructions: e.target.value })
                }
                data-testid="setup-agent-instructions"
              />
            </div>
          </div>
        )}

        <AgentLookPicker traits={traits} onChange={onTraits} disabled={busy} />

        {team && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-1 text-sm font-medium">{t("brain")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["copy", "empty"] as const).map((option) => (
                <label
                  key={option}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors",
                    draft.brain === option
                      ? "border-ring bg-accent/60"
                      : "hover:bg-accent/40",
                  )}
                >
                  <input
                    type="radio"
                    name="setup-agent-brain"
                    value={option}
                    checked={draft.brain === option}
                    onChange={() => setDraft({ ...draft, brain: option })}
                    className="mt-0.5"
                    data-testid={`setup-brain-${option}`}
                  />
                  <span>
                    <span className="block font-medium">
                      {t(option === "copy" ? "brainCopy" : "brainEmpty")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        option === "copy" ? "brainCopyHint" : "brainEmptyHint",
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <ErrorLine error={error} />
      <CardActions>
        <Button
          onClick={submit}
          disabled={!ready || busy}
          data-testid="setup-look-continue"
        >
          {busy ? t("saving") : team ? t("createAgent") : t("thatsMe")}
        </Button>
      </CardActions>
    </SetupCard>
  );
}
