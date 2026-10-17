import { describe, expect, it } from "vitest";

import {
  storedAtToWallLocal,
  validateCronExpression,
  wallTimeToAt,
  presetToCron,
} from "./schedule-helpers";

describe("wallTimeToAt", () => {
  it("is browser-zone independent: does not convert to UTC", () => {
    // Must NOT call new Date().toISOString() which would interpret in browser TZ.
    // Sending wall time verbatim is the contract; backend owns conversion.
    expect(wallTimeToAt("2030-05-06T09:00")).toBe("2030-05-06T09:00:00");
    expect(wallTimeToAt("2030-05-06T09:00:00")).toBe("2030-05-06T09:00:00");
    // Example from coordinator DM: user in UTC browser, selected Asia/Kolkata,
    // typing 09:00 wall must arrive as 09:00 wall, not 09:00Z or converted.
    // wallTimeToAt must be pure string, not Date-dependent.
    const input = "2030-05-06T09:00";
    const at = wallTimeToAt(input);
    expect(at).toBe("2030-05-06T09:00:00");
    // Confirm Date would have mangled it if we had used that path (smoke check
    // that our function is not doing that). In a UTC env new Date(...).toISOString
    // would be same, but in e.g. America/New_York it would shift — we assert we
    // do NOT shift.
    expect(at).not.toBe(new Date(input).toISOString());
  });

  it("handles empty", () => {
    expect(wallTimeToAt("")).toBe("");
  });
});

describe("storedAtToWallLocal", () => {
  it("returns wall slice when stored as wall time without offset", () => {
    expect(storedAtToWallLocal("2026-03-29T02:30:00", "Asia/Kolkata")).toBe("2026-03-29T02:30");
    expect(storedAtToWallLocal("2026-03-29T02:30", "UTC")).toBe("2026-03-29T02:30");
  });

  it("midnight UTC converts to 00 not 24 (hourCycle h23)", () => {
    // 2026-01-01T00:00:00Z is midnight UTC, must render as 00:00 not 24:00
    const wall = storedAtToWallLocal("2026-01-01T00:00:00Z", "UTC");
    expect(wall).toBe("2026-01-01T00:00");
    expect(wall).not.toContain("24:");
  });

  it("converts UTC ISO to Tokyo wall time", () => {
    // 2026-01-01T00:00:00Z is 09:00 in Asia/Tokyo (JST +9)
    expect(storedAtToWallLocal("2026-01-01T00:00:00Z", "Asia/Tokyo")).toBe("2026-01-01T09:00");
  });

  it("converts UTC ISO to Kolkata wall time (IST +5:30)", () => {
    // 2026-01-01T00:00:00Z is 05:30 in Asia/Kolkata
    expect(storedAtToWallLocal("2026-01-01T00:00:00Z", "Asia/Kolkata")).toBe("2026-01-01T05:30");
  });

  it("preserves offset conversion correctly", () => {
    // 2026-06-15T12:00:00+09:00 is 03:00 UTC, 12:00 in Tokyo wall
    expect(storedAtToWallLocal("2026-06-15T12:00:00+09:00", "Asia/Tokyo")).toBe("2026-06-15T12:00");
  });
});

describe("validateCronExpression", () => {
  it("accepts custom step and named weekdays, defers full parse to backend", () => {
    expect(validateCronExpression("*/5 * * * *")).toBeNull();
    expect(validateCronExpression("0 9 * * MON-FRI")).toBeNull();
    expect(validateCronExpression("0-30/5 * * * *")).toBeNull();
  });

  it("rejects wrong field count", () => {
    expect(validateCronExpression("* * * *")).not.toBeNull();
    expect(validateCronExpression("")).not.toBeNull();
  });

  it("accepts standard preset crons", () => {
    expect(validateCronExpression("0 9 * * *")).toBeNull();
    expect(validateCronExpression("0 9 * * 1-5")).toBeNull();
  });
});

describe("presetToCron", () => {
  it("builds expected expressions", () => {
    expect(presetToCron({ kind: "daily", time: "09:00" })).toBe("0 9 * * *");
    expect(presetToCron({ kind: "weekdays", time: "09:00" })).toBe("0 9 * * 1-5");
    expect(presetToCron({ kind: "weekly", time: "09:00", weekday: 1 })).toBe("0 9 * * 1");
    expect(presetToCron({ kind: "monthly", time: "09:00", day: 15 })).toBe("0 9 15 * *");
  });
});
