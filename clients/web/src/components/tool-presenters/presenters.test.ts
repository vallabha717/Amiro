import { DefaultToolName } from "lib/ai/tools";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getToolPresenter,
  presenterPropsFromToolPart,
  statusFromToolPart,
  toolGlance,
  toolPresenters,
} from "./index";
import {
  WebSearchGlanceRow,
  WebSearchSourceChip,
} from "./jcode-presenters";

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
  DefaultToolName.CreatePR,
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

  // Phase 3 (docs/coding-agent-parity/): push and create_pr are the two
  // AlwaysAsk operations, and a force push in particular must never read
  // like an ordinary push at a glance.
  it("git push flags force distinctly from an ordinary push", () => {
    expect(
      toolGlance(DefaultToolName.Git, {
        input: { subcommand: "push" },
        output: { subcommand: "push", command: "git push origin feature-x", exit_code: 0 },
        status: "success",
      }),
    ).toBe("git push");

    expect(
      toolGlance(DefaultToolName.Git, {
        input: { subcommand: "push", force: true },
        output: { subcommand: "push", command: "git push origin feature-x --force", exit_code: 0 },
        status: "success",
      }),
    ).toBe("git push --force");
  });

  it("git push Compact renders a force badge only when force is set", () => {
    const compact = getToolPresenter(DefaultToolName.Git)!.Compact!;
    const forced: any = compact({
      input: { subcommand: "push", force: true },
      output: { subcommand: "push", command: "git push origin feature-x --force", exit_code: 0 },
      status: "success",
    });
    expect(JSON.stringify(forced)).toContain("force");

    const plain: any = compact({
      input: { subcommand: "push" },
      output: { subcommand: "push", command: "git push origin feature-x", exit_code: 0 },
      status: "success",
    });
    // The badge text itself must not appear for an ordinary push.
    const plainChildren = JSON.stringify(plain);
    expect(plainChildren.includes('"force"') && plainChildren.includes("bg-destructive")).toBe(
      false,
    );
  });

  it("create_pr names the target branch, and the PR number once opened", () => {
    expect(
      toolGlance(DefaultToolName.CreatePR, {
        input: { base: "main" },
        output: undefined,
        status: "pending",
      }),
    ).toBe("opening a pull request…");

    expect(
      toolGlance(DefaultToolName.CreatePR, {
        input: { base: "main" },
        output: { base: "main", head: "feature-x", number: 42, url: "https://github.com/acme/widgets/pull/42" },
        status: "success",
      }),
    ).toBe("PR #42 → main");
  });

  it("create_pr Compact shows head → base and the walkthrough-derived title", () => {
    const compact = getToolPresenter(DefaultToolName.CreatePR)!.Compact!;
    const el: any = compact({
      input: { base: "main" },
      output: {
        owner: "acme",
        repo: "widgets",
        head: "feature-x",
        base: "main",
        title: "Add the widget exporter",
        body: "Add the widget exporter\n\n## Changes\n- `exporter.go` -- the new exporter",
      },
      status: "success",
    });
    const rendered = JSON.stringify(el);
    expect(rendered).toContain("feature-x");
    expect(rendered).toContain("main");
    expect(rendered).toContain("Add the widget exporter");
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

describe("namespaced agent-bridge tools resolve to their card", () => {
  // Bare amiro_<tool> ids (older surfaces) resolve straight to the presenter.
  it("amiro_artifact_create renders the same presenter as artifact_create", () => {
    expect(getToolPresenter("amiro_artifact_create")).toBe(
      getToolPresenter("artifact_create"),
    );
    expect(getToolPresenter("amiro_artifact_create")).toBeDefined();
  });

  it("never strips another server or a local tool", () => {
    expect(getToolPresenter("other_artifact_create")).toBeUndefined();
    // propose_plan must not resolve through plan.
    expect(getToolPresenter("propose_plan")).toBe(
      toolPresenters["propose_plan"],
    );
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

/* ------------------------------------------------------------------ */
/* Rich web search cards                                              */
/* ------------------------------------------------------------------ */

const searchOutput = (count: number): string =>
  [
    "Search provider: Bing Search (bing)",
    "Search results for: rust async runtime",
    "",
    ...Array.from({ length: count }, (_, i) =>
      [
        `${i + 1}. **Result ${i + 1}**`,
        `   https://site${i + 1}.example.com/page`,
        `   Snippet number ${i + 1}.`,
      ].join("\n"),
    ),
  ].join("\n");

const renderSearchExpanded = (output: unknown, inputQuery = "rust async runtime") => {
  const Expanded = toolPresenters.websearch.Expanded!;
  return renderToStaticMarkup(
    createElement(Expanded, {
      input: { query: inputQuery },
      output,
      status: "success",
    }),
  );
};

describe("websearch rich card", () => {
  it("renders the header, query, provider, source count and timing", () => {
    const raw = `[tool timing: start=2026-10-18T07:46:43.641Z finish=2026-10-18T07:46:50.635Z duration=6.4s] \n${searchOutput(2)}`;
    const html = renderSearchExpanded(raw);

    expect(html).toContain("Web search");
    expect(html).toContain("rust async runtime");
    expect(html).toContain("Bing Search");
    expect(html).toContain("2 sources");
    expect(html).toContain("6.4s");
  });

  it("renders the query as the title and a ranked result list", () => {
    const html = renderSearchExpanded(searchOutput(3));

    expect(html).toContain("“rust async runtime”");
    // The list is the one view of the results; no duplicate chip strip.
    expect(html).not.toContain('data-testid="websearch-source-chip"');
    expect(html.split('data-testid="websearch-result-row"').length - 1).toBe(3);
    expect(html).toContain("site1.example.com");
    expect(html).toContain("Snippet number 1.");
    // Links are real, new-tab, referrer-safe anchors.
    expect(html).toContain('href="https://site1.example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // Favicons come from the shared Google favicon service.
    expect(html).toContain("google.com/s2/favicons");
  });

  it("shows only four rows by default with an all-results toggle", () => {
    const html = renderSearchExpanded(searchOutput(6));
    const rows = html.split('data-testid="websearch-result-row"').length - 1;
    expect(rows).toBe(4);
    expect(html).toContain('data-testid="websearch-toggle-all"');
    expect(html).toContain("Show all 6 results");
  });

  it("renders a pending shimmer while the search is running", () => {
    const Expanded = toolPresenters.websearch.Expanded!;
    const html = renderToStaticMarkup(
      createElement(Expanded, {
        input: { query: "rust async runtime" },
        output: undefined,
        status: "pending",
      }),
    );
    expect(html).toContain('data-testid="websearch-pending"');
    expect(html).toContain("Searching the web");
    expect(html).toContain("animate-pulse");
  });

  it("keeps the raw output behind a collapsible escape hatch", () => {
    const html = renderSearchExpanded(searchOutput(1));
    expect(html).toContain('data-testid="websearch-toggle-raw"');
    expect(html).toContain("Raw output");
  });

  it("shows a clean notice with the raw text when nothing parses", () => {
    const Expanded = toolPresenters.websearch.Expanded!;
    const html = renderToStaticMarkup(
      createElement(Expanded, {
        input: { query: "nothing" },
        output: "No results found for: nothing",
        status: "success",
      }),
    );
    expect(html).toContain("No results found");
  });

  it("never turns a non-http url into a link", () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchSourceChip, {
        hit: {
          rank: 1,
          title: "evil",
          url: "javascript:alert(1)",
          domain: "",
          faviconUrl: "",
        },
      }),
    );
    expect(html).not.toContain("href=");
  });
});

describe("webfetch rich card", () => {
  it("renders the fetched page card with url, host and byte count", () => {
    const Expanded = toolPresenters.webfetch.Expanded!;
    const html = renderToStaticMarkup(
      createElement(Expanded, {
        input: { url: "https://example.com/docs" },
        output: "Fetched https://example.com/docs (2048 bytes)\n\n# Docs\n\nBody text.",
        status: "success",
      }),
    );

    expect(html).toContain('data-testid="webfetch-source-card"');
    expect(html).toContain("Fetch URL");
    expect(html).toContain("https://example.com/docs");
    expect(html).toContain("example.com");
    expect(html).toContain('data-testid="webfetch-byte-count"');
    expect(html).toContain("2.0 KB");
    expect(html).toContain("Body text.");
  });
});

describe("work log web glance rows", () => {
  it("shows the query and favicon chips for a finished search", () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchGlanceRow, {
        toolName: "websearch",
        input: { query: "rust async runtime" },
        output: searchOutput(6),
        status: "success",
      }),
    );
    // The pill above the row names the query; the row is the sources.
    expect(html).not.toContain("rust async runtime");
    expect(html.split('data-testid="worklog-websearch-chip"').length - 1).toBe(4);
    expect(html).toContain("+2 more");
  });

  it("shows what is being fetched", () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchGlanceRow, {
        toolName: "webfetch",
        input: { url: "https://example.com/docs" },
        output: undefined,
        status: "pending",
      }),
    );
    expect(html).toContain("Reading…");
    expect(html).toContain('data-testid="worklog-webfetch-chip"');
    expect(html).toContain("example.com");
  });
});

describe("inline bash and file edit expanded presenters", () => {
  it("renders bash output inline when expanded (not auto-collapsed)", () => {
    const Expanded = toolPresenters.bash.Expanded!;
    const html = renderToStaticMarkup(
      createElement(Expanded, {
        input: { command: "echo inline-bash-ok", intent: "Run echo check" },
        output: {
          command: "echo inline-bash-ok",
          exit_code: 0,
          output: "inline-bash-ok\n",
        },
        status: "success",
      }),
    );
    expect(html).toContain("echo inline-bash-ok");
    expect(html).toContain("inline-bash-ok");
  });

  it("renders file edit diff inline when expanded in chat surface", () => {
    const Expanded = toolPresenters.edit.Expanded!;
    const html = renderToStaticMarkup(
      createElement(Expanded, {
        input: {
          file_path: "src/example.ts",
          old_string: "const oldVal = 1;",
          new_string: "const newVal = 2;",
          intent: "Rename variable",
        },
        output: "Edited src/example.ts",
        status: "success",
      }),
    );
    expect(html).toContain("example.ts");
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).toContain("oldVal = 1");
    expect(html).toContain("newVal = 2");
  });
});

describe("batch tool calls", () => {
  it("lists each parallel call with its own tool name and description", () => {
    const Expanded = toolPresenters.batch.Expanded!;
    const html = renderToStaticMarkup(
      createElement(Expanded, {
        input: {
          tool_calls: [
            { tool: "read", file_path: "a.ts", intent: "Read a" },
            { tool: "bash", command: "ls" },
          ],
        },
        output: undefined,
        status: "pending",
      }),
    );
    expect(html).toContain('data-testid="batch-calls"');
    expect(html.split('data-testid="batch-call"').length - 1).toBe(2);
    expect(html).toContain("Read a");
    expect(html).toContain("bash");
  });

  it("names the tools in the one-line glance", () => {
    expect(
      toolGlance("batch", {
        input: { tool_calls: [{ tool: "read" }, { tool: "grep" }] },
        output: undefined,
        status: "pending",
      }),
    ).toContain("2 calls in parallel · read, grep");
  });
});
