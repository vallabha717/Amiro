"use client";

import {
  SETUP_STEPS,
  type SetupTurn,
  skippedSteps,
} from "@/lib/onboarding/setup-flow";
import { cn } from "@/lib/utils";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Button } from "ui/button";
import { CardActions, ErrorLine, SetupCard, errorText } from "../card-ui";
import { LiveVoiceNote } from "./voice-cards";

const code = (chunks: ReactNode) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.95em] text-foreground">
    {chunks}
  </code>
);

/** What was set up and what was left for later, then the way in. */
export function DoneCard({
  mode,
  name,
  turns,
  accessUrl,
  onFinish,
}: {
  mode: "onboarding" | "team";
  name: string;
  turns: SetupTurn[];
  /** Where Amiro is reachable on the network (a VM install), for onboarding. */
  accessUrl?: string;
  onFinish: () => Promise<void>;
}) {
  const t = useTranslations("SetupChat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipped = new Set(skippedSteps(turns));
  const steps = SETUP_STEPS.filter((s) => s !== "greet" && s !== "done");

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await onFinish();
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(false);
    }
  };

  return (
    <SetupCard testId="setup-done-card">
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {steps.map((step) => {
          const later = skipped.has(step);
          return (
            <li
              key={step}
              className={cn(
                "flex items-center gap-2 text-sm",
                later && "text-muted-foreground",
              )}
              data-testid={`setup-summary-${step}`}
              data-state={later ? "later" : "done"}
            >
              {later ? (
                <CircleDashed className="size-4" aria-hidden />
              ) : (
                <CheckCircle2
                  className="size-4 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
              )}
              <span>{t(`steps.${step}`)}</span>
              {later && <span className="text-xs">· {t("later")}</span>}
            </li>
          );
        })}
      </ul>
      <LiveVoiceNote />
      {skipped.size > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">{t("laterHint")}</p>
      )}
      {mode === "onboarding" && (
        <details
          className="mt-4 text-xs text-muted-foreground"
          data-testid="setup-good-to-know"
        >
          <summary className="cursor-pointer hover:text-foreground">
            {t("goodToKnow")}
          </summary>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 leading-relaxed">
            {accessUrl && (
              <li>{t.rich("accessAt", { url: accessUrl, code })}</li>
            )}
            <li>{t.rich("resetPassword", { code })}</li>
            <li>{t.rich("configFile", { code })}</li>
            <li>{t("runAgain")}</li>
          </ul>
        </details>
      )}
      <ErrorLine error={error} />
      <CardActions>
        <Button onClick={finish} disabled={busy} data-testid="setup-finish">
          {busy
            ? t("saving")
            : mode === "team"
              ? t("finishTeam", { name })
              : t("finish", { name })}
        </Button>
      </CardActions>
    </SetupCard>
  );
}
