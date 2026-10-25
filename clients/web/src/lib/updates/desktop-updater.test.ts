import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkDesktopUpdate,
  installDesktopUpdate,
  isDesktopApp,
  progressPercent,
} from "./desktop-updater";

type W = Record<string, unknown>;

// Vitest runs in Node: stand in a bare window, like a plain browser tab.
let win: W;
beforeEach(() => {
  win = {};
  vi.stubGlobal("window", win);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function desktop(invoke: (cmd: string) => Promise<unknown>, listen?: unknown) {
  win.__AMIRO_DESKTOP__ = true;
  win.__TAURI__ = { core: { invoke }, event: { listen } };
}

describe("desktop updater bridge", () => {
  it("is off in a plain browser", async () => {
    expect(isDesktopApp()).toBe(false);
    await expect(checkDesktopUpdate()).rejects.toThrow(/desktop app/);
  });

  it("checks through the shell's command", async () => {
    const invoke = vi.fn().mockResolvedValue({ current: "1.27.0", available: true, version: "1.28.0", supported: true });
    desktop(invoke);
    expect(isDesktopApp()).toBe(true);
    await expect(checkDesktopUpdate()).resolves.toMatchObject({ version: "1.28.0" });
    expect(invoke).toHaveBeenCalledWith("desktop_update_check");
  });

  it("streams progress while installing and stops listening afterwards", async () => {
    const unlisten = vi.fn();
    let handler: ((e: { payload: unknown }) => void) | undefined;
    const listen = vi.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return unlisten;
    });
    const invoke = vi.fn(async () => {
      handler?.({ payload: { phase: "downloading", received: 50, total: 200 } });
      throw new Error("signature mismatch");
    });
    desktop(invoke, listen);
    const seen: unknown[] = [];
    await expect(installDesktopUpdate((p) => seen.push(p))).rejects.toThrow("signature mismatch");
    expect(listen).toHaveBeenCalledWith("amiro://update-progress", expect.any(Function));
    expect(invoke).toHaveBeenCalledWith("desktop_update_install");
    expect(seen).toEqual([{ phase: "downloading", received: 50, total: 200 }]);
    expect(unlisten).toHaveBeenCalled();
  });

  it("turns download progress into a percentage", () => {
    expect(progressPercent({ phase: "downloading", received: 50, total: 200 })).toBe(25);
    expect(progressPercent({ phase: "downloading", received: 10, total: null })).toBeNull();
    expect(progressPercent({ phase: "installing" })).toBeNull();
    expect(progressPercent(null)).toBeNull();
  });
});
