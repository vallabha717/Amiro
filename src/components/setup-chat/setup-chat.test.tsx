import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { DEFAULT_CHARACTER_TRAITS } from "@/lib/agent/character-catalog";
import {
  SETUP_STEPS,
  answerTurn,
  firstTurn,
} from "@/lib/onboarding/setup-flow";
import { DoneCard } from "./cards/done-card";
import { SecretField } from "./cards/search-cards";
import {
  AgentPanel,
  StepPanel,
  chapterAnswer,
  chapterOf,
  chapterState,
} from "./story-panel";
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
    const html = render(
      createElement(StreamingText, { text: "Hi! I'm Amiro.", instant: true }),
    );
    expect(html).toContain('aria-label="Hi! I&#x27;m Amiro."');
    expect(html).toContain('data-streaming="done"');
  });

  it("starts a streaming line empty, typing", () => {
    const html = render(
      createElement(StreamingText, { text: "Streaming soon" }),
    );
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
    for (const reply of [
      "Let's go",
      "Teal · Sprout",
      "Looks good",
      "Balanced",
    ]) {
      turns = answerTurn(turns, reply);
    }
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // provider
    turns = answerTurn(turns, "DuckDuckGo"); // search
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // connectors
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // voice
    turns = answerTurn(turns, "Skip for now", { skipped: true }); // listen
    const html = render(
      createElement(DoneCard, {
        mode: "team",
        name: "Scout",
        turns,
        onFinish: async () => {},
      }),
    );
    expect(html).toContain(
      'data-testid="setup-summary-search" data-state="done"',
    );
    expect(html).toContain(
      'data-testid="setup-summary-provider" data-state="later"',
    );
    expect(html).toContain(
      'data-testid="setup-summary-voice" data-state="later"',
    );
    expect(html).toContain(
      'data-testid="setup-summary-listen" data-state="later"',
    );
    expect(html).toContain(
      "Live voice, a hands-free conversation, runs on ElevenLabs only.",
    );
    expect(html).toContain("Open Scout&#x27;s thread");
  });
});

describe("side panels", () => {
  const story = (step: Parameters<typeof StepPanel>[0]["step"]) =>
    render(createElement(StepPanel, { step }));

  it("tells every step's chapter, and a follow-up tells its parent's", () => {
    for (const step of SETUP_STEPS) {
      const html = story(step);
      expect(html).toContain(`data-step="${step}"`);
      expect(html).not.toContain("SetupChat.story");
    }
    const html = story("providerConnect");
    expect(html).toContain("Choose a brain for your agent to think with");
    expect(html).toContain("Chapter 4 of 8");
    expect(story("connectors")).toContain(
      "Give your agent the superpowers it needs",
    );
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

  it("shows the agent with what was chosen so far on the left", () => {
    let turns = firstTurn();
    turns = answerTurn(turns, "Let's go");
    turns = answerTurn(turns, "Teal · Sprout");
    turns = answerTurn(turns, "Looks good");
    turns = answerTurn(turns, "Warm Companion");
    turns = answerTurn(turns, "OpenCode Go", {
      next: { step: "providerConnect", subject: "opencode-go" },
    });
    turns = answerTurn(turns, "OpenCode Go connected");
    // The choice, not the follow-up's reply.
    expect(chapterAnswer("provider", turns)).toBe("OpenCode Go");
    let search = answerTurn(turns, "Brave Search", {
      next: { step: "searchConnect", subject: "brave" },
    });
    search = answerTurn(search, "Let me pick another", {
      next: { step: "search" },
    });
    search = answerTurn(search, "DuckDuckGo");
    // "Pick another" changed it: the latest choice wins.
    expect(chapterAnswer("search", search)).toBe("DuckDuckGo");
    const html = render(
      createElement(AgentPanel, {
        step: "search",
        turns,
        traits: DEFAULT_CHARACTER_TRAITS,
        accent: "#0E9B8B",
        name: "Amiro",
        subtitle: "Setting up together",
      }),
    );
    expect(html).toContain('data-testid="setup-agent-title"');
    expect(html).toContain("Amiro");
    expect(html).toContain("Teal · Sprout");
    expect(html).toContain("Warm Companion");
    expect(html).toContain('data-testid="setup-journey-search" data-state="current"');
  });
});
