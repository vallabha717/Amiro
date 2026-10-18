import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateSearchProvider,
  selectSearchCatalog,
} from "./search-provider-api";

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock("./client", () => ({ apiJson }));

beforeEach(() => vi.clearAllMocks());

describe("search provider API", () => {
  it("does not expose the removed Vellum search catalogue entry", async () => {
    const free = { kind: "duckduckgo", label: "DuckDuckGo", keyless: true };
    const custom = { kind: "custom", label: "Custom HTTP JSON" };
    apiJson.mockResolvedValue([
      free,
      { kind: "vellum", label: "Vellum" },
      { kind: "VELLUM", label: "Legacy" },
      custom,
    ]);
    expect(await selectSearchCatalog()).toEqual([free, custom]);
    expect(apiJson).toHaveBeenCalledWith("/api/search/catalog", {
      method: "GET",
    });
  });

  it("sets the default using the existing activation endpoint", async () => {
    await activateSearchProvider("saved-provider");
    expect(apiJson).toHaveBeenCalledWith(
      "/api/search/providers/saved-provider/activate",
      { method: "POST" },
    );
  });
});
