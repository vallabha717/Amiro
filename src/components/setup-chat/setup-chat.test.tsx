import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { DEFAULT_CHARACTER_TRAITS } from "@/lib/agent/character-catalog";
import { SETUP_STEPS, answerTurn, firstTurn } from "@/lib/onboarding/setup-flow";
import { DoneCard } from "./cards/done-card";
import { SecretField } from "./cards/search-cards";
import { StoryPanel, chapterOf, chapterState } from "./story-panel";
import { StreamingText } from "./streaming-text";

function render(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      timeZone: "UTC",
      messages: en,
      children: element,
    }),
  );
}

describe("setup chat pieces", () => {
  it("gives a finished line its full text, once, as the accessible name", () => {
    const html = render(createElement(StreamingText, { text: "Hi! I'm Amiro.", instant: true }));
    expect(html).toContain('aria-label="Hi! I&#x27;m Amiro."');
    expect(html).toContain('data-streaming="done"');
  });

  it("starts a streaming line empty, typing", () => {
    const html = render(createElement(StreamingText, { text: "Streaming soon" }));
    expect(html).toContain('data-streaming="typing"');
    expect(html).not.toContain(">Streaming soon<");
  });

  it("asks for keys in a password field that points at the vault", () => {
    const html = render(
      createElement(SecretField, {
        id: "k",
        label: "Brave API key",
        value: "",
        onChange: () => {},
        docsUrl: "https://example.test/keys",
        docsLabel: "Get a key",
        testId: "setup-key",
      }),
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("Never shown again, never in the chat.");
    expect(html).toContain('href="https://example.test/keys"');
  });

  it("sums up what was set up and what was left for later", () => {
    let turns = firstTurn();
    for (const reply of ["Let's go", "Teal · Sprout", "Looks good", "Balanced"]) {
      turns = answerTurn(turns, reply);
    }
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // provider
    turns = answerTurn(turns, "DuckDuckGo"); // search
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // connectors
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // voice
    const html = render(
      createElement(DoneCard, { mode: "team", name: "Scout", turns, onFinish: async () => {} }),
    );
    expect(html).toContain('data-testid="setup-summary-search" data-state="done"');
    expect(html).toContain('data-testid="setup-summary-provider" data-state="later"');
    expect(html).toContain('data-testid="setup-summary-voice" data-state="later"');
    expect(html).toContain("Open Scout&#x27;s thread");
  });
});

describe("story panel", () => {
  const story = (step: Parameters<typeof StoryPanel>[0]["step"]) =>
    render(
      createElement(StoryPanel, {
        step,
        turns: firstTurn(),
        traits: DEFAULT_CHARACTER_TRAITS,
        accent: "#0E9B8B",
      }),
    );

  it("tells every step's chapter, and a follow-up tells its parent's", () => {
    for (const step of SETUP_STEPS) {
      const html = story(step);
      expect(html).toContain(`data-step="${step}"`);
      expect(html).not.toContain("SetupChat.story");
    }
    const html = story("providerConnect");
    expect(html).toContain("Choose a brain for your agent to think with");
    expect(html).toContain("Chapter 4 of 7");
    expect(story("connectors")).toContain("Give your agent the superpowers it needs");
  });

  it("marks the journey: done, current, later and upcoming", () => {
    let turns = firstTurn();
    for (const reply of ["Let's go", "Teal · Sprout", "Looks good"]) {
      turns = answerTurn(turns, reply);
    }
    turns = answerTurn(turns, "Keep the default", { skipped: true }); // personality
    expect(chapterState("look", "provider", turns)).toBe("done");
    expect(chapterState("personality", "provider", turns)).toBe("later");
    expect(chapterState("provider", "provider", turns)).toBe("current");
    expect(chapterState("voice", "provider", turns)).toBe("upcoming");
    expect(chapterOf("searchConnect")).toBe("search");
  });
});
