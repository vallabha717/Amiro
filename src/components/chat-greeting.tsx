"use client";

import { motion } from "framer-motion";
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

export const ChatGreeting = () => {
  // Fetched on mount when nothing is cached yet; a missing name still gets a
  // greeting, so the page heading is never empty.
  const { data: user } = useSWR<BasicUser>(`/api/user/details`, fetcher, {
    revalidateIfStale: false,
  });
  const t = useTranslations("Chat.Greeting");

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

  return (
    <motion.div
      key="welcome"
      data-testid="chat-greeting"
      className="max-w-3xl mx-auto my-4 h-20"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ delay: 0.3 }}
    >
      <div className="rounded-xl p-6 flex flex-col gap-2 leading-relaxed text-center">
        <h1 className="text-2xl md:text-3xl">
          <FlipWords words={[word]} className="text-primary" />
        </h1>
      </div>
    </motion.div>
  );
};
