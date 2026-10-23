"use client";

import { appStore } from "@/app/store";
import { useCompletion } from "@ai-sdk/react";
import { ChatModel } from "app-types/chat";
import { useCallback, useEffect } from "react";
import { mutate } from "swr";
import { safe } from "ts-safe";
import { backendFetch } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";

export function useGenerateThreadTitle(option: {
  threadId: string;
  chatModel?: ChatModel;
}) {
  const { complete, completion } = useCompletion({
    api: backendUrl("/api/chat/title"),
    fetch: backendFetch,
  });

  const updateTitle = useCallback(
    (title: string) => {
      appStore.setState((prev) => {
        if (prev.threadList.some((v) => v.id !== option.threadId)) {
          return {
            threadList: [
              {
                id: option.threadId,
                title,
                userId: "",
                createdAt: new Date(),
              },
              ...prev.threadList,
            ],
          };
        }

        return {
          threadList: prev.threadList.map((v) =>
            v.id === option.threadId ? { ...v, title } : v,
          ),
        };
      });
    },
    [option.threadId, option.chatModel?.model, option.chatModel?.provider],
  );

  const generateTitle = useCallback(
    (message: string) => {
      const { threadId, chatModel } = option;
      if (appStore.getState().generatingTitleThreadIds.includes(threadId))
        return;
      appStore.setState((prev) => ({
        generatingTitleThreadIds: [...prev.generatingTitleThreadIds, threadId],
      }));
      safe(() => {
        updateTitle("");
        return complete("", {
          body: {
            message,
            threadId,
            chatModel: chatModel ?? appStore.getState().chatModel,
          },
        });
      })
        .ifOk(() => mutate("/api/thread"))
        .watch(() => {
          appStore.setState((prev) => ({
            generatingTitleThreadIds: prev.generatingTitleThreadIds.filter(
              (v) => v !== threadId,
            ),
          }));
        });
    },
    [updateTitle],
  );

  useEffect(() => {
    const title = completion.trim();
    if (title) {
      updateTitle(title);
    }
  }, [completion, updateTitle]);

  return generateTitle;
}
