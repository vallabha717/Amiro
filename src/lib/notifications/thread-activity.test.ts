import { describe, expect, it } from "vitest";
import { threadStatusOf } from "./thread-activity";

const activity = { running: ["a"], unseen: ["a", "b", "c"], failed: ["c"] };

describe("threadStatusOf", () => {
  it("puts working first, then a failure, then an unseen reply", () => {
    expect(threadStatusOf(activity, "a")).toBe("running");
    expect(threadStatusOf(activity, "c")).toBe("failed");
    expect(threadStatusOf(activity, "b")).toBe("unseen");
    expect(threadStatusOf(activity, "z")).toBeNull();
  });

  it("hides unseen marks on the chat that is open, but not working", () => {
    expect(threadStatusOf(activity, "b", "b")).toBeNull();
    expect(threadStatusOf(activity, "c", "c")).toBeNull();
    expect(threadStatusOf(activity, "a", "a")).toBe("running");
  });

  it("shows nothing before the first load", () => {
    expect(threadStatusOf(undefined, "a")).toBeNull();
  });
});
