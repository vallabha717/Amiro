import { beforeEach, describe, expect, it } from "vitest";
import { appStore } from "@/app/store";
import { applyRuntimeThreadTitle } from "./runtime-thread-title";

describe("runtime thread title mapping", () => {
  beforeEach(() => {
    appStore.setState({
      threadList: [
        { id: "one", title: "New Chat", userId: "u", createdAt: new Date() },
        { id: "two", title: "Other", userId: "u", createdAt: new Date() },
      ],
    });
  });
  it("updates only the matching thread without inserting duplicates", () => {
    expect(
      applyRuntimeThreadTitle(
        { threadId: "one", title: "  Runtime title  " },
        "one",
      ),
    ).toBe(true);
    expect(appStore.getState().threadList.map((t) => t.title)).toEqual([
      "Runtime title",
      "Other",
    ]);
    expect(appStore.getState().threadList).toHaveLength(2);
    applyRuntimeThreadTitle({ threadId: "one", title: "Runtime title" }, "one");
    expect(appStore.getState().threadList).toHaveLength(2);
  });
  it("ignores malformed, blank and mismatched title events", () => {
    for (const value of [
      null,
      {},
      { threadId: "two", title: "Wrong" },
      { threadId: "one", title: 1 },
      { threadId: "one", title: " " },
    ]) {
      expect(applyRuntimeThreadTitle(value, "one")).toBe(false);
    }
    expect(appStore.getState().threadList[0].title).toBe("New Chat");
  });
  it("does not resurrect a deleted sidebar row", () => {
    appStore.setState({ threadList: [] });
    applyRuntimeThreadTitle({ threadId: "one", title: "Late title" }, "one");
    expect(appStore.getState().threadList).toEqual([]);
  });
});
