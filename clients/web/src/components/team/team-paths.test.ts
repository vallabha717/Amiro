import { describe, expect, it } from "vitest";
import {
  agentScopedPath,
  agentSpacePath,
  legacyAgentRedirect,
  matchSubPath,
  resolveAgentFromPathname,
  stripAgentPrefix,
  teamThreadPath,
} from "./team-paths";

describe("team paths", () => {
  it("opens an agent's Team thread beside the list", () => {
    expect(teamThreadPath("main")).toBe("/team?agent=main");
    expect(teamThreadPath("a&b")).toBe("/team?agent=a%26b");
  });

  it("opens the main agent's space as /amiro", () => {
    expect(agentSpacePath("main")).toBe("/amiro");
    expect(agentSpacePath("amiro")).toBe("/amiro");
    expect(agentSpacePath("")).toBe("/amiro");
  });

  it("opens a team agent's space as /<agentId>", () => {
    expect(agentSpacePath("abc")).toBe("/abc");
    expect(agentSpacePath("a&b")).toBe("/a%26b");
  });

  it("builds agentScopedPath for sub-routes", () => {
    expect(agentScopedPath(null, "/connectors")).toBe("/amiro/connectors");
    expect(agentScopedPath("main", "/agent")).toBe("/amiro/agent");
    expect(agentScopedPath("amiro", "/schedules")).toBe("/amiro/schedules");
    expect(agentScopedPath("abc", "/connectors")).toBe("/abc/connectors");
    expect(agentScopedPath("abc", "/agent/workspace")).toBe(
      "/abc/agent/workspace",
    );
    expect(agentScopedPath("abc", "/")).toBe("/abc");
    expect(agentScopedPath(null, "/")).toBe("/amiro");
  });

  it("strips agent prefix", () => {
    expect(stripAgentPrefix("/amiro")).toBe("/");
    expect(stripAgentPrefix("/amiro/connectors")).toBe("/connectors");
    expect(stripAgentPrefix("/abc/agent/personality")).toBe(
      "/agent/personality",
    );
    expect(stripAgentPrefix("/team")).toBe("/team");
    expect(stripAgentPrefix("/sign-in")).toBe("/sign-in");
    expect(stripAgentPrefix("/admin/providers")).toBe("/admin/providers");
  });

  it("matches sub-paths correctly", () => {
    expect(matchSubPath("/amiro/connectors", "/connectors")).toBe(true);
    expect(matchSubPath("/abc/connectors", "/connectors")).toBe(true);
    expect(matchSubPath("/amiro/agent/personality", "/agent/personality")).toBe(
      true,
    );
    expect(matchSubPath("/amiro/agent/personality", "/agent")).toBe(true);
    expect(matchSubPath("/amiro", "/")).toBe(true);
    expect(matchSubPath("/team", "/team")).toBe(true);
  });

  it("resolves agent from pathname", () => {
    expect(resolveAgentFromPathname("/amiro")).toBeNull();
    expect(resolveAgentFromPathname("/amiro/connectors")).toBeNull();
    expect(resolveAgentFromPathname("/team")).toBeNull();
    expect(resolveAgentFromPathname("/setup")).toBeNull();
    expect(resolveAgentFromPathname("/agent")).toBeNull();
    expect(resolveAgentFromPathname("/admin/providers")).toBeNull();
    expect(resolveAgentFromPathname("/connectors")).toBeNull();
    expect(resolveAgentFromPathname("/coder-1")).toBe("coder-1");
    expect(resolveAgentFromPathname("/coder-1/connectors")).toBe("coder-1");
  });

  it("moves / and legacy chat paths into the agent's space", () => {
    expect(legacyAgentRedirect("/", "", null)).toBe("/amiro");
    expect(legacyAgentRedirect("/", "thread=1", "abc")).toBe("/abc?thread=1");
    expect(legacyAgentRedirect("/admin/providers", "", null)).toBe(
      "/amiro/admin/providers",
    );
    expect(legacyAgentRedirect("/admin/providers/test", "", "abc")).toBe(
      "/abc/admin/providers/test",
    );
    expect(legacyAgentRedirect("/connectors", "agent=xyz&tab=a", null)).toBe(
      "/xyz/connectors?tab=a",
    );
  });

  it("never redirects an agent-scoped or non-chat path", () => {
    expect(legacyAgentRedirect("/amiro", "", null)).toBeNull();
    expect(legacyAgentRedirect("/amiro/admin/providers", "", null)).toBeNull();
    expect(legacyAgentRedirect("/abc/admin/providers", "", null)).toBeNull();
    expect(legacyAgentRedirect("/team", "agent=abc", null)).toBeNull();
    expect(legacyAgentRedirect("/sign-in", "", null)).toBeNull();
  });
});
