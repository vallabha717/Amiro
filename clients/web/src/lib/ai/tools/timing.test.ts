import { describe, expect, it } from "vitest";
import { parseToolTiming, stripTimingPrefix } from "./timing";

describe("timing utilities", () => {
  it("parses duration and strips timing header from jcode tool output", () => {
    const raw =
      "[tool timing: start=2026-10-18T07:46:43.641Z finish=2026-10-18T07:46:50.635Z duration=7.0s] \n RUN  v3.2.7";
    const parsed = parseToolTiming(raw);
    expect(parsed.duration).toBe("7.0s");
    expect(parsed.cleanText).toBe("RUN  v3.2.7");
  });

  it("handles duration in milliseconds", () => {
    const raw =
      "[tool timing: start=2026-10-18T07:46:43.641Z finish=2026-10-18T07:46:43.653Z duration=12ms] Edited file.ts";
    const parsed = parseToolTiming(raw);
    expect(parsed.duration).toBe("12ms");
    expect(parsed.cleanText).toBe("Edited file.ts");
    expect(stripTimingPrefix(raw)).toBe("Edited file.ts");
  });

  it("handles string output without timing header safely", () => {
    const raw = "normal output without timing";
    const parsed = parseToolTiming(raw);
    expect(parsed.duration).toBeUndefined();
    expect(parsed.cleanText).toBe("normal output without timing");
    expect(stripTimingPrefix(raw)).toBe("normal output without timing");
  });

  it("handles non-string values safely", () => {
    expect(parseToolTiming(undefined).cleanText).toBe("");
    expect(parseToolTiming(null).cleanText).toBe("");
    expect(parseToolTiming({ key: "value" }).cleanText).toContain("key");
  });
});
