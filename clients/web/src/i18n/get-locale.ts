import { COOKIE_KEY_LOCALE, SUPPORTED_LOCALES } from "lib/const";

function validateLocale(locale?: string): boolean {
  return SUPPORTED_LOCALES.some((v) => v.code === locale);
}

function getLocaleFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_KEY_LOCALE}=([^;]*)`),
  );
  const locale = match ? decodeURIComponent(match[1]) : undefined;
  return validateLocale(locale) ? locale : undefined;
}

function getLocaleFromNavigator(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const locale = navigator.language?.split("-")[0];
  return validateLocale(locale) ? locale : undefined;
}

/**
 * Client-side replacement for the old "use server" getLocaleAction --
 * static export forbids Server Actions, so locale resolution moved from
 * cookies()/headers() (Next server APIs) to document.cookie/navigator.language
 * (their client-side equivalents), same cookie-then-fallback priority.
 */
export async function getLocaleAction(): Promise<string> {
  return (
    getLocaleFromCookie() ?? getLocaleFromNavigator() ?? SUPPORTED_LOCALES[0].code
  );
}
