import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { AskUserCard } from "./ask-user-card";
import { SourcesStrip } from "./sources-strip";
import { collectTurnChanges } from "./turn-changes-card";
import { FoldedWork } from "../work-summary";

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

const hit = (n: number) => ({
  rank: n,
  title: `Source ${n}`,
  url: `https://site${n}.example.com/page`,
  domain: `site${n}.example.com`,
  faviconUrl: "",
});

describe("SourcesStrip", () => {
  it("shows up to four numbered source cards and dedupes repeats", () => {
    const html = render(
      createElement(SourcesStrip, {
        searches: [
          { id: "a", query: "q", hits: [hit(1), hit(2)] },
          { id: "b", query: "q2", hits: [hit(2), hit(3)] },
        ],
      }),
    );
    expect(html).toContain('data-testid="message-web-sources-bar"');
    expect(html.split('data-testid="source-card"').length - 1).toBe(3);
    expect(html).toContain('href="https://site3.example.com/page"');
    expect(html).not.toContain('data-testid="sources-toggle-all"');
  });

  it("offers the rest behind a toggle and renders nothing without sources", () => {
    const many = render(
      createElement(SourcesStrip, {
        searches: [{ id: "a", hits: [1, 2, 3, 4, 5, 6].map(hit) }],
      }),
    );
    expect(many).toContain('data-testid="sources-toggle-all"');
    expect(many).toContain("2 more sources");
    const none = render(
      createElement(SourcesStrip, { searches: [{ id: "a", hits: [], pending: true }] }),
    );
    expect(none).toBe("");
  });
});

const request = {
  questions: [
    {
      id: "q1",
      question: "Which database?",
      header: "Database",
      options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }],
      multiSelect: false,
    },
    {
      id: "q2",
      question: "Which extras?",
      options: [{ label: "Auth" }, { label: "Billing" }],
      multiSelect: true,
    },
  ],
};

describe("AskUserCard", () => {
  it("opens on the first question with numbered options and an Other answer", () => {
    const html = render(
      createElement(AskUserCard, { request, settled: false, onSubmit: () => {} }),
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain("Which database?");
    expect(html).toContain("Database");
    expect(html).toContain("Question 1 of 2");
    expect(html).toContain('role="radiogroup"');
    expect(html.split('data-testid="ask-user-option"').length - 1).toBe(2);
    expect(html).toContain('data-testid="ask-user-other"');
    // Nothing picked yet, so the card cannot move on.
    expect(html).toMatch(/data-testid="ask-user-next"[^>]*disabled/);
  });

  it("is read-only once the conversation has moved past it", () => {
    const html = render(createElement(AskUserCard, { request, settled: true }));
    expect(html).toContain('data-state="answered"');
    expect(html).toContain("Which extras?");
    expect(html).not.toContain('data-testid="ask-user-option"');
  });
});

describe("FoldedWork", () => {
  const group = (kind: "command" | "search") => ({
    type: "group" as const,
    kind,
    glances: [{ text: `${kind} step`, failed: false }],
    children: createElement("span", null, `${kind} details`),
  });
  const prose = {
    type: "prose" as const,
    children: createElement("p", null, "Now checking the second thing."),
  };

  it("keeps thinking, every step and the notes between them in one live card", () => {
    const html = render(
      createElement(FoldedWork, {
        rows: [group("command"), prose, group("search")],
        thought: true,
        reasoning: createElement("span", null, "my reasoning"),
        turnSettled: false,
        isRunning: true,
        images: [],
        stepCount: 2,
      }),
    );
    expect(html.split('data-testid="work-summary"').length - 1).toBe(1);
    expect(html).toContain('data-state="running"');
    expect(html).toContain("my reasoning");
    expect(html).toContain('data-testid="worklog-note"');
    expect(html).toContain("Now checking the second thing.");
    expect(html).toContain("search details");
  });

  it("puts thinking that came after a step on the timeline, in order", () => {
    const later = {
      type: "prose" as const,
      thought: true,
      active: true,
      children: createElement("span", null, "thinking after the search"),
    };
    const html = render(
      createElement(FoldedWork, {
        rows: [group("search"), later],
        thought: true,
        reasoning: null,
        turnSettled: false,
        isRunning: true,
        images: [],
        stepCount: 1,
      }),
    );
    expect(html.split('data-testid="work-summary"').length - 1).toBe(1);
    expect(html).toContain('data-testid="worklog-thought"');
    expect(html.indexOf("search details")).toBeLessThan(
      html.indexOf("thinking after the search"),
    );
  });

  it("keeps text the running turn is writing inside the card, full size", () => {
    const live = {
      type: "prose" as const,
      live: true,
      children: createElement("p", null, "Starting with Node.js LTS."),
    };
    const html = render(
      createElement(FoldedWork, {
        rows: [live],
        thought: true,
        reasoning: createElement("span", null, "plan"),
        turnSettled: false,
        isRunning: true,
        images: [],
        stepCount: 0,
      }),
    );
    expect(html).toContain('data-live="true"');
    expect(html).toContain("Starting with Node.js LTS.");
    // Writing, not just thinking, so the header says Working.
    expect(html).toContain("Working");
  });

  it("narrates the step in progress and draws one strip segment per step", () => {
    const html = render(
      createElement(FoldedWork, {
        rows: [
          { ...group("search"), glances: [{ text: "Searched “bun”", failed: false }] },
          { ...group("command"), glances: [{ text: "Running uname -m", failed: false }] },
        ],
        thought: true,
        reasoning: createElement("span", null, "plan"),
        reasoningTitle: "Plan the comparison.",
        turnSettled: false,
        isRunning: true,
        images: [],
        stepCount: 2,
      }),
    );
    expect(html).toContain('data-testid="work-summary-headline"');
    expect(html).toContain("Running uname -m");
    const segments = html.split('data-testid="step-strip-segment"').length - 1;
    expect(segments).toBe(3);
    expect(html).toContain('data-kind="thought"');
    expect(html).toContain('data-kind="search"');
    expect(html).toMatch(/data-kind="command" data-state="running"/);
    expect(html).toContain("3 steps");
  });

  it("shows the agent's mid-run updates as a speech bubble, a strip dot and the quoted headline", () => {
    const update = {
      type: "prose" as const,
      title: "Both N/A, so nothing gets scaffolded.",
      children: createElement("p", null, "Both N/A, so nothing gets scaffolded."),
    };
    const html = render(
      createElement(FoldedWork, {
        rows: [group("command"), update],
        thought: false,
        reasoning: null,
        turnSettled: false,
        isRunning: true,
        images: [],
        stepCount: 1,
      }),
    );
    expect(html).toContain('data-testid="worklog-note"');
    expect(html).toContain(">Update<");
    expect(html).toMatch(/data-kind="note" data-state="done"/);
    expect(html).toContain("“Both N/A, so nothing gets scaffolded.”");
  });

  it("folds to a one-line summary once the turn settles", () => {
    const html = render(
      createElement(FoldedWork, {
        rows: [group("command"), prose, group("search")],
        thought: true,
        reasoning: createElement("span", null, "my reasoning"),
        turnSettled: true,
        isRunning: false,
        images: [],
        stepCount: 2,
        durationMs: 9000,
      }),
    );
    expect(html).toContain('data-state="settled"');
    expect(html).toContain("Thought, ran 1 command, searched the web");
    expect(html).toContain("9s");
    expect(html).not.toContain("my reasoning");
  });
});

describe("collectTurnChanges", () => {
  it("groups edits by file and sums their line counts", () => {
    const changes = collectTurnChanges([
      {
        toolName: "edit_file",
        input: { path: "src/a.ts" },
        output: { path: "src/a.ts", added: 3, removed: 1 },
        status: "success",
      },
      {
        toolName: "edit_file",
        input: { path: "src/a.ts" },
        output: { path: "src/a.ts", added: 2, removed: 0 },
        status: "success",
      },
      {
        toolName: "read_file",
        input: { path: "src/b.ts" },
        output: {},
        status: "success",
      },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "src/a.ts", added: 5, removed: 1 });
    expect(changes[0].edits).toHaveLength(2);
  });
});
