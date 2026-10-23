"use client";

import { motion } from "framer-motion";
import {
  ActivityIcon,
  KeyRoundIcon,
  RocketIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useMemo } from "react";
import { FlipWords } from "ui/flip-words";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { BasicUser } from "app-types/user";
import { fetcher } from "lib/utils";

function getGreetingByTime() {
  const hour = new Date().getHours();
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

function dispatchChatPrompt(prompt: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("amiro:send-prompt", { detail: { prompt } }),
  );
}

export const ChatGreeting = () => {
  // Fetched on mount when nothing is cached yet; a missing name still gets a
  // greeting, so the page heading is never empty.
  const { data: user } = useSWR<BasicUser>(`/api/user/details`, fetcher, {
    revalidateIfStale: false,
  });
  const t = useTranslations("Chat.Greeting");
  const tOpenUI = useTranslations("Chat.OpenUI");

  const word = useMemo(() => {
    const anonymous = [
      t("letMeKnowWhenYoureReadyToBegin"),
      t("whatAreYourThoughtsToday"),
      t("whereWouldYouLikeToStart"),
    ];
    const words = user?.name
      ? [
          ...anonymous,
          t(getGreetingByTime(), { name: user.name }),
          t("niceToSeeYouAgain", { name: user.name }),
          t("whatAreYouWorkingOnToday", { name: user.name }),
          t("whatAreYouThinking", { name: user.name }),
        ]
      : anonymous;
    return words[Math.floor(Math.random() * words.length)];
  }, [user?.name]);

  const starters = useMemo(
    () => [
      {
        id: "daily_brief",
        icon: ActivityIcon,
        label: tOpenUI("demoDailyBrief"),
        prompt:
          "Use the ui_render_openui tool on the amiro MCP server with preset=\"daily_brief\" to render the Daily Executive & Engineering Command Center, then summarize the top priority in one sentence.",
      },
      {
        id: "budget_planner",
        icon: SlidersHorizontalIcon,
        label: tOpenUI("demoBudgetPlanner"),
        prompt:
          "Use the ui_render_openui tool on the amiro MCP server with preset=\"budget_planner\" to render the interactive Cloud AI Cost & Capacity Planner, then summarize how hybrid routing lowers spend in one sentence.",
      },
      {
        id: "sprint_tracker",
        icon: RocketIcon,
        label: tOpenUI("demoSprintTracker"),
        prompt:
          "Use the ui_render_openui tool on the amiro MCP server with preset=\"sprint_tracker\" to render the Sprint 42 Release Command Center, then highlight the active release blocker in one sentence.",
      },
      {
        id: "agent_data_intake",
        icon: KeyRoundIcon,
        label: tOpenUI("demoAgentIntake"),
        prompt:
          "Use the ui_render_openui tool on the amiro MCP server with preset=\"agent_data_intake\" to render the Interactive Deployment & Credential Intake surface so I can answer the rollout question, paste service configuration values, and store the webhook signing key in the encrypted vault.",
      },
    ],
    [tOpenUI],
  );

  return (
    <motion.div
      key="welcome"
      data-testid="chat-greeting"
      className="max-w-3xl mx-auto my-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ delay: 0.3 }}
    >
      <div className="rounded-xl p-6 flex flex-col items-center gap-4 leading-relaxed text-center">
        <h1 className="text-2xl md:text-3xl">
          <FlipWords words={[word]} className="text-primary" />
        </h1>
        <div
          data-testid="openui-starter-strip"
          className="flex flex-wrap items-center justify-center gap-2 pt-1"
        >
          {starters.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`openui-starter-${item.id}`}
                onClick={() => dispatchChatPrompt(item.prompt)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/80 px-3 py-1.5 text-xs font-medium text-foreground shadow-2xs transition-all hover:border-primary/50 hover:bg-primary/10 hover:text-primary cursor-pointer"
              >
                <Icon className="size-3.5 text-primary" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
};
