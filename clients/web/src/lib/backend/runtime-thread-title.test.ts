import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appStore } from "@/app/store";
import { MarqueeText } from "ui/marquee-text";
import { applyRuntimeThreadTitle } from "./runtime-thread-title";
import {
  extractSessionShortName,
  formatThreadAnimalTitle,
  memberName,
  sessionAnimalIcon,
} from "./swarm-api";

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
    appStore.setState({ threadList: [], currentThreadId: null });
    applyRuntimeThreadTitle({ threadId: "one", title: "Late title" }, "one");
    expect(appStore.getState().threadList).toEqual([]);
  });

  it("extracts animal short names and emojis for chat titles and coordinator/swarm agents", () => {
    expect(
      extractSessionShortName("session_octopus_1792835224856_be32b6294e9062e8"),
    ).toBe("octopus");
    expect(sessionAnimalIcon("octopus")).toBe("🐙");
    expect(sessionAnimalIcon("humpback")).toBe("🐳");
    expect(sessionAnimalIcon("peacock")).toBe("🦚");

    expect(
      formatThreadAnimalTitle({
        title: "Inbox Cleanup Setup",
        sessionId: "session_octopus_1792835224856_be32b6294e9062e8",
      }),
    ).toBe("🐙 octopus · Inbox Cleanup Setup");

    expect(
      memberName(
        {
          sessionId: "session_octopus_1792835224856_be32b6294e9062e8",
          userConnected: true,
        },
        true,
      ),
    ).toBe("🐙 octopus");

    expect(
      memberName({
        sessionId: "session_humpback_1792835392474_9e7032ff1b40edf0",
        label: "mars-researcher",
        userConnected: false,
      }),
    ).toBe("🐳 humpback · mars-researcher");
  });

  it("renders Vellum-style MarqueeText with static truncate and animated hover sibling", () => {
    const html = renderToStaticMarkup(
      createElement(MarqueeText, {
        "data-testid": "sidebar-thread-title",
        children: "🐙 octopus · Inbox Cleanup Schedule Studio Setup",
      }),
    );
    expect(html).toContain('data-slot="marquee-text"');
    expect(html).toContain('data-slot="marquee-text-animated"');
    expect(html).toContain("motion-safe:group-hover/thread:invisible");
    expect(html).toContain("motion-safe:group-hover/thread:visible");
    expect(html).toContain("🐙 octopus · Inbox Cleanup Schedule Studio Setup");
  });
});
