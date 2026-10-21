"use client";

import {
  DEFAULT_CHARACTER_TRAITS,
  type CharacterTraits,
} from "@/lib/agent/character-catalog";
import {
  AGENTS_KEY,
  createAgent,
  teamPath,
} from "@/lib/backend/agents-api";
import { useSession } from "@/lib/backend/session-context";
import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";
import { AgentLookPicker, accentFor } from "./agent-look-picker";
import { AgentAvatar } from "./agent-avatar";

type Step = "look" | "role";

const NAME_MAX = 32;

/**
 * Two short steps — who the agent is, then what it does — and it exists, with
 * its own folder and channel. Everything else is personalised on its page.
 */
export function NewAgentWizard() {
  const t = useTranslations("Team");
  const router = useRouter();
  const { data: session } = useSession();
  const [step, setStep] = useState<Step>("look");
  const [name, setName] = useState("");
  const [traits, setTraits] = useState<CharacterTraits>({
    ...DEFAULT_CHARACTER_TRAITS,
    bodyShape: "sprout",
    color: "teal",
  });
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session && session.user.role !== "admin") {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">{t("newAgentTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("ownerOnly")}</p>
      </div>
    );
  }

  const trimmed = name.trim();
  const nameOk = trimmed.length > 0 && trimmed.length <= NAME_MAX;
  const preview = { traits, accentHex: accentFor(traits.color) };

  const create = async () => {
    if (!nameOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await createAgent({
        name: trimmed,
        role: role.trim(),
        instructions: instructions.trim(),
        traits,
      });
      await mutate(AGENTS_KEY);
      toast.success(t("created", { name: agent.name }));
      router.push(teamPath(agent.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createError"));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 md:py-10">
      <Link
        href="/team"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t("backToTeam")}
      </Link>

      <div className="rounded-2xl border bg-card p-6 shadow-panel md:p-8">
        <div className="mb-6 flex items-center gap-4">
          <AgentAvatar agent={preview} size={72} animated />
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("stepOf", { step: step === "look" ? 1 : 2, total: 2 })}
            </p>
            <h1 className="truncate text-xl font-semibold">
              {trimmed || t("newAgentTitle")}
            </h1>
          </div>
        </div>

        {step === "look" ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="team-agent-name">{t("name")}</Label>
              <Input
                id="team-agent-name"
                value={name}
                maxLength={NAME_MAX}
                autoFocus
                placeholder={t("namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameOk) setStep("role");
                }}
                data-testid="team-agent-name"
              />
            </div>
            <AgentLookPicker traits={traits} onChange={setTraits} />
            <div className="flex justify-end">
              <Button
                onClick={() => setStep("role")}
                disabled={!nameOk}
                data-testid="team-wizard-next"
              >
                {t("next")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="team-agent-role">{t("role")}</Label>
              <Input
                id="team-agent-role"
                value={role}
                maxLength={80}
                autoFocus
                placeholder={t("rolePlaceholder")}
                onChange={(e) => setRole(e.target.value)}
                data-testid="team-agent-role"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="team-agent-instructions">
                {t("instructions")}
              </Label>
              <Textarea
                id="team-agent-instructions"
                value={instructions}
                maxLength={4000}
                rows={5}
                placeholder={t("instructionsPlaceholder")}
                onChange={(e) => setInstructions(e.target.value)}
                data-testid="team-agent-instructions"
              />
              <p className="text-xs text-muted-foreground">
                {t("instructionsHint")}
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => setStep("look")}
                disabled={busy}
              >
                {t("back")}
              </Button>
              <Button
                onClick={create}
                disabled={!nameOk || busy}
                data-testid="team-wizard-create"
              >
                {busy ? t("creating") : t("create")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
