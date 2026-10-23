import { describe, expect, it, vi } from "vitest";
import { createPresenceQueue, IDLE_AFTER_MS, isPresent } from "./presence";

describe("isPresent", () => {
  const now = 1_000_000_000;
  it("needs the tab visible, focused and touched recently", () => {
    expect(isPresent({ visible: true, focused: true, lastInputAt: now, now })).toBe(true);
    expect(isPresent({ visible: false, focused: true, lastInputAt: now, now })).toBe(false);
    expect(isPresent({ visible: true, focused: false, lastInputAt: now, now })).toBe(false);
    expect(
      isPresent({ visible: true, focused: true, lastInputAt: now - IDLE_AFTER_MS - 1, now }),
    ).toBe(false);
  });
});

describe("createPresenceQueue", () => {
  const report = (threadId: string | null, visible = true) => ({
    clientId: "tab",
    visible,
    threadId,
  });

  it("sends one at a time and keeps only the newest waiting report", async () => {
    let release: () => void = () => {};
    const sent: unknown[] = [];
    const send = vi.fn((r: unknown) => {
      sent.push(r);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const queue = createPresenceQueue(send);
    queue.push(report("a"));
    queue.push(report("b"));
    queue.push(report(null));
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    release();
    expect(sent).toEqual([report("a"), report(null)]);
  });

  it("skips an unchanged report unless forced", async () => {
    const send = vi.fn(() => Promise.resolve());
    const queue = createPresenceQueue(send);
    queue.push(report("a"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    queue.push(report("a"));
    expect(send).toHaveBeenCalledTimes(1);
    queue.push(report("a"), true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it("keeps going after a failed send", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const queue = createPresenceQueue(send);
    queue.push(report("a"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    queue.push(report("b"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
});
