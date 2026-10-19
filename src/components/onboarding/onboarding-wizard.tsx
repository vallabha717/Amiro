"use client";

import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { VoiceMascot } from "@/components/voice-room/voice-mascot";
import {
  updateAgentIdentity,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import { useAuthStatus } from "@/hooks/queries/use-auth-status";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useThemeStyle } from "@/hooks/use-theme-style";
import {
  AVATAR_COLORS,
  COLOR_TO_SIDEBAR_THEME,
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
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountStep } from "./steps/account-step";
import { AgentStep } from "./steps/agent-step";
import { ProviderStep } from "./steps/provider-step";
import { ReadyStep } from "./steps/ready-step";
import { WelcomeStep } from "./steps/welcome-step";

type Step = "welcome" | "account" | OnboardingStepId | "ready";
const ORDER: Step[] = ["welcome", "account", "agent", "provider", "ready"];
/** The steps the progress bar counts (welcome is the cover). */
const TRACKED: Step[] = ["account", "agent", "provider", "ready"];
const TRACKED_LABEL: Record<string, string> = {
  account: "You",
  agent: "Your agent",
  provider: "Brain",
  ready: "Ready",
};

export type AgentDraft = { name: string; traits: CharacterTraits };

export function hexForColor(color?: string) {
  return (
    AVATAR_COLORS.find((c) => c.id === color)?.hex ??
    AVATAR_COLORS.find((c) => c.id === "orange")!.hex
  );
}

/**
 * The first-run wizard, for the web UI and the desktop app alike.
 *
 * Fresh instance: welcome → account (the only required step) → agent →
 * provider → ready. An owner provisioned from amiro.toml/.env signs in first
 * and lands here at the first unfinished step. Every step after the account
 * can be skipped; the ready step and the sidebar checklist say where to
 * finish it later.
 */
export function OnboardingWizard() {
  const router = useRouter();
  const reduce = usePrefersReducedMotion();
  const { data: session, isPending } = useSession();
  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const signedIn = !!session;
  const { data: onboarding, mutate: refresh } = useOnboarding(signedIn);
  const { setThemeStyle } = useThemeStyle();
  const invalidateIdentity = useInvalidateAgentIdentity();

  const [step, setStep] = useState<Step | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [direction, setDirection] = useState(1);
  const [skipped, setSkipped] = useState<OnboardingStepId[]>([]);
  const [phase, setPhase] = useState<VoicePhase>("listening");
  const [agent, setAgent] = useState<AgentDraft>({
    name: "Amiro",
    traits: { ...DEFAULT_CHARACTER_TRAITS, color: "orange" },
  });
  const [ownerName, setOwnerName] = useState("");
  const [login, setLogin] = useState("");

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
    if (!onboarding.isOwner) {
      router.replace("/");
      return;
    }
    const s = onboarding.steps;
    setOwnerName(s.account.name ?? "");
    setLogin(s.account.email ?? "");
    if (s.agent.done) {
      setAgent({
        name: s.agent.name || "Amiro",
        traits: { ...DEFAULT_CHARACTER_TRAITS, ...(s.agent.traits as object) },
      });
    }
    setStep(!s.agent.done ? "agent" : !s.provider.done ? "provider" : "ready");
  }, [
    step,
    isPending,
    statusLoading,
    signedIn,
    authStatus,
    onboarding,
    router,
  ]);

  const go = useCallback((next: Step) => {
    setStep((current) => {
      setDirection(
        current && ORDER.indexOf(next) < ORDER.indexOf(current) ? -1 : 1,
      );
      return next;
    });
    setPhase(next === "ready" ? "connecting" : "listening");
  }, []);

  const nextOf = (s: Step): Step => ORDER[ORDER.indexOf(s) + 1] ?? "ready";

  const skip = (s: OnboardingStepId) => {
    setSkipped((list) => (list.includes(s) ? list : [...list, s]));
    go(nextOf(s));
  };
  const done = (s: OnboardingStepId) => {
    setSkipped((list) => list.filter((x) => x !== s));
    go(nextOf(s));
  };

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
      setLogin(input.login);
      await refresh();
      done("account");
    } catch (error) {
      setPhase("error");
      throw error instanceof ApiError || error instanceof Error
        ? error
        : new Error("Could not create the account.");
    }
  };

  const saveAgent = async () => {
    setPhase("thinking");
    try {
      await updateAgentIdentity({
        name: agent.name.trim(),
        traits: agent.traits,
      });
      await invalidateIdentity();
      const theme = COLOR_TO_SIDEBAR_THEME[agent.traits.color ?? "orange"];
      if (theme) setThemeStyle(theme);
      done("agent");
    } catch (error) {
      setPhase("error");
      throw error;
    }
  };

  const finish = async () => {
    setPhase("speaking");
    await completeOnboarding(skipped);
    router.replace("/");
  };

  const back = () => {
    if (!step) return;
    const index = ORDER.indexOf(step);
    // Never walk back into the account step once the account exists.
    const floor = signedIn ? ORDER.indexOf("agent") : 0;
    if (index > floor) go(ORDER[index - 1]);
  };

  const accent = hexForColor(agent.traits.color);
  const mode =
    onboarding?.deployment.mode ?? authStatus?.mode ?? "local-server";
  const trackedIndex = step ? TRACKED.indexOf(step) : -1;
  const canGoBack =
    step !== null &&
    step !== "welcome" &&
    ORDER.indexOf(step) > (signedIn ? ORDER.indexOf("agent") : 0);

  const variants = useMemo(
    () => ({
      enter: (dir: number) =>
        reduce
          ? { opacity: 0 }
          : { opacity: 0, x: dir * 28, filter: "blur(4px)" },
      center: { opacity: 1, x: 0, filter: "blur(0px)" },
      exit: (dir: number) =>
        reduce
          ? { opacity: 0 }
          : { opacity: 0, x: dir * -28, filter: "blur(4px)" },
    }),
    [reduce],
  );

  if (!step) {
    return <div className="min-h-dvh bg-background" aria-busy="true" />;
  }

  return (
    <div
      className="onb-root relative min-h-dvh overflow-hidden bg-background text-foreground"
      style={{ "--onb-accent": accent } as React.CSSProperties}
      data-testid="onboarding-wizard"
      data-step={step}
      data-color={agent.traits.color}
    >
      {/* Ambient light tinted by the agent's colour. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className={cn(
            "absolute left-1/2 top-[-10%] h-[70vh] w-[70vh] -translate-x-1/2 rounded-full opacity-[0.18] blur-3xl transition-colors duration-700 lg:left-[72%] lg:top-[12%]",
            !reduce && "onb-drift",
          )}
          style={{
            background:
              "radial-gradient(circle, var(--onb-accent), transparent 65%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.035] dark:opacity-[0.06]"
          style={{
            backgroundImage:
              "radial-gradient(currentColor 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />
      </div>

      <header className="relative z-10 flex h-16 items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <VrndaLogo className="size-5" />
          <span className="font-brand">Amiro</span>
        </div>
        {trackedIndex >= 0 && (
          <ol
            className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-2 sm:flex"
            aria-label="Setup progress"
          >
            {TRACKED.map((s, i) => (
              <li key={s} className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-500",
                    i < trackedIndex && "w-6 bg-[var(--onb-accent)]",
                    i === trackedIndex && "w-10 bg-[var(--onb-accent)]",
                    i > trackedIndex && "w-6 bg-foreground/15",
                  )}
                  aria-current={i === trackedIndex ? "step" : undefined}
                />
                <span className="sr-only">{TRACKED_LABEL[s]}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="text-xs tabular-nums text-muted-foreground">
          {trackedIndex >= 0 &&
            `${TRACKED_LABEL[TRACKED[trackedIndex]]} · ${trackedIndex + 1} of ${TRACKED.length}`}
        </div>
      </header>

      <main className="relative z-10 mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-6xl items-center gap-6 px-5 pb-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-16">
        <section className="order-2 w-full max-w-[30rem] lg:order-1">
          {canGoBack && (
            <button
              type="button"
              onClick={back}
              className="mb-6 inline-flex items-center gap-1.5 rounded-full px-2 py-1 -ml-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)]"
              data-testid="onboarding-back"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={step}
              custom={direction}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{
                duration: reduce ? 0.12 : 0.32,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {step === "welcome" && (
                <WelcomeStep mode={mode} onStart={() => go("account")} />
              )}
              {step === "account" && (
                <AccountStep
                  defaultTimezone={detectTimezone()}
                  onTyping={(typing) =>
                    setPhase(typing ? "hearing" : "listening")
                  }
                  onSubmit={createAccount}
                />
              )}
              {step === "agent" && (
                <AgentStep
                  draft={agent}
                  onChange={setAgent}
                  source={onboarding?.steps.agent.source ?? null}
                  onSave={saveAgent}
                  onSkip={() => skip("agent")}
                />
              )}
              {step === "provider" && (
                <ProviderStep
                  agentName={agent.name}
                  source={onboarding?.steps.provider.source ?? null}
                  onConnected={() => setPhase("connecting")}
                  onDone={() => done("provider")}
                  onSkip={() => skip("provider")}
                />
              )}
              {step === "ready" && (
                <ReadyStep
                  agentName={agent.name || "Amiro"}
                  ownerName={ownerName}
                  login={login}
                  mode={mode}
                  skipped={skipped}
                  onboarding={onboarding}
                  onFinish={finish}
                  onRevisit={(s) => go(s)}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </section>

        <aside
          className={cn(
            "order-1 flex flex-col items-center justify-center lg:order-2",
            !wide && (step === "account" || step === "provider") && "hidden",
          )}
          aria-hidden
        >
          <div className="relative">
            <VoiceMascot
              phase={phase}
              traits={agent.traits}
              accent={accent}
              size={
                !wide ? 150 : step === "welcome" || step === "ready" ? 300 : 240
              }
              className="transition-[width,height] duration-500"
            />
          </div>
          {step !== "welcome" && step !== "account" && (
            <p className="mt-2 font-brand text-xl tracking-tight text-foreground/80 max-lg:hidden">
              {agent.name.trim() || "Amiro"}
            </p>
          )}
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
/* A black agent still needs a visible accent on a dark background. */
.dark .onb-root[data-color="black"] { --onb-accent: #ececf1 !important; --onb-on-accent: #17171c; }
.onb-root ::selection { background: color-mix(in oklab, var(--onb-accent) 30%, transparent); }
`;
