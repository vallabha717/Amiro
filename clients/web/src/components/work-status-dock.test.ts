import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { summarizeWorkStatus } from "./work-status-dock";

const msg = (parts: unknown[], metadata?: unknown): UIMessage =>
  ({ id: "m", role: "assistant", parts, metadata }) as UIMessage;

describe("summarizeWorkStatus", () => {
  it("is null for a reply with no tool calls", () => {
    expect(summarizeWorkStatus(msg([{ type: "text", text: "hi" }]), false)).toBeNull();
  });

  it("counts steps and names the call in flight while running", () => {
    const status = summarizeWorkStatus(
      msg([
        {
          type: "tool-bash",
          toolCallId: "1",
          state: "input-available",
          input: { command: "echo hi", intent: "Say hi" },
        },
      ]),
      true,
    );
    expect(status?.steps).toBe(1);
    expect(status?.activeGlance).toBe("Say hi");
  });

  it("drops the active line once finished and carries the server duration", () => {
    const status = summarizeWorkStatus(
      msg(
        [
          {
            type: "tool-bash",
            toolCallId: "1",
            state: "output-available",
            input: { command: "echo hi" },
            output: { command: "echo hi", exit_code: 0, output: "hi" },
          },
        ],
        { durationMs: 4000 },
      ),
      false,
    );
    expect(status?.activeGlance).toBeNull();
    expect(status?.durationMs).toBe(4000);
    expect(status?.failed).toBe(false);
  });
});
