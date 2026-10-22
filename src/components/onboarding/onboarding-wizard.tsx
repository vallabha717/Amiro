"use client";

import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { SetupChat, type SetupResult } from "@/components/setup-chat/setup-chat";
import { VoiceMascot } from "@/components/voice-room/voice-mascot";
import { useAuthStatus } from "@/hooks/queries/use-auth-status";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  AVATAR_COLORS,
  type CharacterTraits,
  DEFAULT_CHARACTER_TRAITS,
} from "@/lib/agent/character-catalog";
import { ApiError } from "@/lib/backend/client";
import { setupOwner, useSession } from "@/lib/backend/session-context";
import {
  type OnboardingStepId,
  completeOnboarding,
  detectTimezone,
  useOnboarding,
} from "@/lib/onboarding/onboarding-api";
import { cn } from "@/lib/utils";
import type { VoicePhase } from "@/lib/voice/voice-store";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AccountStep } from "./steps/account-step";
import { WelcomeStep } from "./steps/welcome-step";

type Step = "welcome" | "account" | "chat";

const DEFAULT_TRAITS: CharacterTraits = {
  ...DEFAULT_CHARACTER_TRAITS,
  color: "orange",
};

export function hexForColor(color?: string) {
  return (
    AVATAR_COLORS.find((c) => c.id === color)?.hex ??
    AVATAR_COLORS.find((c) => c.id === "orange")!.hex
  );
}

/**
 * The first-run wizard, for the web UI and the desktop app alike.
 *
 * Fresh instance: welcome → account (the only required step) → the setup
 * chat, where Amiro streams one step at a time: look, default prompt,
 * personality, AI provider, web search, connectors, voice
 * (components/setup-chat). An owner provisioned from amiro.toml/.env signs in
 * first and lands straight in the chat. Everything in the chat can be
 * skipped; the sidebar checklist says where to finish it later.
 */
export function OnboardingWizard() {
  const router = useRouter();
  const reduce = usePrefersReducedMotion();
  const { data: session, isPending } = useSession();
  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const signedIn = !!session;
  const { data: onboarding, mutate: refresh } = useOnboarding(signedIn);

  const [step, setStep] = useState<Step | null>(null);
  const [phase, setPhase] = useState<VoicePhase>("listening");
  const [ownerName, setOwnerName] = useState("");

  // Not signed in and the instance already has an owner (for example one
  // provisioned from amiro.toml): sign in first, then come back here.
  useEffect(() => {
    if (isPending || statusLoading) return;
    if (!signedIn && authStatus && !authStatus.needsSetup) {
      router.replace("/sign-in");
    }
  }, [isPending, statusLoading, signedIn, authStatus, router]);

  // Pick the starting step once we know enough.
  useEffect(() => {
    if (step !== null || isPending || statusLoading) return;
    if (!signedIn) {
      if (authStatus?.needsSetup) setStep("welcome");
      return;
    }
    if (!onboarding) return;
    // Members, and an owner who already finished setup, belong on Team.
    if (!onboarding.isOwner || onboarding.completed) {
      router.replace("/team");
      return;
    }
    setOwnerName(onboarding.steps.account.name ?? "");
    setStep("chat");
  }, [step, isPending, statusLoading, signedIn, authStatus, onboarding, router]);

  const createAccount = async (input: {
    name: string;
    login: string;
    password: string;
    timezone: string;
  }) => {
    setPhase("thinking");
    try {
      await setupOwner(
        input.login,
        input.password,
        input.name || undefined,
        input.timezone,
      );
      setOwnerName(input.name);
      await refresh();
      setStep("chat");
    } catch (error) {
      setPhase("error");
      throw error instanceof ApiError || error instanceof Error
        ? error
        : new Error("Could not create the account.");
    }
  };

  const finish = async ({ skipped }: SetupResult) => {
    // Of the chat's steps, only the provider is an onboarding step the
    // sidebar checklist tracks.
    const later: OnboardingStepId[] = skipped.includes("provider")
      ? ["provider"]
      : [];
    await completeOnboarding(later);
    // Land on the Team view with the onboarded agent's channel open.
    router.replace("/team");
  };

  const agent = onboarding?.steps.agent;
  const traits = useMemo<CharacterTraits>(
    () =>
      agent?.done
        ? { ...DEFAULT_TRAITS, ...(agent.traits as object) }
        : DEFAULT_TRAITS,
    [agent],
  );
  const agentName = agent?.name || "Amiro";
  const mode =
    onboarding?.deployment.mode ?? authStatus?.mode ?? "local-server";

  if (!step) {
    return <div className="min-h-dvh bg-background" aria-busy="true" />;
  }

  if (step === "chat") {
    return (
      <div
        className="relative flex h-dvh flex-col bg-background text-foreground"
        data-testid="onboarding-wizard"
        data-step="chat"
      >
        {/* Floats over the chat's own background: one seamless surface. */}
        <header className="pointer-events-none absolute left-0 top-0 z-10 hidden h-14 items-center gap-2 px-5 sm:px-8 xl:flex">
          <VrndaLogo className="size-6 shrink-0" />
          <span className="font-brand font-bold text-2xl tracking-tight">Amiro</span>
        </header>
        <main className="min-h-0 flex-1">
          <h1 className="sr-only">{`Set up ${agentName}`}</h1>
          <SetupChat
            mode="onboarding"
            agentName={agentName}
            ownerName={ownerName.trim().split(/\s+/)[0] || undefined}
            initialTraits={traits}
            accessUrl={
              mode === "vm-remote"
                ? onboarding?.deployment.accessUrls?.at(-1)
                : undefined
            }
            onFinish={finish}
          />
        </main>
      </div>
    );
  }

  const accent = hexForColor(DEFAULT_TRAITS.color);
  return (
    <div
      className="onb-root relative min-h-dvh overflow-hidden bg-background text-foreground"
      style={{ "--onb-accent": accent } as React.CSSProperties}
      data-testid="onboarding-wizard"
      data-step={step}
    >
      {/* Ambient light tinted by the agent's colour. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className={cn(
            "absolute left-1/2 top-[-10%] h-[70vh] w-[70vh] -translate-x-1/2 rounded-full opacity-[0.18] blur-3xl lg:left-[72%] lg:top-[12%]",
            !reduce && "onb-drift",
          )}
          style={{
            background:
              "radial-gradient(circle, var(--onb-accent), transparent 65%)",
          }}
        />
      </div>

      <header className="relative z-10 flex h-16 items-center px-5 sm:px-8">
        <div className="flex items-center gap-2">
          <VrndaLogo className="size-6 shrink-0" />
          <span className="font-brand font-bold text-2xl tracking-tight">Amiro</span>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-6xl items-center gap-6 px-5 pb-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-16">
        <section className="order-2 w-full max-w-[30rem] lg:order-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: 28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -28 }}
              transition={{ duration: reduce ? 0.12 : 0.32, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === "welcome" && (
                <WelcomeStep mode={mode} onStart={() => setStep("account")} />
              )}
              {step === "account" && (
                <AccountStep
                  defaultTimezone={detectTimezone()}
                  onTyping={(typing) => setPhase(typing ? "hearing" : "listening")}
                  onSubmit={createAccount}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </section>

        <aside
          className={cn(
            "order-1 flex flex-col items-center justify-center lg:order-2",
            step === "account" && "max-lg:hidden",
          )}
          aria-hidden
        >
          <VoiceMascot
            phase={phase}
            traits={DEFAULT_TRAITS}
            accent={accent}
            size={step === "welcome" ? 300 : 240}
          />
        </aside>
      </main>

      <style>{ONBOARDING_CSS}</style>
    </div>
  );
}

const ONBOARDING_CSS = `
@keyframes onb-drift {
  0%, 100% { transform: translate(-50%, 0) scale(1); }
  50% { transform: translate(-46%, 4%) scale(1.06); }
}
.onb-drift { animation: onb-drift 18s ease-in-out infinite; }
.onb-root ::selection { background: color-mix(in oklab, var(--onb-accent) 30%, transparent); }
`;
