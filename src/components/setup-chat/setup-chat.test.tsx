import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { answerTurn, firstTurn } from "@/lib/onboarding/setup-flow";
import { DoneCard } from "./cards/done-card";
import { SecretField } from "./cards/search-cards";
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
