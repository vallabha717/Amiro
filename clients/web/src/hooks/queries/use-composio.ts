"use client";
import {
  ComposioConfig,
  ComposioConnection,
  ComposioToolkitsPage,
  buildComposioToolkitsPath,
} from "@/lib/backend/composio-api";
import { fetcher } from "lib/utils";
import useSWR, { SWRConfiguration } from "swr";
import useSWRInfinite, { SWRInfiniteConfiguration } from "swr/infinite";
import { handleErrorWithToast } from "ui/shared-toast";

export const COMPOSIO_TOOLKITS_PAGE_SIZE = 24;

export function useComposioConfig(options?: SWRConfiguration) {
  return useSWR<ComposioConfig>("/api/composio/config", fetcher, {
    revalidateOnFocus: false,
    errorRetryCount: 0,
    onError: handleErrorWithToast,
    ...options,
  });
}

export function useComposioConnections(options?: SWRConfiguration) {
  return useSWR<ComposioConnection[]>("/api/composio/connections", fetcher, {
    revalidateOnFocus: false,
    errorRetryCount: 0,
    fallbackData: [],
    onError: handleErrorWithToast,
    ...options,
  });
}

function toolkitsKey(
  search: string,
  pageIndex: number,
  previousPage: ComposioToolkitsPage | null,
): string | null {
  if (previousPage && !previousPage.nextCursor) return null;
  return buildComposioToolkitsPath({
    search: search.trim() || undefined,
    cursor:
      pageIndex === 0 ? undefined : (previousPage?.nextCursor ?? undefined),
    limit: COMPOSIO_TOOLKITS_PAGE_SIZE,
  });
}

/**
 * Paginated toolkit list. Server-side search via `search`; the
 * All / Connected filter is applied client-side in the dashboard so the
 * cursor chain stays stable while toggling it.
 */
export function useComposioToolkits(
  search: string,
  options?: SWRInfiniteConfiguration,
) {
  return useSWRInfinite<ComposioToolkitsPage>(
    (pageIndex, previousPage: ComposioToolkitsPage | null) =>
      toolkitsKey(search, pageIndex, previousPage),
    fetcher,
    {
      revalidateOnFocus: false,
      errorRetryCount: 0,
      persistSize: true,
      onError: handleErrorWithToast,
      ...options,
    },
  );
}
