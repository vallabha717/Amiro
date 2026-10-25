import { describe, expect, it } from "vitest";

import { displayVersion, isStaleUi, sameVersion } from "./version";

describe("update versions", () => {
  it("shows every version with one leading v", () => {
    expect(displayVersion("1.27.0")).toBe("v1.27.0");
    expect(displayVersion("v1.27.0")).toBe("v1.27.0");
    expect(displayVersion("")).toBe("");
    expect(displayVersion(null)).toBe("");
  });

  it("compares versions with or without the v", () => {
    expect(sameVersion("v1.27.0", "1.27.0")).toBe(true);
    expect(sameVersion("1.27.0", "1.28.0")).toBe(false);
    expect(sameVersion(null, "1.27.0")).toBe(false);
  });

  it("offers a reload only when the server runs another known release", () => {
    expect(isStaleUi("1.28.0", "1.27.0")).toBe(true);
    expect(isStaleUi("1.27.0", "1.27.0")).toBe(false);
    expect(isStaleUi("v1.27.0", "1.27.0")).toBe(false);
    // An older server without a version, or a dev build: never stale.
    expect(isStaleUi(null, "1.27.0")).toBe(false);
    expect(isStaleUi("1.28.0", "")).toBe(false);
  });
});
