import { createParser } from "@openuidev/react-lang";
import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { OPENUI_PRESETS, amiroOpenUILibrary } from "../../lib/openui/amiro-library";
import { parseInlineVisuals } from "../visual/visual-surface";
import { OpenUISurface, extractOpenUIPayload } from "./openui-surface";

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

describe("OpenUISurface and OpenUI Lang integration", () => {
  it("parses complete and streaming ```openui blocks via parseInlineVisuals", () => {
    const streamingText =
      'Here is your live dashboard:\n```openui title="Sprint View"\nroot = Stack([h])\nh = CardHeader("Sprint 42", "Live")';
    const segs = parseInlineVisuals(streamingText);
    expect(segs).not.toBeNull();
    expect(segs).toHaveLength(2);
    expect(segs?.[1]).toMatchObject({
      type: "openui",
      title: "Sprint View",
      streaming: true,
    });

    const closedText = `${streamingText}\n\`\`\`\nDone.`;
    const closedSegs = parseInlineVisuals(closedText);
    expect(closedSegs).toHaveLength(3);
    expect(closedSegs?.[1]).toMatchObject({
      type: "openui",
      title: "Sprint View",
      streaming: false,
    });
  });

  it("validates all built-in daily-use presets against amiroOpenUILibrary schema with zero parser errors", () => {
    const parser = createParser(
      amiroOpenUILibrary.toJSONSchema(),
      amiroOpenUILibrary.root,
    );
    for (const [key, preset] of Object.entries(OPENUI_PRESETS)) {
      const result = parser.parse(preset.code);
      expect(result.root, `preset ${key} should parse a root node`).not.toBeNull();
      expect(
        result.meta.errors,
        `preset ${key} should have no validation errors`,
      ).toEqual([]);
      expect(result.meta.unresolved, `preset ${key} unresolved refs`).toEqual([]);
    }
  });

  it("renders Daily Executive Command Center, Budget Planner, and Sprint Tracker presets via OpenUISurface", () => {
    const briefHtml = render(
      createElement(OpenUISurface, {
        code: OPENUI_PRESETS.daily_brief.code,
        title: OPENUI_PRESETS.daily_brief.title,
      }),
    );
    expect(briefHtml).toContain('data-testid="openui-surface"');
    expect(briefHtml).not.toContain('data-testid="openui-toggle-source"');
    expect(briefHtml).not.toContain('data-testid="openui-copy-source"');
    expect(briefHtml).not.toContain("OpenUI Live");
    expect(briefHtml).toContain("Daily Executive &amp; Engineering Command Center");
    expect(briefHtml).toContain("99.98%");
    expect(briefHtml).toContain("Open Cloud AI Budget Planner");

    const budgetHtml = render(
      createElement(OpenUISurface, {
        code: "",
        preset: "budget_planner",
      }),
    );
    expect(budgetHtml).toContain('data-testid="openui-interactive-form"');
    expect(budgetHtml).toContain('data-testid="openui-simulated-spend"');
    expect(budgetHtml).toContain("Peak Daily Requests (K)");
    expect(budgetHtml).toContain("Recalculate Forecast");

    const sprintHtml = render(
      createElement(OpenUISurface, {
        code: "",
        preset: "sprint_tracker",
      }),
    );
    expect(sprintHtml).toContain("Sprint 42 Release Command Center");
    expect(sprintHtml).toContain('data-testid="openui-steps"');
    expect(sprintHtml).toContain("#418 Streaming OpenUI Renderer");

    const intakeHtml = render(
      createElement(OpenUISurface, {
        code: "",
        preset: "agent_data_intake",
      }),
    );
    expect(intakeHtml).toContain('data-testid="openui-question-card"');
    expect(intakeHtml).toContain('data-testid="openui-input-webhook_url"');
    expect(intakeHtml).toContain('data-testid="openui-textarea-config_snippet"');
    expect(intakeHtml).toContain('data-testid="secret-prompt-card"');
    expect(intakeHtml).toContain("AMIRO_CRED_RELEASE_WEBHOOK_SIGNING_SECRET");

    const inboxCleanupHtml = render(
      createElement(OpenUISurface, {
        code: "",
        preset: "inbox_cleanup_setup",
      }),
    );
    expect(inboxCleanupHtml).toContain("Inbox Cleanup Schedule Studio");
    expect(inboxCleanupHtml).toContain('data-testid="openui-switch-clean_promotions"');
    expect(inboxCleanupHtml).toContain('data-testid="openui-switch-clean_notifications"');
    expect(inboxCleanupHtml).toContain('data-testid="openui-switch-keep_reservations_month"');
    expect(inboxCleanupHtml).toContain('data-testid="openui-switch-keep_bills_2_months"');
    expect(inboxCleanupHtml).toContain("Create Inbox Cleanup Schedule");
  });

  it("extracts OpenUI payloads from tool inputs and MCP text outputs", () => {
    const fromPreset = extractOpenUIPayload({ preset: "sprint_tracker" }, null);
    expect(fromPreset?.preset).toBe("sprint_tracker");
    expect(fromPreset?.code).toContain("Sprint 42 Release Command Center");

    const fromMcpOutput = extractOpenUIPayload(
      {},
      {
        content: [
          {
            type: "text",
            text: 'Rendered:\n```openui\nroot = Stack([h])\nh = CardHeader("Hello", "Sub")\n```',
          },
        ],
      },
    );
    expect(fromMcpOutput?.code).toContain('CardHeader("Hello", "Sub")');
  });
});
