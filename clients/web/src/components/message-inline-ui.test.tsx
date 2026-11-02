import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { PreviewMessage } from "./message";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

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

const text = (t: string) => ({ type: "text", text: t, state: "done" });
const form = (id: string, heading: string) => ({
  type: "tool-ui_render_openui",
  toolCallId: id,
  state: "output-available",
  input: { code: `root = Stack([h])\nh = CardHeader("${heading}", "s")` },
  output: "rendered",
});
const shell = (id: string) => ({
  type: "tool-bash",
  toolCallId: id,
  state: "output-available",
  input: { command: "ls" },
  output: "ok",
});

function reply(parts: unknown[]) {
  return render(
    createElement(PreviewMessage as never, {
      message: { id: "m1", role: "assistant", parts },
      isLoading: false,
      isLastMessage: true,
      status: "ready",
      readonly: true,
    } as never),
  );
}

function expectOrder(html: string, ...needles: string[]) {
  const at = needles.map((n) => html.indexOf(n));
  for (const [i, position] of at.entries()) {
    expect(position, `missing: ${needles[i]}`).toBeGreaterThanOrEqual(0);
  }
  expect(at).toEqual([...at].sort((a, b) => a - b));
}

describe("agent UI in a reply", () => {
  it("stays where the agent called it, between what it said before and after", () => {
    const html = reply([
      shell("c0"),
      text("Here is your planner."),
      form("c1", "Cost planner"),
      shell("c2"),
      text("All done, tell me what to change."),
    ]);
    expectOrder(html, "Here is your planner.", "Cost planner", "All done, tell me what to change.");
  });

  it("keeps two surfaces in call order with the text between them", () => {
    const html = reply([
      form("c1", "First form"),
      text("Now the second."),
      form("c2", "Second form"),
      shell("c3"),
      text("The end."),
    ]);
    expectOrder(html, "First form", "Now the second.", "Second form", "The end.");
  });

  it("shows a surface once, even as the last thing in the reply", () => {
    const html = reply([text("Pick one."), form("c1", "Only form")]);
    expectOrder(html, "Pick one.", "Only form");
    expect(html.split("Only form").length).toBe(2);
  });
});
