import type { BackendUser } from "./session-context";
import { apiJson } from "./client";

/** Settings → Devices: phones and other apps paired with this Amiro
 * (backend/src/devices.rs). */
export const DEVICES_KEY = "/api/devices";

export type DevicePlatform = "ios" | "android" | "desktop" | "web";

export interface PairedDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  address?: string;
  createdAt: string;
}

/** A device waiting for the owner to approve it. */
export interface DeviceRequest {
  id: string;
  userCode: string;
  name: string;
  platform: DevicePlatform;
  /** The address it asked from, as this server saw it. */
  address: string;
  createdAt: string;
  expiresAt: string;
}

export interface RemoteAccessStatus {
  /** False on a server install: it is reachable already. */
  needed: boolean;
  enabled: boolean;
  port: number;
  listening: boolean;
  error: string | null;
  /** Addresses another device can use right now. */
  urls: string[];
}

/** An address of this Amiro with a QR code that opens its /pair page. */
export interface ServerLink {
  url: string;
  link: string;
  qrSvg: string | null;
}

export interface DevicesOverview {
  devices: PairedDevice[];
  requests: DeviceRequest[];
  remoteAccess: RemoteAccessStatus;
  links: ServerLink[];
}

/** `origin` is the address this page was opened at, so a cloud server's own
 * https name is offered first. */
export function devicesKey(origin: string) {
  return `${DEVICES_KEY}?origin=${encodeURIComponent(origin)}`;
}

export function setRemoteAccess(enabled: boolean, port?: number) {
  return apiJson<DevicesOverview>("/api/devices/remote-access", {
    method: "PUT",
    body: JSON.stringify({ enabled, port }),
  });
}

export function revokeDevice(id: string) {
  return apiJson<DevicesOverview>(`/api/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** /device: find the waiting device that shows this code. */
export function lookupRequest(code: string) {
  return apiJson<DeviceRequest>(
    `/api/devices/requests/lookup?code=${encodeURIComponent(code)}`,
  );
}

export function answerRequest(id: string, approve: boolean) {
  return apiJson<DeviceRequest>(
    `/api/devices/requests/${encodeURIComponent(id)}/${approve ? "approve" : "deny"}`,
    { method: "POST" },
  );
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationPath: string;
  verificationPathComplete: string;
  expiresIn: number;
  interval: number;
}

export interface PairResult {
  token: string;
  user: BackendUser;
  device: PairedDevice;
}

/** What a poll can answer before the token (RFC 8628 error codes). */
export type PollState =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied";

async function devicePost<T>(server: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("unreachable");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data as T;
}

/**
 * Ask the Amiro at `server` to connect this device. Raw fetches on purpose:
 * `server` is not the backend this app talks to yet, and the flow needs no
 * credentials.
 */
export function startDeviceAuthorization(
  server: string,
  input: { name: string; platform: DevicePlatform },
) {
  return devicePost<DeviceAuthorization>(server, "/api/devices/authorize", input);
}

/** One poll: the token once approved, otherwise the state to keep waiting on. */
export async function pollDeviceToken(
  server: string,
  deviceCode: string,
): Promise<PairResult | PollState> {
  try {
    return await devicePost<PairResult>(server, "/api/devices/token", { deviceCode });
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (
      code === "authorization_pending" ||
      code === "slow_down" ||
      code === "expired_token" ||
      code === "access_denied"
    ) {
      return code;
    }
    throw e;
  }
}

/**
 * Plain http is only for addresses on your own network (Wi-Fi, Tailscale,
 * this computer). Anything reached over the internet must be https: the
 * owner signs in there to approve.
 */
export function serverAddressAllowed(server: string): boolean {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".ts.net")) {
    return true;
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return host === "::1";
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // Tailscale / carrier-grade NAT
    (a === 169 && b === 254)
  );
}

/**
 * The server address in what the user typed or scanned: a link to one of its
 * pages (`http://192.168.1.5:8790/pair`) or a bare address. Returns the
 * origin without a trailing slash, or null. `code` is any `?code=` on it.
 */
export function parsePairingInput(value: string): {
  server: string | null;
  code: string | null;
} {
  const trimmed = value.trim();
  if (!trimmed) return { server: null, code: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { server: null, code: null };
    }
    return { server: url.origin, code: url.searchParams.get("code") };
  } catch {
    return { server: null, code: null };
  }
}

/** Which kind of device this is; the pair page names it from this. */
export function guessPlatform(
  userAgent: string,
  desktopApp: boolean,
): DevicePlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return desktopApp ? "desktop" : "web";
}
