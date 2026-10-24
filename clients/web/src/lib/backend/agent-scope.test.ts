import { afterEach, describe, expect, it } from "vitest";
import { agentScopeHeaders, getAgentScope, setAgentScope } from "./agent-scope";

describe("agent scope", () => {
  afterEach(() => setAgentScope(null));

  it("sends no header for the main agent", () => {
    setAgentScope("main");
    expect(getAgentScope()).toBeNull();
    expect(agentScopeHeaders()).toEqual({});
  });

  it("names the team agent on every request", () => {
    setAgentScope("0123456789abcdef0123456789abcdef");
    expect(agentScopeHeaders()).toEqual({
      "X-Amiro-Agent": "0123456789abcdef0123456789abcdef",
    });
  });

  it("clears back to the main agent", () => {
    setAgentScope("abc");
    setAgentScope(null);
    expect(agentScopeHeaders()).toEqual({});
  });
});
