"use client";

import { useEffect, useMemo } from "react";
import { SWRConfig, SWRConfiguration } from "swr";

// The `fallback: {"/api/user/details": user}` RSC->client hydration seed
// is dropped: that value came from the layout's own server-rendered
// getSession() call, which no longer exists (see (chat)/layout.tsx's doc
// comment) -- every /api/user/details reader now does its own client-side
// fetch instead of reading a pre-seeded SWR cache entry.
export function SWRConfigProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = useMemo<SWRConfiguration>(() => {
    return {
      focusThrottleInterval: 30000,
      dedupingInterval: 2000,
      errorRetryCount: 1,
    };
  }, []);

  useEffect(() => {
    console.log(
      "%cAmiro\n\n%c⛓️ Premium AI Assistant Platform\nhttps://github.com/cgoinglove/better-chatbot",
      "color: #00d4ff; font-weight: bold; font-family: monospace; font-size: 20px; text-shadow: 0 0 10px #00d4ff;",
      "color: #888; font-size: 12px;",
    );
  }, []);
  return <SWRConfig value={config}>{children}</SWRConfig>;
}
