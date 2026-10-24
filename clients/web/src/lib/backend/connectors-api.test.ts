import { describe, expect, it } from "vitest";
import {
  connectorSlug,
  parseConnectorSetup,
  secretLabel,
  splitCommandLine,
} from "./connectors-api";

describe("connectors-api helpers", () => {
  it("slugs names like the backend and runtime", () => {
    expect(connectorSlug("  My Linear Server! ")).toBe("my-linear-server");
    expect(connectorSlug("GitHub_MCP")).toBe("github-mcp");
    expect(connectorSlug("a".repeat(60))).toHaveLength(40);
  });

  it("splits a command line, honouring quotes", () => {
    expect(splitCommandLine('npx -y @scope/server --dir "/tmp/my dir"')).toEqual({
      command: "npx",
      args: ["-y", "@scope/server", "--dir", "/tmp/my dir"],
    });
    expect(splitCommandLine("")).toEqual({ command: "", args: [] });
  });

  it("labels secrets by header or env name", () => {
    expect(
      secretLabel({ field: "authorization", envVar: "X", location: "header:Authorization", present: false }),
    ).toBe("Authorization");
    expect(secretLabel({ field: "token", envVar: "X", location: "arg", present: false })).toBe("token");
  });

  it("parses the runtime's CONNECTOR_SETUP marker from plain and stringified output", () => {
    const text =
      'Saved linear to mcp.json.\nWaiting for the user...\nCONNECTOR_SETUP {"server":"linear","missingSecrets":["authorization"]}';
    expect(parseConnectorSetup(text)).toEqual({ server: "linear", missingSecrets: ["authorization"] });
    expect(parseConnectorSetup({ output: text })).toEqual({
      server: "linear",
      missingSecrets: ["authorization"],
    });
    expect(parseConnectorSetup("connected 3 tools")).toBeNull();
    expect(parseConnectorSetup('CONNECTOR_SETUP {"server":"x","missingSecrets":[]} trailing')).toEqual({
      server: "x",
      missingSecrets: [],
    });
  });
});
