import { describe, expect, it } from "vitest";

import { displayBuild, displayVersion, isStaleUi, sameCommit, sameVersion } from "./version";

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
    const ui = { version: "1.27.0" };
    expect(isStaleUi({ version: "1.28.0" }, ui)).toBe(true);
    expect(isStaleUi({ version: "1.27.0" }, ui)).toBe(false);
    expect(isStaleUi({ version: "v1.27.0" }, ui)).toBe(false);
    // An older server without a version, or a dev build: never stale.
    expect(isStaleUi({ version: null }, ui)).toBe(false);
    expect(isStaleUi(null, ui)).toBe(false);
    expect(isStaleUi({ version: "1.28.0" }, { version: "" })).toBe(false);
  });

  it("offers a reload when a server that follows a branch runs another commit", () => {
    const ui = { version: "1.27.0", commit: "9ecb917" };
    expect(isStaleUi({ version: "1.27.0", commit: "091e80b" }, ui)).toBe(true);
    expect(isStaleUi({ version: "1.27.0", commit: "9ecb91775f114fbc" }, ui)).toBe(false);
    // Either side without a commit (a release build): versions decide.
    expect(isStaleUi({ version: "1.27.0", commit: null }, ui)).toBe(false);
    expect(isStaleUi({ version: "1.27.0", commit: "091e80b" }, { version: "1.27.0" })).toBe(false);
    expect(sameCommit("9ecb917", "9ecb91775f")).toBe(true);
    expect(sameCommit("", "9ecb917")).toBe(false);
    expect(displayBuild({ version: "1.27.0", commit: "091e80b6d1" })).toBe("v1.27.0 (091e80b)");
    expect(displayBuild({ version: "1.27.0" })).toBe("v1.27.0");
  });
});
