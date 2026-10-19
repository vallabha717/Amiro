"use client";

import {
  LATER,
  type OnboardingState,
  type OnboardingStepId,
} from "@/lib/onboarding/onboarding-api";
import { cn } from "@/lib/utils";
import { Check, CornerDownRight } from "lucide-react";
import { useState } from "react";
import { Actions, Eyebrow, Kbd, PrimaryButton, StepTitle } from "./ui";

export function ReadyStep({
  agentName,
  ownerName,
  login,
  mode,
  skipped,
  onboarding,
  onFinish,
  onRevisit,
}: {
  agentName: string;
  ownerName: string;
  login: string;
  mode: string;
  skipped: OnboardingStepId[];
  onboarding?: OnboardingState;
  onFinish: () => Promise<void>;
  onRevisit: (step: OnboardingStepId) => void;
}) {
  const [busy, setBusy] = useState(false);
  const steps = onboarding?.steps;
  const rows: Array<{ id: OnboardingStepId; label: string; done: boolean }> = [
    {
      id: "account",
      label: login ? `Signed in as ${login}` : "Your account",
      done: true,
    },
    {
      id: "agent",
      label: `${agentName} has a name and a look`,
      done: !skipped.includes("agent") || !!steps?.agent.done,
    },
    {
      id: "provider",
      label: "A provider is connected",
      done: !skipped.includes("provider") || !!steps?.provider.done,
    },
  ];
  const providerMissing = !rows[2].done;

  return (
    <div>
      <Eyebrow>All set</Eyebrow>
      <StepTitle
        sub={
          providerMissing
            ? `${agentName} can't reply until a provider is connected. You can do that whenever you're ready.`
            : `${agentName} is ready when you are${ownerName ? `, ${ownerName}` : ""}.`
        }
      >
        Say hi to {agentName}.
      </StepTitle>

      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                row.done
                  ? "bg-[var(--onb-accent)] text-[var(--onb-on-accent,#fff)]"
                  : "border border-dashed border-foreground/30",
              )}
            >
              {row.done && <Check className="size-3" strokeWidth={3} />}
            </span>
            <div className="text-[15px]">
              <p className={cn(!row.done && "text-muted-foreground")}>
                {row.done ? row.label : `${LATER[row.id].title}: skipped`}
              </p>
              {!row.done && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CornerDownRight className="size-3" />
                  Later in{" "}
                  <span className="text-foreground">{LATER[row.id].place}</span>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    onClick={() => onRevisit(row.id)}
                    className="text-[var(--onb-accent)] hover:underline underline-offset-4"
                  >
                    Do it now
                  </button>
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Actions>
        <PrimaryButton
          autoFocus
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onFinish();
            } catch {
              setBusy(false);
            }
          }}
          data-testid="onboarding-finish"
        >
          Start chatting
        </PrimaryButton>
      </Actions>

      <details className="group mt-10 text-xs text-muted-foreground">
        <summary className="cursor-pointer list-none hover:text-foreground">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span> Good to know
        </summary>
        <ul className="mt-3 space-y-2 leading-relaxed">
          {mode === "vm-remote" && onboarding?.deployment.accessUrls?.length ? (
            <li>
              Open Amiro from anywhere on your network at{" "}
              <Kbd>{onboarding.deployment.accessUrls.at(-1)}</Kbd>.
            </li>
          ) : null}
          <li>
            Forgot your password? On the machine running Amiro, run{" "}
            <Kbd>amiro-backend reset-password</Kbd>.
          </li>
          <li>
            Every choice here can also live in <Kbd>~/.amiro/amiro.toml</Kbd>{" "}
            (run <Kbd>amiro-backend init-config</Kbd> for a commented starter).
          </li>
          <li>
            Run this setup again any time from{" "}
            <span className="text-foreground">Admin → General</span>.
          </li>
        </ul>
      </details>
    </div>
  );
}
