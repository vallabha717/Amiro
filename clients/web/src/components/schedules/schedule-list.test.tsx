import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { SCHEDULE_RECIPES, SuggestedSchedules } from "./schedule-list";

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

describe("SuggestedSchedules and Inbox Cleanup playbook", () => {
  it("includes the featured Inbox cleanup playbook with default clean and keep rules", () => {
    const inbox = SCHEDULE_RECIPES.find((r) => r.id === "inbox-cleanup");
    expect(inbox).toBeDefined();
    expect(inbox?.featured).toBe(true);
    expect(inbox?.cleanDefaults).toEqual(
      expect.arrayContaining([
        "Promotions & flash sales",
        "Unwanted notifications",
      ]),
    );
    expect(inbox?.keepDefaults).toEqual(
      expect.arrayContaining([
        "Reservations this month",
        "Bills from last 2 months",
      ]),
    );
    expect(inbox?.interactivePrompt).toContain("inbox_cleanup_setup");
    expect(inbox?.interactivePrompt).toContain("mcp_connectors_list");
  });

  it("renders the featured Inbox cleanup studio card and interactive chat setup buttons", () => {
    const html = render(
      createElement(SuggestedSchedules, {
        schedules: [],
        onAdd: vi.fn(),
        onSetupInChat: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="schedules-suggested"');
    expect(html).toContain('data-testid="schedule-playbook-inbox-cleanup"');
    expect(html).toContain('data-testid="schedule-setup-chat-inbox-cleanup"');
    expect(html).toContain('data-testid="schedule-recipe-inbox-cleanup"');
    expect(html).toContain('data-testid="playbook-clean-defaults"');
    expect(html).toContain('data-testid="playbook-keep-defaults"');
    expect(html).toContain("Set up this schedule for me");
    expect(html).toContain("Promotions &amp; flash sales");
    expect(html).toContain("Unwanted notifications");
    expect(html).toContain("Reservations this month");
    expect(html).toContain("Bills from last 2 months");
  });
});
