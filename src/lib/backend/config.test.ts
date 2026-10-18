import { afterEach, describe, expect, it, vi } from "vitest";
import { backendUrl, getBackendBaseUrl } from "./config";

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
