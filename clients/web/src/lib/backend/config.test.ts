import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backendUrl,
  connectToRemote,
  disconnectRemote,
  getBackendBaseUrl,
  getBackendSharedSecret,
  getRemoteOrigin,
  getSessionToken,
  hasLocalBackend,
  setSessionToken,
} from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("backend URL configuration", () => {
  it("uses relative API URLs for an explicitly empty backend URL", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");
    expect(getBackendBaseUrl()).toBe("");
    expect(backendUrl("/api/auth/setup")).toBe("/api/auth/setup");
  });
  it("preserves an explicitly configured backend", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://api.example.com");
    expect(backendUrl("/api/auth/login")).toBe(
      "https://api.example.com/api/auth/login",
    );
  });
  it("defaults to the local backend when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", undefined);
    expect(getBackendBaseUrl()).toBe("http://127.0.0.1:8787");
  });
});

describe("connecting to another Amiro", () => {
  function desktopWindow() {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      __BACKEND_PORT__: 4321,
      __BACKEND_TOKEN__: "local-sidecar-secret",
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  it("talks to the remote server with its device session, never the local secret", () => {
    desktopWindow();
    setSessionToken("local-session");
    expect(getBackendBaseUrl()).toBe("http://127.0.0.1:4321");
    expect(getBackendSharedSecret()).toBe("local-sidecar-secret");

    connectToRemote("https://amiro.example.com", "device-session");
    expect(getRemoteOrigin()).toBe("https://amiro.example.com");
    expect(backendUrl("/api/x")).toBe("https://amiro.example.com/api/x");
    expect(getBackendSharedSecret()).toBe("");
    expect(getSessionToken()).toBe("device-session");
    expect(hasLocalBackend()).toBe(true);
  });

  it("keeps the local sign-in for switching back", () => {
    desktopWindow();
    setSessionToken("local-session");
    connectToRemote("https://amiro.example.com", "device-session");
    // Signed out remotely: only the device session goes.
    setSessionToken(null);
    expect(getSessionToken()).toBeNull();
    expect(getRemoteOrigin()).toBe("https://amiro.example.com");

    disconnectRemote();
    expect(getRemoteOrigin()).toBeNull();
    expect(getSessionToken()).toBe("local-session");
    expect(getBackendBaseUrl()).toBe("http://127.0.0.1:4321");
  });
});
