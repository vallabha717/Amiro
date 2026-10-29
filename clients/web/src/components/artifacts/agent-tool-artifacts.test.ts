import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  formatPlanDecisionMessage,
  readPlanDecisionMessage,
} from "./plan-messages";
import { __deriveArtifacts } from "./use-artifacts";

/**
 * The agent-tool path: `ui_propose_plan` and `ui_show_walkthrough` end the
 * turn, and the user's decision is the next chat message. Plan -> Tasks ->
 * Walkthrough is derived from the transcript alone, so a reload keeps it.
 */

const planCard = { title: "Launch café", plan: "## Goal\n\nOpen in May." };

function tool(name: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: `tool-${name}`,
    toolCallId: `${name}-1`,
    state: "output-available",
    output: { content: [{ type: "text", text }] },
    ...extra,
  } as any;
}

const planPart = () =>
  tool("ui_propose_plan", `Showed the plan.\n\nPLAN ${JSON.stringify(planCard)}`);

const assistant = (parts: any[], id: string): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;
const user = (text: string, id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

describe("agent-tool plan", () => {
  it("is pending once the turn stops, and not while it still runs", () => {
    const messages = [assistant([planPart()], "a1")];
    expect(__deriveArtifacts(messages, true).plan?.pending).toBe(false);
    const done = __deriveArtifacts(messages, false);
    expect(done.plan?.pending).toBe(true);
    expect(done.plan?.mode).toBe("message");
    expect(done.plan?.title).toBe("Launch café");
    expect(done.stage).toBe("plan");
  });

  it("reads the user's next message as the decision", () => {
    const approved = __deriveArtifacts(
      [
        assistant([planPart()], "a1"),
        user(formatPlanDecisionMessage("proceed", "Launch café", []), "u1"),
      ],
      false,
    );
    expect(approved.plan?.decision?.decision).toBe("proceed");
    expect(approved.plan?.pending).toBe(false);

    const revised = __deriveArtifacts(
      [
        assistant([planPart()], "a1"),
        user(
          formatPlanDecisionMessage("revise", "Launch café", [
            { quote: "Open in May", note: "Make it June", section: "Goal" },
          ]),
          "u1",
        ),
      ],
      false,
    );
    expect(revised.plan?.decision?.decision).toBe("revise");
  });

  it("moves to tasks after approval, then to the walkthrough", () => {
    const approval = user(
      formatPlanDecisionMessage("proceed", "Launch café", []),
      "u1",
    );
    const todo = tool("todo", "ok", {
      input: { todos: [{ content: "Sign lease", status: "in_progress" }] },
    });
    const tasks = __deriveArtifacts(
      [assistant([planPart()], "a1"), approval, assistant([todo], "a2")],
      true,
    );
    expect(tasks.stage).toBe("tasks");
    expect(tasks.todos?.items).toHaveLength(1);

    const card = {
      summary: "Done.",
      changes: [{ path: "lease.md", why: "signed" }],
      testing: null,
      follow_ups: [],
    };
    const wrapUp = tool("ui_show_walkthrough", `WALKTHROUGH ${JSON.stringify(card)}`);
    const finished = __deriveArtifacts(
      [
        assistant([planPart()], "a1"),
        approval,
        assistant([todo, wrapUp], "a2"),
      ],
      false,
    );
    expect(finished.stage).toBe("walkthrough");
    expect(finished.walkthrough?.changes[0].path).toBe("lease.md");
  });

  it("never opens the pane for a task list alone", () => {
    const todo = tool("todo", "ok", {
      input: { todos: [{ content: "x", status: "pending" }] },
    });
    expect(__deriveArtifacts([assistant([todo], "a1")], false).stage).toBeUndefined();
  });
});

describe("plan decision message", () => {
  it("round-trips approval and revision", () => {
    expect(
      readPlanDecisionMessage(formatPlanDecisionMessage("proceed", "T", [])),
    ).toBe("proceed");
    expect(readPlanDecisionMessage("actually, use June")).toBe("revise");
  });

  it("quotes each comment so the agent can act on it", () => {
    const text = formatPlanDecisionMessage("revise", "T", [
      { quote: "Open in May", note: "Make it June", section: "Goal" },
    ]);
    expect(text).toContain("«Open in May»");
    expect(text).toContain("Make it June");
  });
});
