import { describe, expect, it } from "vitest";
import { DefaultToolName } from "./index";
import {
  editRowSummary,
  formatDuration,
  stepGroupLabel,
  stepKindOf,
  workLogHeader,
} from "./step-kind";

describe("stepKindOf", () => {
  it("groups the read-only file tools under one kind", () => {
    // The point of grouping: a reader scanning a finished run does not care
    // whether the agent used read_file or grep until they expand the row.
    const kinds = [
      DefaultToolName.ReadFile,
      DefaultToolName.ListDir,
      DefaultToolName.Glob,
      DefaultToolName.Grep,
    ].map(stepKindOf);
    expect(new Set(kinds)).toEqual(new Set(["explore"]));
  });

  it("keeps mutating tools in their own kind, away from reads", () => {
    for (const t of [
      DefaultToolName.EditFile,
      DefaultToolName.MultiEdit,
      DefaultToolName.WriteFile,
    ]) {
      expect(stepKindOf(t)).toBe("edit");
    }
    expect(stepKindOf(DefaultToolName.ReadFile)).not.toBe("edit");
  });

  it("falls back to 'other' for unknown and MCP tool names", () => {
    expect(stepKindOf("some-mcp-server__do_thing")).toBe("other");
    expect(stepKindOf(undefined)).toBe("other");
  });
});

describe("stepGroupLabel", () => {
  it("switches tense on whether the group is still running", () => {
    expect(stepGroupLabel("explore", 3, true)).toBe("Exploring 3 files");
    expect(stepGroupLabel("explore", 3, false)).toBe("Explored 3 files");
  });

  it("singularizes", () => {
    expect(stepGroupLabel("command", 1, false)).toBe("Ran 1 command");
    expect(stepGroupLabel("command", 2, false)).toBe("Ran 2 commands");
    expect(stepGroupLabel("edit", 1, false)).toBe("Edited 1 file");
  });
});

describe("formatDuration", () => {
  it("reads as a duration a person would say out loud", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_600_000)).toBe("60m");
  });

  it("never renders a negative duration from clock skew", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("workLogHeader", () => {
  it("reports the measured duration once the turn is done", () => {
    expect(
      workLogHeader({ isRunning: false, elapsedMs: 72_000, stepCount: 9 }),
    ).toBe("Worked for 1m 12s");
  });

  it("counts a turn that really was instant as instant, not as unmeasured", () => {
    expect(
      workLogHeader({ isRunning: false, elapsedMs: 0, stepCount: 3 }),
    ).toBe("Worked for 0s");
  });

  // Messages written before the server reported a duration. Showing "0s"
  // here would state something false about a turn that may have taken
  // minutes; the step count answers a different question honestly.
  it("falls back to a step count when nothing measured the turn", () => {
    expect(workLogHeader({ isRunning: false, stepCount: 9 })).toBe(
      "Worked · 9 steps",
    );
    expect(
      workLogHeader({ isRunning: false, elapsedMs: null, stepCount: 1 }),
    ).toBe("Worked · 1 step");
  });

  it("counts up while the turn is still going", () => {
    expect(
      workLogHeader({ isRunning: true, elapsedMs: 4_200, stepCount: 2 }),
    ).toBe("Working… 4s");
  });
});

describe("editRowSummary", () => {
  it("names the file and its counts for an edit", () => {
    expect(
      editRowSummary(DefaultToolName.EditFile, {
        status: "success",
        output: {
          path: "backend-go/internal/ai/bifrost/client.go",
          added: 6,
          removed: 0,
        },
      }),
    ).toEqual({
      verb: "Edited",
      path: "backend-go/internal/ai/bifrost/client.go",
      name: "client.go",
      added: 6,
      removed: 0,
    });
  });

  // "+0 −0" mid-flight reads as an edit that did nothing, which is a much
  // more alarming thing than an edit that has not finished.
  it("omits the counts while the edit is still running", () => {
    const row = editRowSummary(DefaultToolName.EditFile, {
      status: "pending",
      input: { path: "src/app.ts" },
    });
    expect(row).toMatchObject({ verb: "Editing", name: "app.ts" });
    expect(row?.added).toBeUndefined();
    expect(row?.removed).toBeUndefined();
  });

  it("distinguishes creating a file from rewriting one", () => {
    expect(
      editRowSummary(DefaultToolName.WriteFile, {
        status: "success",
        output: { path: "docs/notes.md", created: true, lines: 35 },
      }),
    ).toMatchObject({ verb: "Created", added: 35, removed: 0 });

    // An overwrite never computed a removed count, and "−0" would claim
    // nothing was lost.
    const rewrite = editRowSummary(DefaultToolName.WriteFile, {
      status: "success",
      output: { path: "docs/notes.md", created: false, lines: 35 },
    });
    expect(rewrite).toMatchObject({ verb: "Rewrote", added: 35 });
    expect(rewrite?.removed).toBeUndefined();
  });

  it("falls back to the input path before the result lands", () => {
    expect(
      editRowSummary(DefaultToolName.MultiEdit, {
        status: "pending",
        input: { path: "a/b/c/deep.go" },
      })?.name,
    ).toBe("deep.go");
  });

  // Reads stay a count -- "Explored 6 files" is a complete description of a
  // read, and naming each one would bury the writes among them.
  it("describes nothing for tools that are not writes", () => {
    expect(
      editRowSummary(DefaultToolName.ReadFile, {
        status: "success",
        output: { path: "src/app.ts" },
      }),
    ).toBeNull();
    expect(
      editRowSummary(DefaultToolName.RunShell, {
        status: "success",
        output: {},
      }),
    ).toBeNull();
  });

  it("describes nothing when there is no path to name", () => {
    expect(
      editRowSummary(DefaultToolName.EditFile, {
        status: "pending",
        input: {},
      }),
    ).toBeNull();
  });

  it("handles Jcode edit with old_string and new_string line derivation", () => {
    const summary = editRowSummary("edit", {
      status: "success",
      input: {
        file_path: "src/utils.ts",
        old_string: "line 1\nline 2",
        new_string: "line 1\nline 2 modified\nline 3",
      },
    });
    expect(summary).toEqual({
      verb: "Edited",
      path: "src/utils.ts",
      name: "utils.ts",
      added: 3,
      removed: 2,
    });
  });

  it("handles Jcode write with plain text output", () => {
    const created = editRowSummary("write", {
      status: "success",
      input: { file_path: "docs/readme.md", content: "hello\nworld" },
      output: "Created docs/readme.md (2 lines)",
    });
    expect(created).toEqual({
      verb: "Created",
      path: "docs/readme.md",
      name: "readme.md",
      added: 2,
      removed: 0,
    });

    const updated = editRowSummary("write", {
      status: "success",
      input: { file_path: "docs/readme.md", content: "new content" },
      output: "Updated docs/readme.md (1 lines)",
    });
    expect(updated).toEqual({
      verb: "Rewrote",
      path: "docs/readme.md",
      name: "readme.md",
      added: 1,
      removed: undefined,
    });
  });

  it("handles Jcode apply_patch with patch_text line counting and path extraction", () => {
    const patchText = `*** Update File: src/components/button.tsx
@@ -10,2 +10,3 @@
-old line
+new line 1
+new line 2`;
    const summary = editRowSummary("apply_patch", {
      status: "success",
      input: { patch_text: patchText },
    });
    expect(summary).toEqual({
      verb: "Patched",
      path: "src/components/button.tsx",
      name: "button.tsx",
      added: 2,
      removed: 1,
    });
  });

  it("handles Jcode replace tool", () => {
    const summary = editRowSummary("replace", {
      status: "success",
      input: {
        path: "src/theme.ts",
        pattern: "dark",
        replacement: "light\nmode",
      },
    });
    expect(summary).toEqual({
      verb: "Replaced",
      path: "src/theme.ts",
      name: "theme.ts",
      added: 2,
      removed: 1,
    });
  });
});

describe("Jcode runtime stepKindOf mappings", () => {
  it("maps exploration tools to explore", () => {
    expect(stepKindOf("read")).toBe("explore");
    expect(stepKindOf("ls")).toBe("explore");
    expect(stepKindOf("open")).toBe("explore");
    expect(stepKindOf("agentgrep", { mode: "grep" })).toBe("explore");
    expect(stepKindOf("agentgrep", { mode: "find" })).toBe("explore");
  });

  it("maps agentgrep outline or trace mode to orient", () => {
    expect(stepKindOf("agentgrep", { mode: "outline" })).toBe("orient");
    expect(stepKindOf("agentgrep", { mode: "trace" })).toBe("orient");
  });

  it("maps execution tools to command", () => {
    expect(stepKindOf("bash")).toBe("command");
    expect(stepKindOf("bg")).toBe("command");
    expect(stepKindOf("compile_remote")).toBe("command");
  });

  it("maps planning and delegation tools correctly", () => {
    expect(stepKindOf("todo")).toBe("plan");
    expect(stepKindOf("swarm")).toBe("delegate");
    expect(stepKindOf("batch")).toBe("delegate");
  });

  it("maps web and memory tools", () => {
    expect(stepKindOf("websearch")).toBe("search");
    expect(stepKindOf("webfetch")).toBe("search");
    expect(stepKindOf("browser")).toBe("search");
    expect(stepKindOf("memory")).toBe("remember");
    expect(stepKindOf("session_search")).toBe("orient");
    expect(stepKindOf("jcode_docs")).toBe("orient");
  });
});
