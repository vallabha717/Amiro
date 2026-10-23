import { JSONSchema7 } from "json-schema";
import { tool as createTool } from "ai";
import { jsonSchemaToZod } from "lib/json-schema-to-zod";

export const terminalExecutionSchema: JSONSchema7 = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The shell command to execute in the persistent terminal session.",
    },
    description: {
      type: "string",
      description: "Short human-readable summary of what the command does.",
    },
    timeout_seconds: {
      type: "number",
      description: "Max seconds to wait (default 120, max 600).",
    },
    run_in_background: {
      type: "boolean",
      description: "Run detached and return a task_id immediately.",
    },
  },
  required: ["command"],
};

export const terminalExecutionTool = createTool({
  description:
    "Execute shell commands in a persistent terminal session (cwd and env persist across calls). Use for running tools, builds, tests, git commands, or inspection.",
  inputSchema: jsonSchemaToZod(terminalExecutionSchema),
});
