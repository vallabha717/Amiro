"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { accentFor } from "@/components/team/agent-look-picker";
import {
  updateAgentIdentity,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import { useThemeStyle } from "@/hooks/use-theme-style";
import {
  COLOR_TO_SIDEBAR_THEME,
  type CharacterTraits,
} from "@/lib/agent/character-catalog";
import { setAgentScope } from "@/lib/backend/agent-scope";
import {
  AGENTS_KEY,
  type AgentInput,
  createAgent,
} from "@/lib/backend/agents-api";
import {
  type SetupMode,
  type SetupStepId,
  type SetupTurn,
  answerTurn,
  firstTurn,
  progressOf,
  skippedSteps,
} from "@/lib/onboarding/setup-flow";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import { Button } from "ui/button";
import { SetupCard } from "./card-ui";
import { ConnectorsCard } from "./cards/connectors-card";
import { DoneCard } from "./cards/done-card";
import { LookCard, type TeamAgentDraft } from "./cards/look-card";
import { PersonalityCard } from "./cards/personality-card";
import { PromptCard } from "./cards/prompt-card";
import { ProviderConnectCard, ProviderPickCard } from "./cards/provider-cards";
import { SearchKeyCard, SearchPickCard } from "./cards/search-cards";
import { VoiceKeyCard, VoicePickCard } from "./cards/voice-cards";
import { AgentPanel, STORY_CSS, StepPanel, StoryStrip } from "./story-panel";
import { StreamingText } from "./streaming-text";

export interface SetupResult {
  skipped: SetupStepId[];
  /** The new team agent (team mode), or null for Amiro. */
  agentId: string | null;
}

/**
 * Setup as a conversation: the agent streams one line per step and the user
 * answers with a card under it (look, prompt, personality, provider, web
 * search, connectors, voice). First-run onboarding runs it for Amiro, whose
 * name is fixed; Team → New agent runs the same chat to create and set up a
 * new agent. In team mode the agent exists after the look step, and every
 * later card acts on it through the agent scope (agent-scope.ts), so its
 * provider, search and connectors are its own.
 */
export function SetupChat({
  mode,
  agentName: initialName,
  ownerName,
  initialTraits,
  accessUrl,
  onFinish,
}: {
  mode: SetupMode;
  /** Amiro's name (onboarding); ignored in team mode until the agent is named. */
  agentName: string;
  ownerName?: string;
  initialTraits: CharacterTraits;
  /** Where Amiro is reachable on the network, shown in the summary. */
  accessUrl?: string;
  onFinish: (result: SetupResult) => Promise<void>;
}) {
  const t = useTranslations("SetupChat");
  const tTeam = useTranslations("Team");
  const { setThemeStyle } = useThemeStyle();
  const invalidateIdentity = useInvalidateAgentIdentity();
  const [turns, setTurns] = useState<SetupTurn[]>(firstTurn);
  const [streamed, setStreamed] = useState<Set<string>>(() => new Set());
  const [traits, setTraits] = useState<CharacterTraits>(initialTraits);
  const [teamDraft, setTeamDraft] = useState<TeamAgentDraft | null>(null);
  const [name, setName] = useState(mode === "team" ? "" : initialName);
  const [agentId, setAgentId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const team = mode === "team";
  const accent = accentFor(traits.color);
  const open = turns[turns.length - 1];

  // A new team agent's setup acts in its scope; leave it when the chat goes.
  useEffect(() => {
    if (!team) return;
    return () => setAgentScope(null);
  }, [team]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, streamed]);

  const answer = useCallback(
    (reply: string, options?: Parameters<typeof answerTurn>[2]) =>
      setTurns((current) => answerTurn(current, reply, options)),
    [],
  );
  const skip = () => answer(t("reply.skip"), { skipped: true });

  const saveLook = async (draft: TeamAgentDraft | null) => {
    const look = `${tTeam(`colours.${traits.color ?? "orange"}`)} · ${tTeam(
      `shapes.${traits.bodyShape ?? "blob"}`,
    )}`;
    if (draft) {
      const agent = await createAgent({
        name: draft.name,
        role: draft.role.trim(),
        instructions: draft.instructions.trim(),
        traits,
        brain: draft.brain,
      } as AgentInput & { brain: "copy" | "empty" });
      await mutate(AGENTS_KEY);
      setAgentScope(agent.id);
      setAgentId(agent.id);
      setName(agent.name);
      const theme = COLOR_TO_SIDEBAR_THEME[traits.color ?? "teal"];
      if (theme) setThemeStyle(theme);
      answer(`${agent.name} · ${look}`);
      return;
    }
    await updateAgentIdentity({ name: initialName, traits });
    await invalidateIdentity();
    const theme = COLOR_TO_SIDEBAR_THEME[traits.color ?? "orange"];
    if (theme) setThemeStyle(theme);
    answer(look);
  };

  const sayFor = (turn: SetupTurn): string => {
    const vars = {
      name: name || t("newAgent"),
      owner: ownerName ? ` ${ownerName}` : "",
      provider: turn.meta?.label ?? "",
    };
    switch (turn.step) {
      case "greet":
      case "look":
      case "done":
        return t(`say.${turn.step}.${mode}`, vars);
      case "providerConnect":
        return t(
          `say.providerConnect.${turn.meta?.mechanism ?? "unknown"}`,
          vars,
        );
      case "connectors":
      case "voice":
      case "listen":
        return t(`say.${turn.step}${team ? "Team" : ""}`, vars);
      default:
        return t(`say.${turn.step}`, vars);
    }
  };

  const cardFor = (turn: SetupTurn) => {
    switch (turn.step) {
      case "greet":
        return (
          <SetupCard
            testId="setup-greet-card"
            className="border-dashed bg-transparent shadow-none"
          >
            <Button
              onClick={() => answer(t("reply.go"))}
              data-testid="setup-start"
            >
              {t("letsGo")}
            </Button>
          </SetupCard>
        );
      case "look":
        return (
          <LookCard
            mode={mode}
            traits={traits}
            onTraits={setTraits}
            onDraftChange={setTeamDraft}
            onSubmit={saveLook}
          />
        );
      case "prompt":
        return <PromptCard onContinue={() => answer(t("reply.looksGood"))} />;
      case "personality":
        return (
          <PersonalityCard
            agentName={name}
            onSaved={(summary) => answer(summary || t("reply.saved"))}
            onSkip={() => answer(t("reply.keepDefault"), { skipped: true })}
          />
        );
      case "provider":
        return (
          <ProviderPickCard
            onSkip={skip}
            onPick={(choice) =>
              choice.connected
                ? answer(choice.label)
                : answer(choice.label, {
                    next: {
                      step: "providerConnect",
                      subject: choice.id,
                      meta: {
                        label: choice.label,
                        mechanism: choice.mechanism,
                      },
                    },
                  })
            }
          />
        );
      case "providerConnect":
        return (
          <ProviderConnectCard
            providerId={turn.subject ?? ""}
            onConnected={() =>
              answer(t("reply.connected", { provider: turn.meta?.label ?? "" }))
            }
            onBack={() =>
              answer(t("reply.pickAnother"), { next: { step: "provider" } })
            }
            onSkip={skip}
          />
        );
      case "search":
        return (
          <SearchPickCard
            onSkip={skip}
            onSaved={(label) => answer(label)}
            onNeedsKey={(spec) =>
              answer(spec.label, {
                next: {
                  step: "searchConnect",
                  subject: spec.kind,
                  meta: { label: spec.label },
                },
              })
            }
          />
        );
      case "searchConnect":
        return (
          <SearchKeyCard
            kind={turn.subject ?? ""}
            onSaved={() => answer(t("reply.keySaved"))}
            onBack={() =>
              answer(t("reply.pickAnother"), { next: { step: "search" } })
            }
            onSkip={skip}
          />
        );
      case "connectors":
        return (
          <ConnectorsCard
            mode={mode}
            onDone={(summary) => answer(summary)}
            onSkip={skip}
          />
        );
      case "voice":
      case "listen": {
        const kind = turn.step === "voice" ? "tts" : "stt";
        const connect =
          turn.step === "voice" ? "voiceConnect" : "listenConnect";
        return (
          <VoicePickCard
            kind={kind}
            onSkip={skip}
            onSaved={(label) => answer(label)}
            onNeedsKey={(entry) =>
              answer(entry.displayName, {
                next: {
                  step: connect,
                  subject: entry.id,
                  meta: { label: entry.displayName },
                },
              })
            }
          />
        );
      }
      case "voiceConnect":
      case "listenConnect": {
        const speak = turn.step === "voiceConnect";
        return (
          <VoiceKeyCard
            kind={speak ? "tts" : "stt"}
            providerId={turn.subject ?? ""}
            onSaved={(alsoListen) =>
              answer(t(alsoListen ? "reply.keySavedBoth" : "reply.keySaved"))
            }
            onBack={() =>
              answer(t("reply.pickAnother"), {
                next: { step: speak ? "voice" : "listen" },
              })
            }
            onSkip={skip}
          />
        );
      }
      case "done":
        return (
          <DoneCard
            mode={mode}
            name={name}
            turns={turns}
            accessUrl={accessUrl}
            onFinish={() => onFinish({ skipped: skippedSteps(turns), agentId })}
          />
        );
    }
  };

  const progress = progressOf(open.step);
  const displayName = (team ? teamDraft?.name : name) || name || t("newAgent");
  const displaySubtitle =
    team && teamDraft?.role
      ? teamDraft.role
      : team
        ? t("subtitleTeam")
        : t("subtitle");

  return (
    <div
      className="flex h-full min-h-0"
      style={
        {
          "--setup-accent": accent,
          background:
            "radial-gradient(55% 60% at 0% 0%, color-mix(in oklab, var(--setup-accent) 14%, transparent), transparent 70%), radial-gradient(45% 55% at 100% 100%, color-mix(in oklab, var(--setup-accent) 10%, transparent), transparent 70%)",
        } as React.CSSProperties
      }
      data-testid="setup-chat"
      data-mode={mode}
      data-step={open.step}
    >
      {/* Wide screens keep the three columns together; the tint fills the screen. */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1560px]">
        <div className="hidden w-[300px] shrink-0 xl:block">
          <AgentPanel
            step={open.step}
            turns={turns}
            traits={traits}
            accent={accent}
            name={displayName}
            subtitle={displaySubtitle}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 px-4 pt-3 sm:px-6 xl:hidden">
            <AgentCharacterAvatar
              traits={traits}
              accentColor={accent}
              size={36}
              animated
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{displayName}</p>
              <p className="text-xs text-muted-foreground">{displaySubtitle}</p>
            </div>
            {progress.index > 0 && (
              <p
                className="shrink-0 rounded-full bg-background/70 px-3 py-1 text-xs tabular-nums text-muted-foreground shadow-sm"
                data-testid="setup-progress-compact"
              >
                {t("progress", progress)}
              </p>
            )}
          </header>
          <StoryStrip step={open.step} />
          {progress.index > 0 && (
            <p
              className="mx-auto mt-3 hidden rounded-full bg-background/70 px-3 py-1 text-xs tabular-nums text-muted-foreground shadow-sm xl:block"
              data-testid="setup-progress"
            >
              {t("progress", progress)}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_28px,black_calc(100%-28px),transparent)]">
            <ol
              className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 sm:px-6"
              aria-live="polite"
            >
              {turns.map((turn) => {
                const done = turn.reply !== undefined;
                const ready = done || streamed.has(turn.key);
                return (
                  <li
                    key={turn.key}
                    className="flex flex-col gap-3"
                    data-testid={`setup-turn-${turn.step}`}
                  >
                    <div className="flex items-start gap-3">
                      <AgentCharacterAvatar
                        traits={traits}
                        accentColor={accent}
                        size={30}
                        className="mt-0.5 shrink-0"
                      />
                      <div
                        className="min-w-0 flex-1"
                        data-testid="setup-agent-message"
                      >
                        <StreamingText
                          text={sayFor(turn)}
                          instant={done}
                          onDone={() =>
                            setStreamed((s) =>
                              s.has(turn.key) ? s : new Set(s).add(turn.key),
                            )
                          }
                        />
                        {!done && ready && cardFor(turn)}
                      </div>
                    </div>
                    {done && turn.step !== "done" && (
                      <div className="flex justify-end">
                        <p
                          className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                          data-testid="setup-user-reply"
                        >
                          {turn.reply}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <div ref={bottom} />
          </div>
        </div>
        <div className="hidden w-[340px] shrink-0 lg:block">
          <StepPanel step={open.step} />
        </div>
      </div>
      <style>{STORY_CSS}</style>
    </div>
  );
}
