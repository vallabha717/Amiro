"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { CharacterTraits } from "@/lib/agent/character-catalog";
import {
  SETUP_STEPS,
  type SetupStepId,
  type SetupTurn,
  mainStepOf,
  progressOf,
  skippedSteps,
} from "@/lib/onboarding/setup-flow";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  Cloud,
  Cpu,
  Ear,
  Feather,
  FileText,
  Github,
  Globe,
  Headphones,
  Heart,
  KeyRound,
  Languages,
  Laugh,
  Link2,
  type LucideIcon,
  Mail,
  MessageCircle,
  MessageSquare,
  Mic,
  Newspaper,
  Palette,
  Rocket,
  ScrollText,
  Search,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Volume2,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";

type Chapter = Exclude<SetupStepId, `${string}Connect`>;

/** Each chapter's emblem and the little things that orbit the agent. */
export const CHAPTER_ART: Record<
  Chapter,
  { icon: LucideIcon; orbit: LucideIcon[] }
> = {
  greet: { icon: Sparkles, orbit: [Palette, Brain, Globe, Zap, AudioLines] },
  look: { icon: Palette, orbit: [Shapes, Heart, Sparkles] },
  prompt: { icon: ScrollText, orbit: [FileText, BookOpen, Feather] },
  personality: {
    icon: Smile,
    orbit: [SlidersHorizontal, MessageCircle, Laugh],
  },
  provider: { icon: Brain, orbit: [KeyRound, Cpu, Cloud, ShieldCheck] },
  search: { icon: Globe, orbit: [Search, Newspaper, Link2] },
  connectors: {
    icon: Zap,
    orbit: [Mail, MessageSquare, Github, CalendarDays, FileText],
  },
  voice: { icon: Volume2, orbit: [AudioLines, MessageCircle, Headphones] },
  listen: { icon: Mic, orbit: [Ear, Languages, AudioLines] },
  done: { icon: Rocket, orbit: [Check, Sparkles, MessageCircle] },
};

const CHAPTERS = SETUP_STEPS.filter(
  (s) => s !== "greet" && s !== "done",
) as Chapter[];

/** The open turn's chapter: a follow-up (connect a provider) tells its parent's story. */
export function chapterOf(step: SetupStepId): Chapter {
  return mainStepOf(step) as Chapter;
}

/** Where a chapter stands in the journey list. */
export function chapterState(
  chapter: Chapter,
  current: Chapter,
  turns: SetupTurn[],
): "done" | "current" | "later" | "upcoming" {
  if (chapter === current) return "current";
  if (skippedSteps(turns).includes(chapter)) return "later";
  const answered = turns.some(
    (t) => t.reply !== undefined && mainStepOf(t.step) === chapter,
  );
  return answered ? "done" : "upcoming";
}

/** What the user chose for a chapter: its last answer that was not a skip. */
export function chapterAnswer(
  chapter: Chapter,
  turns: SetupTurn[],
): string | undefined {
  const answered = turns.filter(
    (t) =>
      t.reply !== undefined && !t.skipped && mainStepOf(t.step) === chapter,
  );
  // The latest choice ("Pick another" can change it); a follow-up's reply
  // ("Key saved") says less than the choice before it.
  return (
    answered.findLast((t) => t.step === chapter)?.reply ??
    answered.at(-1)?.reply
  );
}

/**
 * The left of the setup chat: the agent itself, growing as it is set up,
 * with what has been chosen so far.
 */
export function AgentPanel({
  step,
  turns,
  traits,
  accent,
  name,
  subtitle,
}: {
  step: SetupStepId;
  turns: SetupTurn[];
  traits: CharacterTraits;
  accent: string;
  name: string;
  subtitle: string;
}) {
  const t = useTranslations("SetupChat");
  const reduce = usePrefersReducedMotion();
  const chapter = chapterOf(step);
  return (
    <aside
      className="flex h-full min-h-0 flex-col items-center overflow-hidden px-6 pt-14"
      data-testid="setup-agent-panel"
      aria-label={t("story.journey")}
    >
      <Hero
        art={CHAPTER_ART[chapter]}
        traits={traits}
        accent={accent}
        reduce={reduce}
      />
      <p
        className="mt-3 font-brand text-2xl tracking-tight"
        data-testid="setup-agent-title"
      >
        {name}
      </p>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
      <Journey current={chapter} turns={turns} />
    </aside>
  );
}

/** The right of the setup chat: the open step told as a chapter. */
export function StepPanel({ step }: { step: SetupStepId }) {
  const t = useTranslations("SetupChat.story");
  const reduce = usePrefersReducedMotion();
  const chapter = chapterOf(step);
  const { index, total } = progressOf(step);
  const Emblem = CHAPTER_ART[chapter].icon;
  return (
    <aside
      className="flex h-full min-h-0 flex-col justify-center overflow-hidden px-8"
      data-testid="setup-story"
      data-step={chapter}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={chapter}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
          transition={{
            duration: reduce ? 0.1 : 0.35,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <span
            className="grid size-12 place-items-center rounded-2xl text-white shadow-lg"
            style={{ background: "var(--setup-accent)" }}
          >
            <Emblem className="size-6" aria-hidden />
          </span>
          <p
            className="mt-5 text-xs font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--setup-accent)" }}
            data-testid="setup-story-chapter"
          >
            {index > 0 ? `${t("chapterOf", { index, total })} · ` : ""}
            {t(`${chapter}.chapter`)}
          </p>
          <h2
            className="mt-2 font-brand text-[1.9rem] leading-[1.1] tracking-tight text-balance"
            data-testid="setup-story-title"
          >
            {t(`${chapter}.title`)}
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground text-pretty">
            {t(`${chapter}.body`)}
          </p>
          <ul className="mt-5 space-y-2.5">
            {(["p1", "p2", "p3"] as const).map((key) => (
              <li key={key} className="flex items-start gap-2.5 text-sm">
                <span
                  className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full"
                  style={{
                    background:
                      "color-mix(in oklab, var(--setup-accent) 18%, transparent)",
                    color: "var(--setup-accent)",
                  }}
                >
                  <Check className="size-3" strokeWidth={3} aria-hidden />
                </span>
                <span>{t(`${chapter}.${key}`)}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      </AnimatePresence>
    </aside>
  );
}

function Hero({
  art,
  traits,
  accent,
  reduce,
}: {
  art: { icon: LucideIcon; orbit: LucideIcon[] };
  traits: CharacterTraits;
  accent: string;
  reduce: boolean;
}) {
  const radius = 92;
  return (
    <div className="relative size-[224px] shrink-0" aria-hidden>
      <div
        className="absolute inset-6 rounded-full blur-2xl"
        style={{
          background:
            "color-mix(in oklab, var(--setup-accent) 30%, transparent)",
        }}
      />
      <div className="absolute inset-[20px] rounded-full border border-dashed border-foreground/10" />
      <div className={cn("absolute inset-0", !reduce && "setup-orbit")}>
        {art.orbit.map((Icon, i) => {
          const angle = (i / art.orbit.length) * Math.PI * 2 - Math.PI / 2;
          return (
            <span
              key={i}
              className="absolute grid size-9 place-items-center rounded-full bg-background shadow-sm"
              style={{
                left: `calc(50% + ${Math.cos(angle) * radius}px - 18px)`,
                top: `calc(50% + ${Math.sin(angle) * radius}px - 18px)`,
              }}
            >
              <Icon
                className={cn("size-4", !reduce && "setup-orbit-counter")}
                style={{ color: "var(--setup-accent)" }}
              />
            </span>
          );
        })}
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <AgentCharacterAvatar
          traits={traits}
          accentColor={accent}
          size={112}
          animated={!reduce}
        />
      </div>
    </div>
  );
}

function Journey({ current, turns }: { current: Chapter; turns: SetupTurn[] }) {
  const t = useTranslations("SetupChat");
  return (
    <nav className="mt-6 w-full" aria-label={t("story.journey")}>
      <ol className="grid grid-cols-1 gap-0.5">
        {CHAPTERS.map((chapter) => {
          const state = chapterState(chapter, current, turns);
          const answer = state === "done" ? chapterAnswer(chapter, turns) : undefined;
          const Icon = CHAPTER_ART[chapter].icon;
          return (
            <li
              key={chapter}
              className={cn(
                "flex items-center gap-3 rounded-xl px-2.5 py-1.5 text-sm transition-colors",
                state === "current" && "bg-background/70 shadow-sm",
                (state === "upcoming" || state === "later") &&
                  "text-muted-foreground",
              )}
              aria-current={state === "current" ? "step" : undefined}
              data-testid={`setup-journey-${chapter}`}
              data-state={state}
            >
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full",
                  state === "upcoming" && "bg-muted",
                  state === "later" && "border border-dashed border-foreground/30",
                )}
                style={
                  state === "done" || state === "current"
                    ? { background: "var(--setup-accent)", color: "white" }
                    : undefined
                }
              >
                {state === "done" ? (
                  <Check className="size-3.5" strokeWidth={3} aria-hidden />
                ) : (
                  <Icon className="size-3.5" aria-hidden />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {t(`story.${chapter}.chapter`)}
                </span>
                {answer && (
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    data-testid={`setup-journey-answer-${chapter}`}
                  >
                    {answer}
                  </span>
                )}
              </span>
              {state === "later" && (
                <span className="text-xs">{t("later")}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** One line for narrow screens, where the side panels have no room. */
export function StoryStrip({ step }: { step: SetupStepId }) {
  const t = useTranslations("SetupChat.story");
  const chapter = chapterOf(step);
  const Emblem = CHAPTER_ART[chapter].icon;
  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 lg:hidden"
      data-testid="setup-story-strip"
    >
      <span
        className="grid size-8 shrink-0 place-items-center rounded-xl text-white"
        style={{ background: "var(--setup-accent)" }}
      >
        <Emblem className="size-4" aria-hidden />
      </span>
      <p className="min-w-0 text-sm">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(`${chapter}.chapter`)}
        </span>
        <span className="block truncate font-medium">
          {t(`${chapter}.title`)}
        </span>
      </p>
    </div>
  );
}

/** The slow orbit; the icons turn back the other way so they stay upright. */
export const STORY_CSS = `
@keyframes setup-orbit { to { transform: rotate(360deg); } }
.setup-orbit { animation: setup-orbit 48s linear infinite; }
.setup-orbit-counter { animation: setup-orbit 48s linear infinite reverse; }
`;
