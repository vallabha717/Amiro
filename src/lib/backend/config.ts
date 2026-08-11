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
  if (typeof window !== "undefined" && window.__BACKEND_PORT__) {
    return `http://127.0.0.1:${window.__BACKEND_PORT__}`;
  }
  return process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8787";
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
    return url;
  }
}

const SESSION_TOKEN_STORAGE_KEY = "betterchatbot.session-token";

/** The per-user bearer session token (internal/auth's own token, distinct
 * from the shared secret above) -- issued by POST /api/auth/login|register,
 * persisted in localStorage so a page refresh doesn't sign the user out. */
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
}

export function setSessionToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  }
}
