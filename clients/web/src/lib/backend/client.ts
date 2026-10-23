import { agentScopeHeaders } from "./agent-scope";
import {
  backendUrl,
  getBackendSharedSecret,
  getRemoteOrigin,
  getSessionToken,
  isSameOriginBackend,
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
  const headers: Record<string, string> = {};
  // The Rust backend requires the sidecar secret on every /api call whenever
  // AMIRO_TOKEN is set, and injects it into each page it serves as
  // window.__BACKEND_TOKEN__. Send it whenever we have one: without it a
  // page the backend served itself is refused ("invalid or missing sidecar
  // token"). With no secret on a same-origin page (AMIRO_TOKEN unset), send
  // nothing -- an empty header would fail the constant-time compare.
  const secret = getBackendSharedSecret();
  // Connected to another Amiro: the device session is the only credential.
  if (secret || (!isSameOriginBackend() && !getRemoteOrigin())) {
    headers["X-Amiro-Token"] = secret;
    headers["X-BetterChatbot-Token"] = secret;
  }
  const token = getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  // The team agent whose settings the page acts on (agent-scope.ts).
  Object.assign(headers, agentScopeHeaders());
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
      errorPayload.error ||
        errorPayload.message ||
        "An error occurred while fetching the data.",
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
  // The native backend rejects a JSON body that arrives without a JSON content
  // type (415), unlike the previous Go server. Set it here so every JSON call
  // site gets it from one place instead of each caller remembering.
  const headers = new Headers(init?.headers);
  if (
    typeof init?.body === "string" &&
    !headers.has("Content-Type") &&
    /^\s*[\[{]/.test(init.body)
  ) {
    headers.set("Content-Type", "application/json");
  }
  const res = await apiFetch(path, { ...init, headers });
  if (!res.ok) {
    let errorPayload: any;
    try {
      errorPayload = await res.json();
    } catch {
      errorPayload = { message: `Request failed with status ${res.status}` };
    }
    throw new ApiError(
      errorPayload.error ||
        errorPayload.message ||
        "An error occurred while fetching the data.",
      res.status,
      errorPayload,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
