import { describe, expect, it } from "vitest";

import { DefaultToolName } from "lib/ai/tools";

import { toolPresenters } from "./index";

/**
 * Sandbox badge props for run_shell's Expanded view
 * (docs/coding-agent-parity/03-sandboxed-execution.md's honesty contract).
 *
 * These don't render into a DOM (no jsdom/testing-library in this repo's
 * test setup -- presenters.test.ts's own tests are all pure-function
 * assertions) -- instead they inspect the React element tree
 * runShell.Expanded returns, which is enough to prove the wiring: output's
 * sandboxed/sandbox_backend fields reach TerminalWindow's props unchanged.
 */
describe("run_shell Expanded sandbox props", () => {
  const runShell = toolPresenters[DefaultToolName.RunShell];

  it("passes sandboxed=true and the backend name through to TerminalWindow", () => {
    const el: any = runShell.Expanded!({
      input: { command: "go build ./..." },
      output: {
        command: "go build ./...",
        exit_code: 0,
        output: "",
        sandboxed: true,
        sandbox_backend: "bubblewrap",
      },
      status: "success",
    });
    const terminalWindowProps = el.props.children.props;
    expect(terminalWindowProps.sandboxed).toBe(true);
    expect(terminalWindowProps.sandboxBackend).toBe("bubblewrap");
  });

  it("passes sandboxed=false plainly -- not hidden or softened", () => {
    const el: any = runShell.Expanded!({
      input: { command: "echo hi" },
      output: {
        command: "echo hi",
        exit_code: 0,
        output: "hi",
        sandboxed: false,
        sandbox_backend: "none",
      },
      status: "success",
    });
    const terminalWindowProps = el.props.children.props;
    expect(terminalWindowProps.sandboxed).toBe(false);
    expect(terminalWindowProps.sandboxBackend).toBe("none");
  });

  it("leaves sandboxed undefined when output hasn't arrived yet (pending)", () => {
    const el: any = runShell.Expanded!({
      input: { command: "echo hi" },
      output: undefined,
      status: "pending",
    });
    const terminalWindowProps = el.props.children.props;
    expect(terminalWindowProps.sandboxed).toBeUndefined();
  });
});
