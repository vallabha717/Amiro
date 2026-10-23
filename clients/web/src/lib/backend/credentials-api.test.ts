"use client";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIALS_CACHE_KEY,
  deleteCredential,
  listCredentials,
  saveCredential,
  toCredentialEnvVar,
  validateCredential,
} from "./credentials-api";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

const memoryStorage = new MemoryStorage();
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = {};
}
Object.defineProperty(globalThis.window, "localStorage", {
  value: memoryStorage,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  writable: true,
  configurable: true,
});

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock("./client", () => ({ apiJson }));

beforeEach(() => {
  vi.clearAllMocks();
  memoryStorage.clear();
});

describe("toCredentialEnvVar", () => {
  it("normalizes service and field to uppercase and replaces non-alphanumeric with underscores", () => {
    expect(toCredentialEnvVar("github", "token")).toBe("AMIRO_CRED_GITHUB_TOKEN");
    expect(toCredentialEnvVar("openai", "api_key")).toBe(
      "AMIRO_CRED_OPENAI_API_KEY",
    );
    expect(toCredentialEnvVar("9router", "api-key")).toBe(
      "AMIRO_CRED_9ROUTER_API_KEY",
    );
    expect(toCredentialEnvVar("custom.service", "client.secret")).toBe(
      "AMIRO_CRED_CUSTOM_SERVICE_CLIENT_SECRET",
    );
  });
});

describe("credentials API client", () => {
  describe("listCredentials", () => {
    it("fetches credentials via GET /api/credentials and caches them", async () => {
      const mockItems = [
        {
          id: "github/token",
          service: "github",
          field: "token",
          label: "GitHub PAT",
          hint: "••••9999",
          updatedAt: "2026-10-18T00:00:00Z",
        },
      ];
      apiJson.mockResolvedValue({ items: mockItems });

      const res = await listCredentials();
      expect(apiJson).toHaveBeenCalledWith("/api/credentials", {
        method: "GET",
      });
      expect(res).toEqual([
        {
          ...mockItems[0],
          envVar: "AMIRO_CRED_GITHUB_TOKEN",
        },
      ]);

      const cached = JSON.parse(
        localStorage.getItem(CREDENTIALS_CACHE_KEY) || "[]",
      );
      expect(cached).toEqual(res);
    });

    it("falls back to localStorage cache if backend is offline or returns error", async () => {
      const cachedItems = [
        {
          id: "stripe/secret_key",
          service: "stripe",
          field: "secret_key",
          label: "Stripe Key",
          hint: "••••1234",
          envVar: "AMIRO_CRED_STRIPE_SECRET_KEY",
          updatedAt: "2026-10-18T00:00:00Z",
        },
      ];
      localStorage.setItem(
        CREDENTIALS_CACHE_KEY,
        JSON.stringify(cachedItems),
      );

      apiJson.mockRejectedValue(new Error("Network Error"));

      const res = await listCredentials();
      expect(res).toEqual(cachedItems);
    });

    it("rethrows error when backend fails and no cache exists", async () => {
      apiJson.mockRejectedValue(new Error("500 Internal Server Error"));

      await expect(listCredentials()).rejects.toThrow(
        "500 Internal Server Error",
      );
    });
  });

  describe("saveCredential", () => {
    it("saves credential with PUT /api/credentials and updates cache", async () => {
      const input = {
        service: "composio",
        field: "api_key",
        value: "sk-comp-12345678",
        label: "Composio Production",
        usageDescription: "Tool execution",
        allowedTools: ["github", "gmail"],
        allowedDomains: ["api.composio.dev"],
      };

      const backendResponse = {
        id: "composio/api_key",
        service: "composio",
        field: "api_key",
        label: "Composio Production",
        hint: "••••5678",
        updatedAt: "2026-10-18T01:00:00Z",
      };
      apiJson.mockResolvedValue(backendResponse);

      const result = await saveCredential(input);
      expect(apiJson).toHaveBeenCalledWith("/api/credentials", {
        method: "PUT",
        body: JSON.stringify(input),
      });

      expect(result).toEqual({
        ...backendResponse,
        envVar: "AMIRO_CRED_COMPOSIO_API_KEY",
        usageDescription: "Tool execution",
        allowedTools: ["github", "gmail"],
        allowedDomains: ["api.composio.dev"],
      });

      const cached = JSON.parse(
        localStorage.getItem(CREDENTIALS_CACHE_KEY) || "[]",
      );
      expect(cached).toHaveLength(1);
      expect(cached[0].id).toBe("composio/api_key");
    });
  });

  describe("deleteCredential", () => {
    it("deletes credential with DELETE /api/credentials/:service/:field and updates cache", async () => {
      const initialCache = [
        {
          id: "slack/token",
          service: "slack",
          field: "token",
          hint: "••••1111",
          envVar: "AMIRO_CRED_SLACK_TOKEN",
          updatedAt: "2026-10-18T00:00:00Z",
        },
        {
          id: "github/token",
          service: "github",
          field: "token",
          hint: "••••2222",
          envVar: "AMIRO_CRED_GITHUB_TOKEN",
          updatedAt: "2026-10-18T00:00:00Z",
        },
      ];
      localStorage.setItem(
        CREDENTIALS_CACHE_KEY,
        JSON.stringify(initialCache),
      );

      apiJson.mockResolvedValue({ success: true });

      const res = await deleteCredential("slack", "token");
      expect(apiJson).toHaveBeenCalledWith("/api/credentials/slack/token", {
        method: "DELETE",
      });
      expect(res).toEqual({ success: true });

      const cached = JSON.parse(
        localStorage.getItem(CREDENTIALS_CACHE_KEY) || "[]",
      );
      expect(cached).toHaveLength(1);
      expect(cached[0].id).toBe("github/token");
    });
  });

  describe("validateCredential", () => {
    it("validates credential with POST /api/credentials/validate", async () => {
      apiJson.mockResolvedValue({ valid: true });

      const res = await validateCredential("composio", "api_key");
      expect(apiJson).toHaveBeenCalledWith("/api/credentials/validate", {
        method: "POST",
        body: JSON.stringify({ service: "composio", field: "api_key" }),
      });
      expect(res).toEqual({ valid: true });
    });
  });
});
