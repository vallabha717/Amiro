"use client";
import { describe, expect, it, vi } from "vitest";
import {
  isComposioTerminalStatus,
  pollComposioConnectionStatus,
} from "./connect-flow";

describe("isComposioTerminalStatus", () => {
  it("treats ACTIVE, FAILED and EXPIRED as terminal", () => {
    expect(isComposioTerminalStatus("ACTIVE")).toBe(true);
    expect(isComposioTerminalStatus("FAILED")).toBe(true);
    expect(isComposioTerminalStatus("EXPIRED")).toBe(true);
    expect(isComposioTerminalStatus("INITIATED")).toBe(false);
  });
});

describe("pollComposioConnectionStatus", () => {
  it("resolves once the connection leaves INITIATED", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "INITIATED" })
      .mockResolvedValueOnce({ status: "INITIATED" })
      .mockResolvedValueOnce({ status: "ACTIVE" });
    const status = await pollComposioConnectionStatus("c1", {
      maxAttempts: 5,
      intervalMs: 0,
      getStatus,
    });
    expect(status).toBe("ACTIVE");
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(getStatus).toHaveBeenCalledWith("c1");
  });

  it("returns FAILED instead of retrying forever", async () => {
    const getStatus = vi.fn().mockResolvedValue({ status: "FAILED" });
    await expect(
      pollComposioConnectionStatus("c1", {
        maxAttempts: 3,
        intervalMs: 0,
        getStatus,
      }),
    ).resolves.toBe("FAILED");
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("throws when the status never settles", async () => {
    const getStatus = vi.fn().mockResolvedValue({ status: "INITIATED" });
    await expect(
      pollComposioConnectionStatus("c1", {
        maxAttempts: 3,
        intervalMs: 0,
        getStatus,
      }),
    ).rejects.toThrow("still INITIATED after 3 checks");
  });
});
