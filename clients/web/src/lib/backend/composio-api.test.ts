"use client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComposioToolkitsPath,
  removeComposioApiKey,
  removeComposioConnection,
  saveComposioApiKey,
  selectComposioConfig,
  selectComposioConnectionStatus,
  selectComposioConnections,
  selectComposioToolkits,
  startComposioConnect,
  syncComposioConnections,
} from "./composio-api";

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock("./client", () => ({ apiJson }));

beforeEach(() => vi.clearAllMocks());

describe("buildComposioToolkitsPath", () => {
  it("returns the bare path with no params", () => {
    expect(buildComposioToolkitsPath()).toBe("/api/composio/toolkits");
    expect(buildComposioToolkitsPath({})).toBe("/api/composio/toolkits");
  });

  it("trims blank search and omits empty params", () => {
    expect(buildComposioToolkitsPath({ search: "   " })).toBe(
      "/api/composio/toolkits",
    );
  });

  it("encodes search, cursor and limit", () => {
    expect(
      buildComposioToolkitsPath({
        search: "google drive",
        cursor: "abc",
        limit: 24,
      }),
    ).toBe("/api/composio/toolkits?search=google+drive&cursor=abc&limit=24");
  });
});

describe("composio API client", () => {
  it("fetches config with GET", async () => {
    apiJson.mockResolvedValue({
      configured: true,
      source: "ui",
      apiKeyHint: "...abcd",
    });
    expect(await selectComposioConfig()).toEqual({
      configured: true,
      source: "ui",
      apiKeyHint: "...abcd",
    });
    expect(apiJson).toHaveBeenCalledWith("/api/composio/config", {
      method: "GET",
    });
  });

  it("saves the API key with PUT", async () => {
    apiJson.mockResolvedValue({ configured: true, source: "ui" });
    await saveComposioApiKey("secret-key");
    expect(apiJson).toHaveBeenCalledWith("/api/composio/config", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "secret-key" }),
    });
  });

  it("removes the API key with DELETE", async () => {
    apiJson.mockResolvedValue(undefined);
    await removeComposioApiKey();
    expect(apiJson).toHaveBeenCalledWith("/api/composio/config", {
      method: "DELETE",
    });
  });

  it("lists toolkits via the path builder", async () => {
    apiJson.mockResolvedValue({ items: [], nextCursor: null });
    await selectComposioToolkits({ search: "slack", limit: 24 });
    expect(apiJson).toHaveBeenCalledWith(
      "/api/composio/toolkits?search=slack&limit=24",
      { method: "GET" },
    );
  });

  it("lists connections with GET", async () => {
    apiJson.mockResolvedValue([]);
    await selectComposioConnections();
    expect(apiJson).toHaveBeenCalledWith("/api/composio/connections", {
      method: "GET",
    });
  });

  it("starts a connect with POST", async () => {
    apiJson.mockResolvedValue({ redirectUrl: "https://x", connectionId: "c1" });
    await startComposioConnect("github");
    expect(apiJson).toHaveBeenCalledWith("/api/composio/connect", {
      method: "POST",
      body: JSON.stringify({ toolkit: "github" }),
    });
  });

  it("polls status and deletes by encoded connection id", async () => {
    apiJson.mockResolvedValue({ status: "ACTIVE", synced: true });
    await selectComposioConnectionStatus("a/b");
    expect(apiJson).toHaveBeenCalledWith(
      "/api/composio/connections/a%2Fb/status",
      { method: "GET" },
    );
    await removeComposioConnection("a/b");
    expect(apiJson).toHaveBeenCalledWith("/api/composio/connections/a%2Fb", {
      method: "DELETE",
    });
  });

  it("syncs connections with POST", async () => {
    apiJson.mockResolvedValue({ synced: true, toolkits: [], reloaded: true });
    await syncComposioConnections();
    expect(apiJson).toHaveBeenCalledWith("/api/composio/sync", {
      method: "POST",
    });
  });
});
