"use client";
import { useAgentTheme } from "@/hooks/use-agent-theme";

import { appStore } from "@/app/store";
import {
  updateAgentIdentity,
  useAgentIdentity,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import { useSkills } from "@/hooks/queries/use-skills";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  DEFAULT_CHARACTER_TRAITS,
  DEFAULT_PERSONALITY_SLIDERS,
  summarizePersonality,
  toneForBg,
} from "@/lib/agent/character-catalog";
import { motion } from "framer-motion";
import { cn } from "lib/utils";
import {
  ArrowRight,
  Brain,
  Check,
  FolderOpen,
  type LucideIcon,
  Pencil,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { AgentCustomizerModal } from "./agent-customizer-modal";
import {
  AgentCharacterAvatar,
  type AmoebaFacing,
  type AmoebaTarget,
  PersonalitySignature,
  amoebaTargetForCard,
} from "./avatar-primitives";

const CARD_HOVER_LINES: Record<string, string> = {
  personality: "Go ahead, tweak my soul",
  superpowers: "Everything I know how to do",
  memory: "Everything I remember",
  workspace: "All the files that power me",
};

function useTypewriter(text: string, intervalMs: number) {
  const reduce = usePrefersReducedMotion();
  const [count, setCount] = useState(reduce ? text.length : 0);

  useEffect(() => {
    if (reduce) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const id = setInterval(() => {
      setCount((c) => {
        if (c >= text.length) {
          clearInterval(id);
          return c;
        }
        return c + 1;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [text, intervalMs, reduce]);

  return { typed: text.slice(0, count), typing: count < text.length };
}

interface FloodableTileProps {
  sectionKey: string;
  href: string;
  testId: string;
  className?: string;
  style?: CSSProperties;
  flooded: boolean;
  floodOrigin?: { x: number; y: number };
  accentHex: string;
  floodFg: string;
  onRegisterRef: (key: string, el: HTMLAnchorElement | null) => void;
  onHoverChange: (key: string, hovering: boolean) => void;
  children: (tone: {
    flooded: boolean;
    fgClass: string;
    fgMutedClass: string;
    fgStyle?: CSSProperties;
  }) => React.ReactNode;
}

function FloodableTile({
  sectionKey,
  href,
  testId,
  className,
  style,
  flooded,
  floodOrigin,
  accentHex,
  floodFg,
  onRegisterRef,
  onHoverChange,
  children,
}: FloodableTileProps) {
  const [lastOrigin, setLastOrigin] = useState({ x: 50, y: 100 });
  if (
    floodOrigin &&
    (floodOrigin.x !== lastOrigin.x || floodOrigin.y !== lastOrigin.y)
  ) {
    setLastOrigin(floodOrigin);
  }

  return (
    <Link
      href={href}
      data-testid={testId}
      ref={(el) => onRegisterRef(sectionKey, el)}
      onMouseEnter={() => onHoverChange(sectionKey, true)}
      onMouseLeave={() => onHoverChange(sectionKey, false)}
      style={style}
      className={cn(
        "group relative flex overflow-hidden border border-border/60 bg-card/85 backdrop-blur-xl transition-transform duration-200 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <motion.span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{ backgroundColor: accentHex }}
        initial={false}
        animate={{
          clipPath: flooded
            ? `circle(145% at ${lastOrigin.x}% ${lastOrigin.y}%)`
            : `circle(0% at ${lastOrigin.x}% ${lastOrigin.y}%)`,
        }}
        transition={
          flooded
            ? { duration: 0.48, ease: "easeOut" }
            : { duration: 0.32, ease: "easeIn" }
        }
      />
      {children({
        flooded,
        fgClass: flooded ? "" : "text-foreground",
        fgMutedClass: flooded ? "opacity-80" : "text-muted-foreground",
        fgStyle: flooded ? { color: floodFg } : undefined,
      })}
    </Link>
  );
}

export function AgentOverview() {
  const reduceMotion = usePrefersReducedMotion();
  const projectDirectory = appStore((s) => s.projectDirectory);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    data: identityData,
    error: identityError,
    isLoading: identityLoading,
    mutate: retryIdentity,
  } = useAgentIdentity();
  const skills = useSkills({ projectDirectory });
  const skillsData = skills.data;
  const skillsFailed = Boolean(skills.error);
  const invalidateIdentity = useInvalidateAgentIdentity();

  const [customizerOpen, setCustomizerOpen] = useState(false);

  // The sidebar's "customize" square links to /agent?customize=1. That can
  // arrive as a same-route search change (already on /agent), which does NOT
  // remount this component, so a mount-only effect misses it: useSearchParams
  // is what re-runs. /agent/page.tsx wraps this component in <Suspense>, which
  // useSearchParams needs for the static export.
  const customizeParam = searchParams.get("customize");

  // Consume ?customize=1 so the URL always matches what is on screen. That
  // matters twice: a reload after saving must not re-open the modal, and an
  // identical link click later must still count as a change.
  const clearCustomizeParam = useCallback(() => {
    if (customizeParam === "1") router.replace(pathname, { scroll: false });
  }, [customizeParam, pathname, router]);

  useEffect(() => {
    if (customizeParam !== "1") return;
    setCustomizerOpen(true);
    clearCustomizeParam();
  }, [customizeParam, clearCustomizeParam]);

  const handleCustomizerOpenChange = useCallback(
    (next: boolean) => {
      setCustomizerOpen(next);
      if (!next) clearCustomizeParam();
    },
    [clearCustomizeParam],
  );

  // Presentational defaults only. This carries NO counts: a number that was
  // never fetched (memories, skills) renders as "not loaded" instead of a
  // plausible-looking figure, and identityError drives a visible message.
  const identity = identityData ?? {
    name: "Amiro",
    handle: "@amiro",
    tagline: "Your Personal Intelligence powered by Amiro",
    traits: DEFAULT_CHARACTER_TRAITS,
    accentHex: "#E9642F",
    customImageUrl: null,
    sliders: DEFAULT_PERSONALITY_SLIDERS,
    personalitySummary: summarizePersonality(DEFAULT_PERSONALITY_SLIDERS),
    updatedAt: "",
  };

  const memoryStats = identityData?.memoryStats;
  // The adapter only returns memoryStats to an admin (non-admins get identity
  // alone, so shared machine memory is not leaked). An identity that loaded
  // successfully without stats is therefore "not available to you", never
  // "still loading".
  const memoryUnavailable = !memoryStats;
  const memorySub = memoryStats
    ? `${memoryStats.projectCount ?? 0} project · ${memoryStats.globalCount ?? 0} global`
    : identityLoading
      ? "Loading…"
      : identityData
        ? "Admin only"
        : "Could not load";

  const { accentHex } = useAgentTheme();
  const floodTone = toneForBg(accentHex);

  const skillItems = skillsData?.items ?? [];
  const skillsLoaded = Boolean(skillsData);
  const totalSuperpowers = skillItems.length;
  const customSuperpowers = skillItems.filter((s) => s.writable).length;
  const runtimeSuperpowers = totalSuperpowers - customSuperpowers;

  const totalMemories = memoryStats?.total ?? 0;

  // The dials shown without identityData are the app defaults, not the user's
  // saved calibration, so the summary says which of the two it is.
  const personalitySummaryText = identityData
    ? identity.personalitySummary
    : identityLoading
      ? "Loading…"
      : "App defaults (identity not loaded)";

  const [editingNameInline, setEditingNameInline] = useState(false);
  const [nameDraft, setNameDraft] = useState(identity.name);

  useEffect(() => {
    if (!editingNameInline) {
      setNameDraft(identity.name);
    }
  }, [identity.name, editingNameInline]);

  const handleCommitInlineName = async () => {
    const trimmed = nameDraft.trim();
    setEditingNameInline(false);
    if (!trimmed || trimmed === identity.name) return;
    try {
      await updateAgentIdentity({ name: trimmed });
      await invalidateIdentity();
      toast.success(`Say hi to ${trimmed}!`);
    } catch {
      toast.error("Could not rename agent.");
    }
  };

  // Card hug / amoeba state
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [hugged, setHugged] = useState<{
    key: string;
    target: AmoebaTarget;
    origin: { x: number; y: number };
  } | null>(null);

  const registerCardRef = useCallback(
    (key: string, el: HTMLAnchorElement | null) => {
      cardRefs.current[key] = el;
    },
    [],
  );

  const handleCardHover = useCallback(
    (key: string, hovering: boolean) => {
      if (reduceMotion) return;
      if (!hovering) {
        setHugged((prev) => (prev?.key === key ? null : prev));
        return;
      }
      const container = containerRef.current;
      const el = cardRefs.current[key];
      if (!container || !el) return;
      const cr = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const rect = {
        left: r.left - cr.left,
        top: r.top - cr.top,
        width: r.width,
        height: r.height,
      };
      const dx =
        (rect.left + rect.width / 2 - cr.width / 2) / Math.max(1, cr.width / 2);
      const dy =
        (rect.top + rect.height / 2 - cr.height / 2) /
        Math.max(1, cr.height / 2);
      const facing: AmoebaFacing =
        Math.abs(dx) > Math.abs(dy)
          ? dx < 0
            ? "right"
            : "left"
          : dy < 0
            ? "bottom"
            : "top";
      const target = amoebaTargetForCard(rect, facing, {
        x: cr.width / 2,
        y: cr.height / 2,
      });
      setHugged({
        key,
        target,
        origin: {
          x: (target.peek.x / Math.max(1, rect.width)) * 100,
          y: (target.peek.y / Math.max(1, rect.height)) * 100,
        },
      });
    },
    [reduceMotion],
  );

  const hoverLine = hugged ? CARD_HOVER_LINES[hugged.key] : null;
  const headlineText = hoverLine ?? `Hi, I’m ${identity.name}`;
  const { typed, typing } = useTypewriter(headlineText, hoverLine ? 24 : 52);

  const bottomSections: Array<{
    key: string;
    label: string;
    subtitle: string;
    statValue: string;
    statSub: string;
    href: string;
    icon: LucideIcon;
    radiusClass: string;
  }> = [
    {
      key: "superpowers",
      label: "Superpowers",
      subtitle: "Built-in & custom skills I can add to a chat",
      statValue: skillsLoaded ? `${totalSuperpowers} skills` : "—",
      statSub: skillsFailed
        ? "Could not load"
        : skillsLoaded
          ? `${runtimeSuperpowers} Built-in · ${customSuperpowers} mine`
          : "Loading…",
      href: "/agent/superpowers",
      icon: Zap,
      radiusClass: "rounded-[1.35rem_2.35rem_1.35rem_2.15rem]",
    },
    {
      key: "memory",
      label: "Memory",
      subtitle: "Persistent Amiro knowledge graph",
      statValue: memoryUnavailable ? "—" : `${totalMemories} memories`,
      statSub: memorySub,
      href: "/agent/memory",
      icon: Brain,
      radiusClass: "rounded-[2.15rem_1.25rem_2.35rem_1.35rem]",
    },
    {
      key: "workspace",
      label: "Workspace",
      subtitle: "IDENTITY.md, SOUL.md & runtime files",
      statValue: "3 roots",
      statSub: "Runtime · Agent · Project",
      href: "/agent/workspace",
      icon: FolderOpen,
      radiusClass: "rounded-[1.25rem_2.25rem_1.15rem_2.35rem]",
    },
  ];

  return (
    <div
      data-testid="agent-overview-page"
      className="relative flex min-h-full w-full flex-1 flex-col overflow-y-auto"
      style={{
        background: `radial-gradient(110% 85% at 50% 42%, color-mix(in srgb, ${accentHex} 16%, var(--background)) 0%, var(--background) 78%)`,
      }}
    >
      <div
        ref={containerRef}
        className="relative mx-auto flex w-full max-w-[1360px] flex-1 flex-col justify-between gap-5 px-5 py-6 sm:px-8 sm:py-8"
      >
        {/* Top Bar: subtle Apple-style pill breadcrumb + customize button */}
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="inline-block size-2.5 rounded-full shadow-xs"
              style={{ backgroundColor: accentHex }}
              aria-hidden="true"
            />
            <span className="text-xs font-medium tracking-tight text-muted-foreground">
              Personal Intelligence · Amiro Runtime
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCustomizerOpen(true)}
              data-testid="agent-customize-trigger"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-3.5 text-xs font-medium text-foreground shadow-2xs backdrop-blur-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SlidersHorizontal className="size-3.5" aria-hidden="true" />
              Customize Agent
            </button>
          </div>
        </div>

        {/* Identity fetch failure is visible and retryable: the cards below
            would otherwise silently show app defaults as if they were saved. */}
        {identityError && (
          <div
            role="alert"
            data-testid="agent-identity-error"
            className="relative z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
          >
            <span>
              Could not load your saved agent identity, so this page is showing
              app defaults and no memory or skill counts.
            </span>
            <button
              type="button"
              onClick={() => void retryIdentity()}
              className="cursor-pointer rounded-full border border-border/70 bg-card/80 px-3 py-1 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          </div>
        )}

        {/* Main Bento Stage: Personality on the left, the living agent in the centre */}
        <div className="relative z-10 grid flex-1 grid-cols-1 items-stretch gap-5 lg:grid-cols-8">
          {/* LEFT COLUMN: Personality Card with Bipolar Capsule Signature */}
          <FloodableTile
            sectionKey="personality"
            href="/agent/personality"
            testId="agent-card-personality"
            flooded={hugged?.key === "personality"}
            floodOrigin={
              hugged?.key === "personality" ? hugged.origin : undefined
            }
            accentHex={accentHex}
            floodFg={floodTone.fg}
            onRegisterRef={registerCardRef}
            onHoverChange={handleCardHover}
            className="flex min-h-[340px] flex-col justify-between rounded-3xl p-6 shadow-sm lg:col-span-4"
            style={{
              backgroundColor: `color-mix(in srgb, ${accentHex} 10%, var(--card))`,
            }}
          >
            {({ flooded, fgClass, fgMutedClass, fgStyle }) => (
              <div
                className="relative z-10 flex h-full w-full flex-col justify-between gap-4"
                style={fgStyle}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex size-9 items-center justify-center rounded-2xl transition-colors"
                      style={{
                        backgroundColor: flooded
                          ? "rgba(255,255,255,0.18)"
                          : `color-mix(in srgb, ${accentHex} 18%, transparent)`,
                        color: flooded ? floodTone.fg : accentHex,
                      }}
                    >
                      <Sparkles className="size-4" aria-hidden="true" />
                    </span>
                    <div>
                      <h2
                        className={cn(
                          "font-semibold tracking-tight text-base",
                          fgClass,
                        )}
                      >
                        Personality
                      </h2>
                      <p className={cn("text-xs", fgMutedClass)}>
                        Tune how I talk and reason
                      </p>
                    </div>
                  </div>
                  <ArrowRight
                    className={cn(
                      "size-4 transition-transform duration-200 group-hover:translate-x-0.5",
                      fgMutedClass,
                    )}
                    aria-hidden="true"
                  />
                </div>

                {/* Bipolar 5-axis capsule signature */}
                <div className="my-auto flex w-full items-center justify-center py-2">
                  <PersonalitySignature
                    values={identity.sliders}
                    accentColor={flooded ? floodTone.fg : accentHex}
                    className="h-auto max-h-[210px] w-full"
                  />
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-current/10 pt-3">
                  <span
                    className={cn(
                      "truncate text-xs font-medium italic",
                      fgClass,
                    )}
                  >
                    {personalitySummaryText}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-medium",
                      fgMutedClass,
                    )}
                  >
                    5 trait dials →
                  </span>
                </div>
              </div>
            )}
          </FloodableTile>

          {/* CENTER STAGE: The Living Agent (Greeting + Handle + Interactive Avatar + Customize) */}
          <div
            data-testid="agent-center-stage"
            className="relative flex min-h-[360px] flex-col items-center justify-between rounded-3xl px-4 py-6 lg:col-span-4"
          >
            {/* Greeting + Inline Rename + Handle */}
            <div className="z-10 flex flex-col items-center gap-1.5 text-center">
              {editingNameInline ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleCommitInlineName();
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => void handleCommitInlineName()}
                    aria-label="Edit agent name"
                    data-testid="agent-inline-name-input"
                    className="w-48 rounded-xl border border-border bg-background/90 px-3 py-1 text-center font-brand text-2xl font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    type="submit"
                    aria-label="Save agent name"
                    className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  >
                    <Check className="size-4" aria-hidden="true" />
                  </button>
                </form>
              ) : (
                <div className="group/name flex items-center justify-center gap-2">
                  <h1
                    data-testid="agent-greeting-headline"
                    aria-label={headlineText}
                    className={cn(
                      "relative font-brand font-semibold tracking-tight text-foreground transition-all",
                      hoverLine
                        ? "text-2xl sm:text-[1.75rem]"
                        : "text-3xl sm:text-[2.5rem] leading-tight",
                    )}
                  >
                    <span className="invisible" aria-hidden="true">
                      {headlineText}
                    </span>
                    <span className="absolute inset-0" aria-hidden="true">
                      {typed}
                      {typing && <span className="animate-pulse">▎</span>}
                    </span>
                  </h1>
                  {!hoverLine && (
                    <button
                      type="button"
                      aria-label="Rename agent"
                      title="Rename agent"
                      data-testid="agent-inline-rename-button"
                      onClick={() => setEditingNameInline(true)}
                      className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-60 transition-opacity hover:bg-accent hover:text-foreground group-hover/name:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}

              <div
                className={cn(
                  "flex items-center gap-2 text-xs text-muted-foreground transition-opacity duration-200",
                  hoverLine && "opacity-0",
                )}
              >
                <span className="font-mono font-medium">{identity.handle}</span>
                <span>·</span>
                <span className="max-w-[260px] truncate">
                  {identity.tagline}
                </span>
              </div>
            </div>

            {/* Interactive Center Avatar, click to open Customizer */}
            <div className="relative my-2 flex flex-1 items-center justify-center">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute size-64 rounded-full opacity-25 blur-3xl transition-all duration-500"
                style={{
                  backgroundColor: accentHex,
                  transform: hugged ? "scale(0.65)" : "scale(1)",
                }}
              />
              <motion.button
                type="button"
                aria-label="Customize agent avatar, aura, and name"
                title="Click to customize agent"
                data-testid="agent-hero-avatar-button"
                onClick={() => setCustomizerOpen(true)}
                animate={{
                  opacity: hugged ? 0.14 : 1,
                  scale: hugged ? 0.84 : 1,
                }}
                transition={{ type: "spring", stiffness: 200, damping: 22 }}
                className="group/avatar relative flex cursor-pointer flex-col items-center justify-center rounded-full p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <AgentCharacterAvatar
                  traits={identity.traits}
                  customImageUrl={identity.customImageUrl}
                  size={236}
                  interactive
                />
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/85 px-3.5 py-1 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur-md transition-colors group-hover/avatar:border-foreground/30 group-hover/avatar:text-foreground">
                  <Sparkles
                    className="size-3"
                    style={{ color: accentHex }}
                    aria-hidden="true"
                  />
                  Click to customize your agent
                </span>
              </motion.button>
            </div>
          </div>
        </div>

        {/* BOTTOM STRIP: Superpowers (Skills) · Memory (Runtime Graph) · Workspace (Runtime Files) */}
        <div
          data-testid="agent-bottom-strip"
          className="relative z-10 grid grid-cols-1 gap-4 md:grid-cols-3"
        >
          {bottomSections.map((sec) => {
            const Icon = sec.icon;
            return (
              <FloodableTile
                key={sec.key}
                sectionKey={sec.key}
                href={sec.href}
                testId={`agent-card-${sec.key}`}
                flooded={hugged?.key === sec.key}
                floodOrigin={
                  hugged?.key === sec.key ? hugged.origin : undefined
                }
                accentHex={accentHex}
                floodFg={floodTone.fg}
                onRegisterRef={registerCardRef}
                onHoverChange={handleCardHover}
                className={cn(
                  "flex items-center justify-between gap-4 p-5 shadow-xs",
                  sec.radiusClass,
                )}
              >
                {({ flooded, fgClass, fgMutedClass, fgStyle }) => (
                  <div
                    className="relative z-10 flex w-full items-center justify-between gap-4"
                    style={fgStyle}
                  >
                    <div className="flex min-w-0 items-center gap-3.5">
                      <span
                        className="flex size-12 shrink-0 items-center justify-center rounded-2xl transition-colors"
                        style={{
                          backgroundColor: flooded
                            ? "rgba(255,255,255,0.18)"
                            : `color-mix(in srgb, ${accentHex} 15%, transparent)`,
                          color: flooded ? floodTone.fg : accentHex,
                        }}
                      >
                        <Icon className="size-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3
                            className={cn(
                              "truncate text-base font-semibold tracking-tight",
                              fgClass,
                            )}
                          >
                            {sec.label}
                          </h3>
                        </div>
                        <p className={cn("truncate text-xs", fgMutedClass)}>
                          {sec.subtitle}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end text-right">
                      <span
                        className={cn(
                          "font-brand text-lg font-semibold tabular-nums leading-tight",
                          fgClass,
                        )}
                      >
                        {sec.statValue}
                      </span>
                      <span
                        className={cn(
                          "text-[11px] font-medium tabular-nums",
                          fgMutedClass,
                        )}
                      >
                        {sec.statSub}
                      </span>
                    </div>
                  </div>
                )}
              </FloodableTile>
            );
          })}
        </div>
      </div>

      <AgentCustomizerModal
        open={customizerOpen}
        onOpenChange={handleCustomizerOpenChange}
        identity={identity}
      />
    </div>
  );
}
