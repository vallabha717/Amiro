import { describe, expect, it, vi } from "vitest";
import { COMPOSER_COMMANDS, findComposerFiles, matchCommands, runComposerCommand } from "./composer-api";

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn().mockResolvedValue({}),
}));

describe("matchCommands", () => {
  it("lists every command for a bare slash", () => {
    expect(matchCommands("")).toEqual([...COMPOSER_COMMANDS]);
  });

  it("puts name-prefix matches before other matches", () => {
    expect(matchCommands("c")).toEqual(["compact", "context", "cache", "mcp"]);
    expect(matchCommands("model")).toEqual(["refresh-model-list"]);
    expect(matchCommands("nope")).toEqual([]);
  });
});

describe("composer api", () => {
  it("posts a command with its thread", async () => {
    const { apiJson } = await import("@/lib/backend/client");
    await runComposerCommand({ command: "compact", threadId: "t1" });
    expect(vi.mocked(apiJson)).toHaveBeenLastCalledWith("/api/composer/command", {
      method: "POST",
      body: JSON.stringify({ command: "compact", threadId: "t1" }),
    });
  });

  it("searches files with only the parameters it has", async () => {
    const { apiJson } = await import("@/lib/backend/client");
    await findComposerFiles({ q: "read me", threadId: "t1", limit: 10 });
    expect(vi.mocked(apiJson)).toHaveBeenLastCalledWith("/api/composer/files?q=read+me&threadId=t1&limit=10");
  });
});
