import { afterEach, describe, expect, it, vi } from "vitest";
import { pathAfterSignIn } from "./auth-gate";

afterEach(() => vi.unstubAllGlobals());

function at(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

describe("pathAfterSignIn", () => {
  it("goes back to the page that asked for sign-in", () => {
    at(`?next=${encodeURIComponent("/device?code=ABCD-EFGH")}`);
    expect(pathAfterSignIn()).toBe("/device?code=ABCD-EFGH");
  });

  it("defaults to Team and never leaves the site", () => {
    at("");
    expect(pathAfterSignIn()).toBe("/team");
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      at(`?next=${encodeURIComponent(next)}`);
      expect(pathAfterSignIn(), next).toBe("/team");
    }
  });
});
