import { describe, expect, it } from "vitest";
import { getToolPresenter } from "./index";
import { desktopGlance, isDesktopToolCall } from "./desktop-presenters";

describe("desktop presenters", () => {
  it("say what was opened and where", () => {
    expect(
      desktopGlance("desktop_open", {
        input: { app: "files", target: "/home/agent/docs" },
        output: undefined,
        status: "pending",
      }),
    ).toBe("desktop · opening files /home/agent/docs");
    expect(
      desktopGlance("agent_desktop_open", {
        input: { app: "browser", target: "https://example.com" },
        output: "ok",
        status: "success",
      }),
    ).toBe("desktop · opened browser https://example.com");
    expect(
      desktopGlance("desktop_state", { input: {}, output: "x", status: "success" }),
    ).toBe("desktop · looked at the screen");
    expect(
      desktopGlance("desktop_open", { input: {}, output: undefined, status: "error" }),
    ).toBe("⚠ desktop open failed");
  });

  it("are registered for the main agent's MCP tools and team agents' own tools", () => {
    for (const name of [
      "desktop_open",
      "desktop_state",
      "agent_desktop_open",
      "agent_desktop_state",
      "mcp__amiro__desktop_open",
    ]) {
      expect(getToolPresenter(name), name).toBeDefined();
    }
  });

  it("recognise desktop calls however the runtime names them", () => {
    expect(isDesktopToolCall("agent_desktop_open", {})).toBe(true);
    expect(isDesktopToolCall("mcp__amiro__desktop_state", {})).toBe(true);
    expect(isDesktopToolCall("mcp_call", { server: "amiro", tool: "desktop_open" })).toBe(true);
    expect(isDesktopToolCall("mcp_call", { server: "amiro", tool: "artifact_create" })).toBe(false);
    expect(isDesktopToolCall("mcp_call", { server: "other", tool: "desktop_open" })).toBe(false);
    expect(isDesktopToolCall("agent_shell", {})).toBe(false);
    expect(isDesktopToolCall(undefined, {})).toBe(false);
  });

  it("give desktop calls through mcp_call the TV glance and leave others alone", () => {
    const mcp = getToolPresenter("mcp_call")!;
    expect(
      mcp.glance({
        input: { server: "amiro", tool: "desktop_open", arguments: { app: "terminal", target: "src" } },
        output: undefined,
        status: "pending",
      }),
    ).toBe("desktop · opening terminal src");
    expect(
      mcp.glance({
        input: { server: "github", tool: "desktop_open", arguments: {} },
        output: undefined,
        status: "pending",
      }),
    ).not.toContain("desktop ·");
  });
});
