"use client";

import { useEffect, useState } from "react";
import { NextIntlClientProvider } from "next-intl";
import deepmerge from "deepmerge";
import { getLocaleAction } from "@/i18n/get-locale";
import defaultMessages from "../../../messages/en.json";

/**
 * Replaces next-intl/server's getRequestConfig (i18n/request.ts, now
 * deleted) + RootLayout's server-side getLocale() call. Static export has
 * no per-request server to resolve cookies()/headers() against, so locale
 * + message loading both moved to the client -- same messages/<locale>.json
 * merge-over-English-defaults logic i18n/request.ts used to do, just
 * running after mount instead of per-request on the server.
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{
    locale: string;
    messages: Record<string, any>;
  }>({ locale: "en", messages: defaultMessages });

  useEffect(() => {
    let cancelled = false;
    getLocaleAction().then(async (locale) => {
      if (locale === "en") {
        if (!cancelled) setState({ locale, messages: defaultMessages });
        return;
      }
      try {
        const messages = (await import(`../../../messages/${locale}.json`))
          .default;
        if (!cancelled) {
          setState({
            locale,
            messages: deepmerge(defaultMessages, messages),
          });
        }
      } catch {
        if (!cancelled) setState({ locale, messages: defaultMessages });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);

  return (
    <NextIntlClientProvider
      locale={state.locale}
      messages={state.messages}
      getMessageFallback={({ key, namespace }) => `${namespace}.${key}`}
    >
      {children}
    </NextIntlClientProvider>
  );
}
