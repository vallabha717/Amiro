import { appStore } from "@/app/store";
import { fetcher } from "lib/utils";
import useSWR, { SWRConfiguration } from "swr";

export interface ChatModelProvider {
  /** The provider *connection* id (a provider_config row), not its type. */
  provider: string;
  providerName: string;
  providerType: string;
  hasAPIKey: boolean;
  models: {
    name: string;
    isToolCallUnsupported?: boolean;
    isImageInputUnsupported?: boolean;
    supportedFileMimeTypes?: string[];
  }[];
}

/**
 * The chat model list: only providers the user has actually configured, since
 * the sidecar's /api/chat/models filters to ones with a key.
 */
export const useChatModels = (options?: SWRConfiguration) => {
  return useSWR<ChatModelProvider[]>("/api/chat/models", fetcher, {
    dedupingInterval: 60_000 * 5,
    revalidateOnFocus: false,
    fallbackData: [],
    onSuccess: (data) => {
      const state = appStore.getState();
      if (state.chatModel) {
        // A model that was selected before its provider was edited or
        // deleted would otherwise stay pinned and fail on every send.
        const stillExists = data.some(
          (p) =>
            p.provider === state.chatModel?.provider &&
            p.models.some((m) => m.name === state.chatModel?.model),
        );
        if (stillExists) return;
      }

      // No providers configured yet -- leave the selection empty rather than
      // reading data[0] off an empty list, which is what the admin
      // providers page exists to fix.
      const firstProvider = data.find((p) => p.models.length > 0);
      if (!firstProvider) {
        if (state.chatModel) appStore.setState({ chatModel: undefined });
        return;
      }

      appStore.setState({
        chatModel: {
          provider: firstProvider.provider,
          model: firstProvider.models[0].name,
        },
      });
    },
    ...options,
  });
};
