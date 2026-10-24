import { describe, expect, it } from "vitest";
import {
  desktopStateKey,
  toHostPath,
  windowLocation,
  windowsFromToolText,
} from "./desktop-api";

describe("desktop-api", () => {
  it("keys the state by agent", () => {
    expect(desktopStateKey("main")).toBe("/api/desktop/state?agentId=main");
    expect(desktopStateKey("a b")).toBe("/api/desktop/state?agentId=a%20b");
  });

  it("reads exact folders and URLs from a desktop tool result", () => {
    const text = [
      "Opened files on your desktop.",
      "Open on your desktop (the user watches it on the TV):",
      "- Browser — https://example.com/ (Example Domain)",
      "- Files — /home/agent/projects/demo (in front)",
      "- Terminal — /home/agent/my projects",
    ].join("\n");
    expect(windowsFromToolText(text)).toEqual([
      {
        app: "browser",
        url: "https://example.com/",
        title: "Example Domain",
        active: false,
      },
      {
        app: "files",
        path: "/home/agent/projects/demo",
        title: "/home/agent/projects/demo",
        active: true,
      },
      {
        app: "terminal",
        path: "/home/agent/my projects",
        title: "/home/agent/my projects",
        active: false,
      },
    ]);
  });

  it("finds no windows in an error or an empty desktop", () => {
    expect(windowsFromToolText("Your desktop is running with no windows open.")).toEqual([]);
    expect(windowsFromToolText("")).toEqual([]);
  });

  it("maps the agent's home to its workspace on the owner's computer", () => {
    const host = "/home/o/.amiro/agents/main";
    expect(toHostPath("/home/agent", host)).toBe(host);
    expect(toHostPath("/home/agent/projects/x", host)).toBe(`${host}/projects/x`);
    expect(toHostPath("/home/agentx", host)).toBe("/home/agentx");
    expect(toHostPath("/tmp", host)).toBe("/tmp");
    expect(toHostPath("/home/agent/a", undefined)).toBe("/home/agent/a");
  });

  it("prefers the folder on the owner's computer, then the address, then the title", () => {
    expect(
      windowLocation({ app: "files", title: "x", path: "/home/agent", hostPath: "/h/main", active: false }),
    ).toBe("/h/main");
    expect(windowLocation({ app: "files", title: "x", path: "/a", active: false })).toBe("/a");
    expect(windowLocation({ app: "browser", title: "T", url: "https://u/", active: false })).toBe("https://u/");
    expect(windowLocation({ app: "other", title: "T", active: false })).toBe("T");
  });
});
