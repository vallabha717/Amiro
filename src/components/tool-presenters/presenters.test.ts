import { DefaultToolName } from "lib/ai/tools";
import { describe, expect, it } from "vitest";
import {
  getToolPresenter,
  presenterPropsFromToolPart,
  statusFromToolPart,
  toolGlance,
  toolPresenters,
} from "./index";

/**
 * The tools the Go backend offers that must be readable at a glance.
 *
 * Kept as a literal list rather than imported, because the backend is a
 * separate binary and there is nothing to import from it. The names are the
 * shared contract (`DefaultToolName` here, `tools.Name*` there), so this
 * list drifting is exactly the failure the plan's risk table names:
 * "Presenter registry drifts from the Go tool list".
 */
const TOOLS_REQUIRING_A_PRESENTER = [
  DefaultToolName.ReadFile,
  DefaultToolName.ListDir,
  DefaultToolName.Glob,
  DefaultToolName.Grep,
  DefaultToolName.WriteFile,
  DefaultToolName.EditFile,
  DefaultToolName.MultiEdit,
  DefaultToolName.RunShell,
  DefaultToolName.TerminalExecution,
  DefaultToolName.Git,
  DefaultToolName.TodoWrite,
  DefaultToolName.TodoRead,
  DefaultToolName.Task,
  DefaultToolName.RepoMap,
  DefaultToolName.Lsp,
  DefaultToolName.MemoryWrite,
  DefaultToolName.MemoryRead,
  DefaultToolName.MemoryForget,
  DefaultToolName.ProposePlan,
  DefaultToolName.Walkthrough,
];

describe("tool presenter registry", () => {
  it.each(TOOLS_REQUIRING_A_PRESENTER)(
    "%s has a presenter with all three slots",
    (name) => {
      const presenter = getToolPresenter(name);
      expect(presenter, `${name} has no presenter`).toBeDefined();
      expect(typeof presenter!.glance).toBe("function");
      // Compact is what the approval card renders. A gated tool without one
      // asks the user to consent to a JSON blob.
      expect(presenter!.Compact, `${name} has no Compact view`).toBeDefined();
      expect(presenter!.Expanded, `${name} has no Expanded view`).toBeDefined();
    },
  );

  it("degrades to the tool name for anything unregistered", () => {
    expect(toolGlance("some-mcp-tool", { input: {}, output: undefined, status: "pending" })).toBe(
      "some-mcp-tool",
    );
  });

  // Every glance is called while a call is still pending -- the work log
  // renders rows as they stream, and the approval card renders before
  // anything has run. A presenter that assumes `output` exists throws there.
  it.each(Object.keys(toolPresenters))(
    "%s renders a glance from input alone",
    (name) => {
      const presenter = toolPresenters[name];
      expect(
        presenter.glance({ input: {}, output: undefined, status: "pending" }),
      ).toBeTypeOf("string");
      expect(
        presenter.glance({
          input: undefined,
          output: undefined,
          status: "error",
          errorText: "boom",
        }),
      ).toBeTypeOf("string");
    },
  );
});

describe("glance lines say what happened", () => {
  it("read_file reports the line count, and the window when truncated", () => {
    expect(
      toolGlance(DefaultToolName.ReadFile, {
        input: { path: "src/lib/utils.ts" },
        output: { path: "src/lib/utils.ts", total_lines: 120 },
        status: "success",
      }),
    ).toBe("src/lib/utils.ts · 120 lines");

    expect(
      toolGlance(DefaultToolName.ReadFile, {
        input: { path: "big.ts" },
        output: {
          path: "big.ts",
          total_lines: 5000,
          start_line: 1,
          end_line: 2000,
          truncated: true,
        },
        status: "success",
      }),
    ).toBe("big.ts · lines 1-2000 of 5000");
  });

  // The one outcome a reviewer scanning a 40-step run must not scroll past.
  it("edit_file is loud about a failed anchor", () => {
    const glance = toolGlance(DefaultToolName.EditFile, {
      input: { path: "src/tool_loop.go" },
      output: undefined,
      status: "error",
      errorText: "anchor matched 3 times",
    });
    expect(glance).toContain("⚠");
    expect(glance).toContain("tool_loop.go");
  });

  it("edit_file shows the change size on success", () => {
    expect(
      toolGlance(DefaultToolName.EditFile, {
        input: { path: "a.go" },
        output: { path: "a.go", added: 12, removed: 4 },
        status: "success",
      }),
    ).toBe("a.go · +12 −4");
  });

  it("run_shell shows the command and its exit code", () => {
    expect(
      toolGlance(DefaultToolName.RunShell, {
        input: { command: "go test ./..." },
        output: { command: "go test ./...", exit_code: 0 },
        status: "success",
      }),
    ).toBe("go test ./... · exit 0");
  });

  // Before it runs, the command is all there is -- and it is exactly what
  // the approval card has to show.
  it("run_shell shows the command while still pending", () => {
    expect(
      toolGlance(DefaultToolName.RunShell, {
        input: { command: "rm -rf build" },
        output: undefined,
        status: "pending",
      }),
    ).toBe("rm -rf build");
  });

  it("git names the subcommand, and the message for a commit", () => {
    expect(
      toolGlance(DefaultToolName.Git, {
        input: { subcommand: "add", paths: ["a.go", "b.go", "c.go"] },
        output: undefined,
        status: "pending",
      }),
    ).toBe("git add…");

    expect(
      toolGlance(DefaultToolName.Git, {
        input: { subcommand: "commit", message: "close the permission gap" },
        output: { subcommand: "commit", exit_code: 0 },
        status: "success",
      }),
    ).toBe("git commit · close the permission gap");
  });
});

describe("phase 4 glance lines", () => {
  // A tally says how much is left; the in-progress item says what is
  // happening right now, which is the more useful of the two mid-turn.
  it("todo names the item in progress, not just the count", () => {
    expect(
      toolGlance(DefaultToolName.TodoWrite, {
        input: {},
        output: {
          done: 2,
          in_progress: 1,
          pending: 1,
          items: [
            { content: "read the loop", status: "done" },
            { content: "add the gate", status: "done" },
            { content: "write tests", status: "in_progress" },
            { content: "update docs", status: "pending" },
          ],
        },
        status: "success",
      }),
    ).toBe("2/4 done · write tests");
  });

  it("todo renders from input alone, before the write round-trips", () => {
    expect(
      toolGlance(DefaultToolName.TodoWrite, {
        input: {
          items: [
            { content: "a", status: "done" },
            { content: "b", status: "pending" },
          ],
        },
        output: undefined,
        status: "pending",
      }),
    ).toBe("1/2 done");
  });

  it("task reports what was investigated and how long it took", () => {
    expect(
      toolGlance(DefaultToolName.Task, {
        input: { description: "explored auth flow", prompt: "..." },
        output: { description: "explored auth flow", steps: 12 },
        status: "success",
      }),
    ).toBe("explored auth flow · 12 steps");

    expect(
      toolGlance(DefaultToolName.Task, {
        input: { description: "explored auth flow" },
        output: undefined,
        status: "pending",
      }),
    ).toBe("explored auth flow…");
  });
});

describe("an approval answer is not a result", () => {
  const confirmed = {
    type: "tool-edit_file",
    toolCallId: "call-1",
    state: "output-available",
    input: { path: "a.go" },
    // What the SDK writes into the part between "Approve" and the server's
    // next response. The edit has not run yet at this point.
    output: { __tag: "manual-tool-confirm", confirm: true },
  } as any;

  it("reads as pending, not success", () => {
    expect(statusFromToolPart(confirmed)).toBe("pending");
  });

  it("is stripped before it reaches a presenter", () => {
    const props = presenterPropsFromToolPart(confirmed);
    expect(props.output).toBeUndefined();
    // Without the strip this glance reads "a.go · +0 −0" -- an edit that
    // applied cleanly, reported as having changed nothing.
    expect(toolGlance(DefaultToolName.EditFile, props)).toBe("editing a.go…");
  });

  it("leaves a real result alone", () => {
    const props = presenterPropsFromToolPart({
      ...confirmed,
      output: { path: "a.go", added: 12, removed: 4 },
    });
    expect(props.status).toBe("success");
    expect(toolGlance(DefaultToolName.EditFile, props)).toBe("a.go · +12 −4");
  });
});

describe("code intelligence presenters", () => {
  it("repo_map summarizes by file count and names the focus", () => {
    expect(
      toolGlance(DefaultToolName.RepoMap, {
        input: { focus: ["auth"] },
        output: { scanned: 37, files: [] },
        status: "success",
      }),
    ).toBe("37 files mapped · auth");
  });

  // The one that would be dangerous to get wrong: "the server did not
  // answer in time" is the opposite of "clean", and a glance line that
  // rendered both as "no problems" would tell an agent its broken edit
  // compiled.
  it("lsp diagnostics never reads an unanswered server as clean", () => {
    expect(
      toolGlance(DefaultToolName.Lsp, {
        input: { operation: "diagnostics", path: "a.go" },
        output: {
          operation: "diagnostics",
          problems: [],
          notice:
            "the language server did not report on this file in time -- this is NOT a clean bill of health, retry or run the build",
        },
        status: "success",
      }),
    ).toBe("not analysed yet");

    expect(
      toolGlance(DefaultToolName.Lsp, {
        input: { operation: "diagnostics", path: "a.go" },
        output: { operation: "diagnostics", problems: [] },
        status: "success",
      }),
    ).toBe("no problems");
  });

  it("lsp references reports the count with the symbol", () => {
    expect(
      toolGlance(DefaultToolName.Lsp, {
        input: { operation: "references", symbol: "Resolve" },
        output: { total: 1, hits: [{ path: "a.go", line: 3 }] },
        status: "success",
      }),
    ).toBe("1 reference Resolve");
  });

  // The approval card renders Compact from *input alone* -- at the moment
  // the user is deciding, there is no output yet. A memory card that could
  // not show the note would be asking for consent to something unreadable.
  it("memory_write's glance shows the note before it has been written", () => {
    expect(
      toolGlance(DefaultToolName.MemoryWrite, {
        input: { text: "the tests are run with pnpm test" },
        output: undefined,
        status: "pending",
      }),
    ).toBe("remembered: the tests are run with pnpm test");
  });

  it("memory_write distinguishes reinforcing a note from adding one", () => {
    expect(
      toolGlance(DefaultToolName.MemoryWrite, {
        input: { text: "we use pnpm" },
        output: { text: "we use pnpm", updated: true },
        status: "success",
      }),
    ).toBe("reinforced: we use pnpm");
  });
});
