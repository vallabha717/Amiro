"use client";

import { setAgentScope, useAgentScope } from "@/lib/backend/agent-scope";
import { useAgent } from "@/lib/backend/agents-api";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Button } from "ui/button";
import { AgentAvatar } from "./agent-avatar";
import { teamThreadPath } from "./team-paths";

/** The `?agent=` value already applied, so leaving a space is not undone. */
let appliedQuery: string | null = null;

/**
 * `?agent=<id>` opens that agent's space: the whole Amiro app acting as that
 * agent. Set during render so the page's very first requests already carry
 * the agent. A value is applied once, so "Switch to Amiro" on the same URL
 * is not undone.
 */
function ScopeFromQuery() {
  const agent = useSearchParams().get("agent");
  if (agent !== appliedQuery) {
    appliedQuery = agent;
    if (agent) setAgentScope(agent);
  }
  return null;
}

function SpaceBar({ agentId }: { agentId: string }) {
  const t = useTranslations("Team");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: agent, error } = useAgent(agentId);

  // Every page of an agent's space names the agent in its URL, so the address
  // always says whose space it is (and can be shared or reloaded as such).
  const shownAgent = searchParams.get("agent");
  useEffect(() => {
    if (shownAgent === agentId) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", agentId);
    appliedQuery = agentId;
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [shownAgent, agentId, pathname, searchParams, router]);
  if (error) {
    // The agent is gone (deleted elsewhere): stop acting as it.
    setAgentScope(null);
    return null;
  }
  if (!agent) return null;
  return (
    <div
      role="status"
      data-testid="agent-scope-banner"
      className="flex flex-wrap items-center gap-3 border-b bg-accent/60 px-4 py-2 text-sm"
    >
      <AgentAvatar agent={agent} size={24} />
      <span className="min-w-0 flex-1">{t("spaceBanner", { name: agent.name })}</span>
      <Button asChild size="sm" variant="outline" className="bg-background" data-testid="agent-scope-back">
        <Link href={teamThreadPath(agent.id)}>{t("backToTeam")}</Link>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAgentScope(null);
          router.push("/");
        }}
        data-testid="agent-scope-clear"
      >
        {t("switchToAmiro")}
      </Button>
    </div>
  );
}

/** Says, on every page of the app, whose space it is when it is not Amiro's. */
export function AgentScopeBanner() {
  const scope = useAgentScope();
  return (
    <>
      <Suspense fallback={null}>
        <ScopeFromQuery />
      </Suspense>
      {scope && (
        <Suspense fallback={null}>
          <SpaceBar agentId={scope} />
        </Suspense>
      )}
    </>
  );
}
