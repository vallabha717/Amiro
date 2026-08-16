import {
  backendUrl,
  getBackendSharedSecret,
  getSessionToken,
} from "./config";

export class ApiError extends Error {
  status: number;
  info: unknown;
  constructor(message: string, status: number, info: unknown) {
    super(message);
    this.status = status;
    this.info = info;
  }
}

/**
 * Every request to the Go sidecar needs two headers on top of whatever the
 * caller sends: `X-BetterChatbot-Token` (the sidecar-level shared secret --
 * middleware.RequireToken) and `Authorization: Bearer <session>` (the
 * per-user session -- auth.RequireSession), skipped for anonymous public
 * routes like GET /api/export/{id} when no session exists yet.
 */
function authHeaders(): HeadersInit {
  const secret = getBackendSharedSecret();
  const headers: Record<string, string> = {
    "X-Amiro-Token": secret,
    "X-BetterChatbot-Token": secret,
  };
  const token = getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * `fetch()` against the Go sidecar, with `path` being a bare `/api/...`
 * (or `/storage/...`) route -- resolved against the sidecar's own
 * base URL (backend/config.ts), not the page's own origin.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(authHeaders());
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return fetch(backendUrl(path), {
    redirect: "follow",
    cache: "no-store",
    ...init,
    headers,
  });
}

/**
 * A `window.fetch`-compatible function that attaches the sidecar's auth
 * headers without re-resolving the URL -- for the AI SDK's
 * `DefaultChatTransport({api: backendUrl("/api/chat"), fetch: backendFetch})`
 * hooks (useChat/useCompletion/experimental_useObject), whose `api` option
 * already carries the full absolute sidecar URL (see backend/config.ts's
 * `backendUrl`).
 */
export const backendFetch: typeof fetch = (input, init) => {
  const headers = new Headers(authHeaders());
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return fetch(input, { ...init, headers });
};

/** Ports lib/utils.ts's `fetcher`, the SWR-wide fetch function, onto the
 * sidecar base URL + auth headers above -- same error-shape contract every
 * existing `useSWR(...)` call site already expects. */
export const fetcher = async (path: string, options?: RequestInit) => {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    let errorPayload: any;
    try {
      errorPayload = await res.json();
    } catch {
      errorPayload = { message: `Request failed with status ${res.status}` };
    }
    throw new ApiError(
      errorPayload.error || errorPayload.message || "An error occurred while fetching the data.",
      res.status,
      errorPayload,
    );
  }
  return res.json();
};

/** POST/PUT/DELETE helper: fetch + parse JSON, throwing ApiError on a
 * non-2xx the same way `fetcher` does, for the ~13 raw-fetch call sites
 * that aren't SWR reads. */
export async function apiJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let errorPayload: any;
    try {
      errorPayload = await res.json();
    } catch {
      errorPayload = { message: `Request failed with status ${res.status}` };
    }
    throw new ApiError(
      errorPayload.error || errorPayload.message || "An error occurred while fetching the data.",
      res.status,
      errorPayload,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
