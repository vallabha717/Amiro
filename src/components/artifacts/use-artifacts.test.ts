import type { UIMessage } from "ai";
import { DefaultToolName } from "lib/ai/tools";
import { describe, expect, it } from "vitest";
import {
  __deriveArtifacts,
  buildPlanDecision,
  tabForTool,
} from "./use-artifacts";

/**
 * Artifacts are read back out of message parts, which is what makes them
 * survive a reload and makes them impossible to drift from the transcript.
 * These tests are on that projection, because it is the load-bearing claim.
 */

function toolPart(name: string, extra: Record<string, unknown>) {
  return {
    type: `tool-${name}`,
    toolCallId: `${name}-1`,
    state: "output-available",
    ...extra,
  } as any;
}

function assistant(parts: any[], id = "m1"): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

describe("deriveArtifacts", () => {
  it("finds nothing in a thread that produced nothing", () => {
    const artifacts = __deriveArtifacts(
      [assistant([{ type: "text", text: "hello" }])],
      false,
    );
    expect(artifacts.plan).toBeUndefined();
    expect(artifacts.todos).toBeUndefined();
    expect(artifacts.walkthrough).toBeUndefined();
  });

  it("reads a suspended plan as pending, not streaming", () => {
    const { plan } = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.ProposePlan, {
              input: { title: "Add a flag", plan: "## Phase 1\nDo it." },
            }),
            state: "input-available",
          },
        ]),
      ],
      false,
    );
    expect(plan?.pending).toBe(true);
    expect(plan?.streaming).toBe(false);
    expect(plan?.title).toBe("Add a flag");
    expect(plan?.markdown).toContain("Phase 1");
    expect(plan?.decision).toBeUndefined();
  });

  // The core bug this guards: a plan whose arguments are still arriving used
  // to read as neither pending nor answered, which the UI collapsed into
  // "answered" and rendered as "Returned for revision" on a document nobody
  // had seen yet. Streaming must be its own state, not the absence of one.
  it("reads a plan still being written as streaming, not pending and not answered", () => {
    const { plan } = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.ProposePlan, {
              // Partial JSON parsing during streaming can hand back a title
              // with no plan field yet, or a plan field mid-sentence -- both
              // must render as *something*, not be treated as absent.
              input: { title: "Add a flag", plan: "## Phase 1\nDo th" },
            }),
            state: "input-streaming",
          },
        ]),
      ],
      false,
    );
    expect(plan?.streaming).toBe(true);
    expect(plan?.pending).toBe(false);
    expect(plan?.decision).toBeUndefined();
    expect(plan?.markdown).toBe("## Phase 1\nDo th");
  });

  it("reads an answered plan as no longer pending, with its decision", () => {
    const { plan } = __deriveArtifacts(
      [
        assistant([
          toolPart(DefaultToolName.ProposePlan, {
            input: { title: "t", plan: "p" },
            output: { decision: "proceed", grantedMode: "edit" },
          }),
        ]),
      ],
      false,
    );
    expect(plan?.pending).toBe(false);
    expect(plan?.decision?.decision).toBe("proceed");
  });

  // A revised plan replaces the one it revises. Keeping both would leave the
  // user reading a document the agent has already abandoned -- and the second
  // proposal exists precisely because the first was wrong.
  it("lets a revised plan supersede the one it revises", () => {
    const { plan } = __deriveArtifacts(
      [
        assistant(
          [
            toolPart(DefaultToolName.ProposePlan, {
              input: { title: "First", plan: "old" },
              output: { decision: "revise" },
            }),
          ],
          "m1",
        ),
        assistant(
          [
            {
              ...toolPart(DefaultToolName.ProposePlan, {
                input: { title: "Second", plan: "new" },
              }),
              toolCallId: "propose_plan-2",
              state: "input-available",
            },
          ],
          "m2",
        ),
      ],
      false,
    );
    expect(plan?.title).toBe("Second");
    expect(plan?.pending).toBe(true);
  });

  it("prefers the server's todo counts but renders from the input alone", () => {
    const items = [
      { content: "a", status: "done" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ];

    // Mid-stream: the call has arguments but no result yet. The plan is worth
    // showing the instant the model writes it, not a round trip later.
    const streaming = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.TodoWrite, { input: { items } }),
            state: "input-available",
          },
        ]),
      ],
      false,
    );
    expect(streaming.todos?.done).toBe(1);
    expect(streaming.todos?.items).toHaveLength(3);

    const settled = __deriveArtifacts(
      [
        assistant([
          toolPart(DefaultToolName.TodoWrite, {
            input: { items },
            output: { items, done: 1, in_progress: 1, pending: 1 },
          }),
        ]),
      ],
      false,
    );
    expect(settled.todos?.done).toBe(1);
    expect(settled.todos?.pending).toBe(1);
  });

  // The bug this guards: mid-stream, a tool call's `input` is whatever the
  // ai package's partial-JSON repair produced from a truncated argument
  // string. Before the array's opening `[` has streamed in, that can land
  // here as `{}` rather than `[]` -- and `items.filter(...)` on a `{}`
  // throws "items.filter is not a function", crashing the whole chat. Every
  // render walks live parts, so this was reachable on ordinary use, not just
  // a contrived input.
  it("does not crash when a streaming todo call's items have not become an array yet", () => {
    const { todos } = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.TodoWrite, { input: { items: {} } }),
            state: "input-streaming",
          },
        ]),
      ],
      true,
    );
    expect(todos?.items).toEqual([]);
    expect(todos?.done).toBe(0);
  });

  // Same shape of bug, same fix, for the walkthrough's `changes` array.
  it("does not crash when a streaming walkthrough call's changes have not become an array yet", () => {
    const { walkthrough } = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.Walkthrough, {
              input: { summary: "wo", changes: {} },
            }),
            state: "input-streaming",
          },
        ]),
      ],
      true,
    );
    expect(walkthrough?.changes).toEqual([]);
  });

  // The bug this guards: the walkthrough artifact used to require `output`
  // to exist at all, so nothing appeared until the tool had *finished*
  // executing -- by which point the whole summary had already arrived and
  // there was nothing left to watch grow. It must build from `input` the
  // instant the call exists, the same way the plan and the todo list do.
  it("builds a walkthrough from input alone while the call is still streaming", () => {
    const { walkthrough } = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.Walkthrough, {
              input: {
                summary: "Added the --json fla",
                changes: [{ path: "cmd/eval/main.go", why: "the new fla" }],
              },
            }),
            state: "input-streaming",
          },
        ]),
      ],
      false,
    );
    expect(walkthrough?.streaming).toBe(true);
    expect(walkthrough?.summary).toBe("Added the --json fla");
    expect(walkthrough?.changes).toEqual([
      { path: "cmd/eval/main.go", why: "the new fla" },
    ]);
    // Not computed while streaming: comparing a half-typed change list
    // against the turn's real edits would flag the model's own typing as a
    // missing mention.
    expect(walkthrough?.unmentioned).toEqual([]);
  });

  it("prefers the settled output once the walkthrough tool has actually run", () => {
    const { walkthrough } = __deriveArtifacts(
      [
        assistant([
          toolPart(DefaultToolName.EditFile, {
            input: { path: "cmd/eval/main.go" },
            output: { path: "cmd/eval/main.go" },
          }),
          toolPart(DefaultToolName.Walkthrough, {
            output: {
              summary: "Added the --json flag.",
              changes: [{ path: "cmd/eval/main.go", why: "the new flag" }],
            },
          }),
        ]),
      ],
      false,
    );
    expect(walkthrough?.streaming).toBe(false);
    expect(walkthrough?.summary).toBe("Added the --json flag.");
    expect(walkthrough?.unmentioned).toEqual([]);
  });

  // The one failure mode a walkthrough has: it reads as complete whether or
  // not it is. So it is checked against what the turn demonstrably did.
  it("flags files the turn edited that the walkthrough never mentions", () => {
    const { walkthrough } = __deriveArtifacts(
      [
        assistant([
          toolPart(DefaultToolName.EditFile, {
            input: { path: "src/a.ts" },
            output: { path: "src/a.ts", added: 3, removed: 1 },
          }),
          {
            ...toolPart(DefaultToolName.WriteFile, {
              input: { path: "src/forgotten.ts" },
              output: { path: "src/forgotten.ts" },
            }),
            toolCallId: "write_file-1",
          },
          toolPart(DefaultToolName.Walkthrough, {
            output: {
              summary: "Did the thing.",
              changes: [{ path: "src/a.ts", why: "core change" }],
            },
          }),
        ]),
      ],
      false,
    );
    expect(walkthrough?.unmentioned).toEqual(["src/forgotten.ts"]);
  });

  // A refused edit changed nothing. Flagging the walkthrough for not
  // mentioning a file that was never written would train the reader to
  // ignore the flag, which is the only thing keeping it useful.
  it("does not count an edit that failed", () => {
    const { walkthrough } = __deriveArtifacts(
      [
        assistant([
          {
            ...toolPart(DefaultToolName.EditFile, {
              input: { path: "src/never.ts" },
            }),
            state: "output-error",
            errorText: "edit_file: anchor not found",
          },
          toolPart(DefaultToolName.Walkthrough, {
            output: { summary: "s", changes: [] },
          }),
        ]),
      ],
      false,
    );
    expect(walkthrough?.unmentioned).toEqual([]);
  });

  it("matches a mentioned file by its name, not only its full path", () => {
    const { walkthrough } = __deriveArtifacts(
      [
        assistant([
          toolPart(DefaultToolName.EditFile, {
            input: { path: "src/lib/utils.ts" },
            output: { path: "src/lib/utils.ts" },
          }),
          toolPart(DefaultToolName.Walkthrough, {
            output: {
              summary: "s",
              changes: [{ path: "utils.ts", why: "renamed a helper" }],
            },
          }),
        ]),
      ],
      false,
    );
    expect(walkthrough?.unmentioned).toEqual([]);
  });

  it("marks the task list live only while the last turn is still running", () => {
    const messages = [
      assistant(
        [
          toolPart(DefaultToolName.TodoWrite, {
            input: { items: [{ content: "a", status: "pending" }] },
          }),
        ],
        "m1",
      ),
    ];
    expect(__deriveArtifacts(messages, true).todos?.live).toBe(true);
    expect(__deriveArtifacts(messages, false).todos?.live).toBe(false);
  });

  it("handles Jcode todo tool shape with completed status", () => {
    const messages = [
      assistant([
        toolPart("todo", {
          input: {
            todos: [
              { content: "A", status: "completed" },
              { content: "B", status: "in_progress" },
              { content: "C", status: "pending" },
            ],
          },
        }),
      ]),
    ];
    const { todos } = __deriveArtifacts(messages, false);
    expect(todos).toBeDefined();
    expect(todos?.done).toBe(1);
    expect(todos?.inProgress).toBe(1);
    expect(todos?.pending).toBe(1);
    expect(todos?.items[0].status).toBe("done");
  });
});

describe("tabForTool", () => {
  it("routes each artifact tool to its own tab", () => {
    expect(tabForTool(DefaultToolName.ProposePlan)).toBe("plan");
    expect(tabForTool(DefaultToolName.TodoWrite)).toBe("tasks");
    expect(tabForTool("todo")).toBe("tasks");
    expect(tabForTool(DefaultToolName.Walkthrough)).toBe("walkthrough");
    expect(tabForTool(DefaultToolName.ReadFile)).toBeUndefined();
  });
});

/**
 * The other half of the propose_plan contract: what the browser writes back.
 *
 * plan.go's `planDecision` mirrors this shape and proposePlanDescription
 * promises the model what each field means, so these are assertions about an
 * agreement with the model, not about a React callback.
 */
describe("buildPlanDecision", () => {
  const comment = {
    section: "Phase 1",
    quote: "the table",
    note: "wrong file",
  };

  // The plan the user answers is never rewritten by them, so the answer
  // carries a decision and comments and nothing else -- an unexpected `plan`
  // field here would be an instruction to the model to follow a document
  // nothing in the UI can produce.
  it("carries no plan field", () => {
    expect("plan" in buildPlanDecision("proceed", [], "manual")).toBe(false);
  });

  it("sends comments on a proceed, not only on a revision", () => {
    const output = buildPlanDecision("proceed", [comment], "manual");
    expect(output.comments?.[0]?.note).toBe("wrong file");
  });

  it("keeps a comment's section and quote, which are its anchor", () => {
    const output = buildPlanDecision("revise", [comment], "manual");
    expect(output.comments?.[0]).toMatchObject({
      section: "Phase 1",
      quote: "the table",
    });
  });

  it("names the granted mode only when proceeding", () => {
    expect(buildPlanDecision("proceed", [], "edit").grantedMode).toBe("edit");
    expect(buildPlanDecision("revise", [], "edit").grantedMode).toBeUndefined();
  });
});
