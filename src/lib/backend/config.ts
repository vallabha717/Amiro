/**
 * Resolves where the Go sidecar lives and the shared-secret header every
 * request to it must carry (plan section 1's "loopback drive-by" guard --
 * see docs/desktop-rewrite-go-rust-plan.md).
 *
 * In the real Tauri build (Phase 8, src-tauri/src/lib.rs) Rust spawns the
 * sidecar, reads its `PORT=<n>` stdout line, and injects both the port and
 * the shared-secret token into the webview before the frontend loads via
 * `with_initialization_script` -- `window.__BACKEND_PORT__` is the value
 * name the plan itself gives (section 1); `window.__BACKEND_TOKEN__` is
 * this file's own choice for the token's counterpart, since the plan
 * doesn't name one, and src-tauri/src/lib.rs matches it.
 *
 * `NEXT_PUBLIC_BACKEND_URL`/`NEXT_PUBLIC_BACKEND_TOKEN` remain as a
 * fallback for developing/testing the Next app directly (`next dev`/a
 * plain static-file server) against a manually-started `cmd/server`
 * binary, without going through Tauri at all -- see backend-go's own
 * dev-mode stderr line for the token it generates when
 * `BETTERCHATBOT_AUTH_TOKEN` isn't set.
 */
declare global {
  interface Window {
    /** Set by the Go binary itself when it is serving this page
     * (`amiro serve` / `amiro --serve`, backend-go/internal/web injects it
     * into every HTML response). An empty string means "same origin as
     * this page", which is the whole point: the API and the dashboard come
     * off one listener, so relative /api/... URLs are correct and no port
     * needs to be guessed. Checked before __BACKEND_PORT__ because a
     * served page never has a port injected and must not fall through to
     * the 127.0.0.1:8787 dev default. */
    __BACKEND_ORIGIN__?: string;
    __BACKEND_PORT__?: number;
    __BACKEND_TOKEN__?: string;
    /** The desktop auto-login user's session token (backend-go's
     * SESSION_TOKEN= stdout line, Rust-injected the same way as the two
     * above) -- only ever set on a real Tauri launch with the sqlite
     * driver; a web deploy or the pre-Phase-8 dev/export-testing fallback
     * never has this global, so the normal sign-in form still works
     * unchanged in both cases. See session-context.tsx's
     * adoptInjectedSessionToken. */
    __BACKEND_SESSION_TOKEN__?: string;
  }
}

export function getBackendBaseUrl(): string {
  if (typeof window !== "undefined") {
    // Deliberately a typeof check, not a truthiness one: "" is the value
    // that means same-origin, and it is falsy.
    if (typeof window.__BACKEND_ORIGIN__ === "string") {
      return window.__BACKEND_ORIGIN__;
    }
    if (window.__BACKEND_PORT__) {
      return `http://127.0.0.1:${window.__BACKEND_PORT__}`;
    }
  }
  return process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8787";
}

/** True when the Go binary is serving this page, so the API is same-origin.
 * The shared-secret header is meaningless here -- see
 * middleware.RequireTokenOrBrowser for why a served page authenticates
 * structurally (same-origin + a session) rather than with a secret every
 * visitor would be handed. */
export function isSameOriginBackend(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.__BACKEND_ORIGIN__ === "string"
  );
}

export function getBackendSharedSecret(): string {
  if (typeof window !== "undefined" && window.__BACKEND_TOKEN__) {
    return window.__BACKEND_TOKEN__;
  }
  return process.env.NEXT_PUBLIC_BACKEND_TOKEN || "";
}

/** Builds an absolute sidecar URL from a `/api/...`-style path. */
export function backendUrl(path: string): string {
  return `${getBackendBaseUrl()}${path}`;
}

/**
 * Storage source URLs (`/storage/<signed-token>`) are persisted verbatim
 * inside chat message parts and re-read months later, but the sidecar's
 * loopback port is OS-assigned fresh on every launch (internal/storage's
 * `SourceURLTTL` doc comment flags this as a known, then-open gap). The
 * signed token inside the path stays valid across restarts (it's HMAC'd
 * with a persisted secret, not the per-launch port/auth token) -- only the
 * host:port prefix goes stale. Rewrites any absolute URL whose path starts
 * with `/storage/` to the current sidecar origin; anything else (a real
 * external URL from e.g. a web-search result) passes through unchanged.
 */
export function rewriteStorageUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/storage/")) return url;
    return `${getBackendBaseUrl()}${parsed.pathname}${parsed.search}`;
  } catch {
    if (url.startsWith("/storage/")) {
      return `${getBackendBaseUrl()}${url}`;
    }
    return url;
  }
}

const SESSION_TOKEN_STORAGE_KEY = "amiro.session-token";
const LEGACY_SESSION_TOKEN_STORAGE_KEY = "betterchatbot.session-token";

/** The per-user bearer session token (internal/auth's own token, distinct
 * from the shared secret above) -- issued by POST /api/auth/login|register,
 * persisted in localStorage so a page refresh doesn't sign the user out. */
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return (
    window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ||
    window.localStorage.getItem(LEGACY_SESSION_TOKEN_STORAGE_KEY)
  );
}

export function setSessionToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_TOKEN_STORAGE_KEY);
  }
}
